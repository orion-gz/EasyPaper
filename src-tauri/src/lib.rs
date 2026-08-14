use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::Manager;

/// CreateProcess에 이 플래그를 주지 않으면, PyInstaller onedir sidecar는
/// 콘솔 서브시스템 실행파일이라 Windows가 새 콘솔 창을 띄워준다. Tauri
/// 앱(윈도우 서브시스템, 콘솔 없음)이 부모라 자기 콘솔을 물려줄 수 없기
/// 때문이다. 그 창은 sidecar 프로세스 자신의 콘솔이라, 사용자가 그 창을
/// 닫으면(X 버튼) 콘솔 종료 이벤트가 발생해 sidecar 프로세스 자체가 함께
/// 죽어버린다. stdout/stderr는 Stdio::piped()로 파이프에 리다이렉트되므로
/// 콘솔 창 자체를 아예 안 만들어도(CREATE_NO_WINDOW) 로그 캡처에는 영향이
/// 없다. PyInstaller를 windowed(--noconsole)로 다시 빌드하는 대신 이 방식을
/// 쓰는 이유: PyInstaller의 windowed 모드는 버전에 따라 sys.stdout/stderr가
/// None이 되어 print()가 있는 코드가 죽는 경우가 있어(콘솔이 아예 없다고
/// 가정), 콘솔 서브시스템은 그대로 두고 창만 숨기는 편이 더 안전하다.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// 스폰된 백엔드 sidecar의 자식 프로세스 핸들. 창 종료/앱 종료 시 확실히
/// kill하기 위해 앱 상태로 보관한다(고아 프로세스 방지, 계획 Phase 3).
struct SidecarState(Mutex<Option<Child>>);

/// 선호 포트(8000)를 우선 시도하고, 이미 사용 중이면(기존 웹 배포판이 로컬에
/// 동시 실행 중인 경우 등) OS가 골라주는 임시 포트로 폴백한다(계획 Phase 2).
fn find_available_port(preferred: u16) -> u16 {
    if TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return preferred;
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("failed to bind ephemeral port");
    listener.local_addr().unwrap().port()
}

/// macOS(Finder/Dock에서 더블클릭)나 Linux 데스크탑 런처로 실행된 GUI 앱은
/// launchd/데스크탑 환경이 주는 최소한의 기본 PATH만 물려받고, 사용자의
/// 로그인 셸(.zshrc/.bash_profile 등)이 추가하는 PATH는 전혀 보지 못한다.
/// curl 설치 스크립트로 설치되는 Antigravity/Claude Code/Codex CLI는 보통
/// 그 rc 파일에서 PATH에 추가된 디렉토리(~/.local/bin 등)에 들어가므로,
/// 이 상태로 sidecar를 띄우면 shutil.which() 기반 탐지가 전부 실패해
/// "설치 안 됨"으로 오판한다(실제로 macOS 빌드에서 재현됨). 로그인 셸을
/// 인터랙티브(-i)+로그인(-l) 모드로 짧게 실행해 그 PATH를 그대로 얻어와
/// sidecar에 물려준다. Windows는 GUI 앱도 시스템 PATH 환경변수를 동일하게
/// 받으므로 이 문제가 없어 대상에서 제외한다.
fn resolve_user_shell_path() -> Option<String> {
    if cfg!(windows) {
        return None;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut child = Command::new(&shell)
        .args(["-ilc", "echo -n \"__EASYPAPER_PATH__$PATH\""])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .ok()?;

    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        let _ = tx.send(buf);
    });

    // 사용자 셸 초기화 스크립트가 무겁거나(예: nvm) 잘못 걸려 있어도
    // 앱 시작이 무한정 멈추지 않도록 타임아웃을 둔다 - 실패하면 그냥 PATH
    // 보강 없이 진행(기존처럼 configured 경로/PATH 탐색만 사용).
    let output = rx.recv_timeout(Duration::from_secs(5)).ok();
    let _ = child.kill();
    let _ = child.wait();

    let output = output?;
    let marker = "__EASYPAPER_PATH__";
    let idx = output.rfind(marker)?;
    let path = output[idx + marker.len()..].trim();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

/// 백엔드의 루트(`/`)에 재시도 GET을 보내 준비 상태를 확인한다. `/api/*`는
/// 전역 인증이 걸려 있어 로그인 전 판별에 쓸 수 없지만, 루트는 인증 없이
/// 200을 반환하며 기존 Dockerfile의 HEALTHCHECK도 동일하게 `/`를 쓴다.
fn wait_for_backend(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
            let request =
                format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
            if stream.write_all(request.as_bytes()).is_ok() {
                let mut buf = [0u8; 32];
                if let Ok(n) = stream.read(&mut buf) {
                    if n > 0 {
                        let text = String::from_utf8_lossy(&buf[..n]);
                        if text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200") {
                            return true;
                        }
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// 백엔드 sidecar 실행파일 경로를 계산한다.
///
/// PyInstaller onedir 산출물은 실행파일 하나가 아니라 지원 파일(_internal/)이
/// 딸린 디렉토리라 Tauri의 externalBin(sidecar) 규칙(단일 파일, "<name>-
/// <target-triple>" 명명)에 맞지 않는다. 그래서 tauri.conf.json의
/// bundle.resources로 디렉토리 전체를 번들에 포함시키고 여기서 직접 경로를
/// 계산해 std::process::Command로 실행한다. 개발 모드(`tauri dev`)에서는
/// 번들 리소스가 아직 복사되지 않으므로 컴파일 시점의 CARGO_MANIFEST_DIR
/// 기준 src-tauri/binaries/를 그대로 사용한다.
fn backend_binary_path(app: &tauri::AppHandle) -> PathBuf {
    let exe_name = if cfg!(windows) {
        "easypaper-backend.exe"
    } else {
        "easypaper-backend"
    };
    let base = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries")
    } else {
        app.path()
            .resource_dir()
            .unwrap_or_else(|e| die("백엔드 리소스 디렉토리를 찾을 수 없습니다", e))
            .join("binaries")
    };
    base.join("easypaper-backend").join(exe_name)
}

fn kill_sidecar(state: &tauri::State<SidecarState>) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// 프론트엔드가 Tauri updater로 새 버전을 다운로드·설치하기 직전에 호출한다.
/// PyInstaller onedir sidecar가 계속 떠 있으면 자신이 로드한 DLL(예:
/// MSVCP140.dll)을 OS 레벨에서 잠그고 있어서, Windows 설치 프로그램이 같은
/// 경로에 새 버전 파일을 덮어쓰지 못하고 "Error opening file for writing"
/// 오류로 멈춘다 - 자동 업데이트로 설치를 시작하기 전에 sidecar를 먼저
/// 종료해 파일 잠금을 풀어줘야 한다.
#[tauri::command]
fn kill_backend_sidecar(state: tauri::State<SidecarState>) {
    log::info!("update install requested, killing sidecar to release locked files");
    kill_sidecar(&state);
}

/// 앱 시작에 필요한 필수 자원(리소스 디렉토리, sidecar 프로세스 등)을 얻지
/// 못했을 때 쓴다. 이런 실패는 대부분 백신이 sidecar 바이너리를 격리했거나
/// 디스크 권한 문제처럼 사용자가 직접 손댈 수 없는 환경 문제라 복구를
/// 시도할 수 없다 - 이전에는 `.expect(...)`로 그냥 패닉시켜서, GUI로 띄운
/// 앱(콘솔이 안 보임)에서는 사용자에게 아무 설명 없이 창만 사라지고
/// 끝났다. 최소한 stderr/로그에는 원인이 남도록 정리된 메시지를 남기고
/// 명시적으로 종료한다(패닉 언와인딩의 백트레이스 잡음도 피한다).
fn die(context: &str, err: impl std::fmt::Display) -> ! {
    eprintln!("[EasyPaper] 치명적 오류: {context}: {err}");
    log::error!("fatal startup error - {context}: {err}");
    std::process::exit(1);
}

fn die_msg(context: &str) -> ! {
    eprintln!("[EasyPaper] 치명적 오류: {context}");
    log::error!("fatal startup error - {context}");
    std::process::exit(1);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(SidecarState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![kill_backend_sidecar])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let app_handle = app.handle().clone();

            // 데스크탑 자체 업데이트 확인/다운로드/설치는 프론트엔드(main.js의
            // checkTauriUpdate/installTauriUpdate)가 @tauri-apps/plugin-updater로
            // 직접 수행한다 - 로그인 직후 조용히 확인하고, 정보 탭에서 사용자가
            // 수동으로도 확인/설치할 수 있다. 여기 setup()에서 별도로 check()를
            // 또 호출하면 앱 실행마다 업데이트 서버에 중복 요청만 나갈 뿐 결과를
            // 사용자에게 보여줄 방법이 없어(로그로만 남음) 의미가 없으므로 두지
            // 않는다.

            let app_data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|e| die("앱 데이터 디렉토리를 찾을 수 없습니다", e));
            let uploads_dir = app_data_dir.join("uploads");
            let cache_dir = app_data_dir.join("cache");
            let library_dir = app_data_dir.join("library");
            let logs_dir = app_data_dir.join("logs");
            for dir in [&app_data_dir, &uploads_dir, &cache_dir, &library_dir, &logs_dir] {
                if let Err(e) = std::fs::create_dir_all(dir) {
                    die(&format!("앱 데이터 하위 디렉토리를 만들 수 없습니다 ({dir:?})"), e);
                }
            }
            let db_path = app_data_dir.join("easypaper.db");

            let binary = backend_binary_path(&app_handle);
            // PyInstaller onedir 산출물은 frontend/dist를 _internal/frontend/dist에
            // 담고 있다(빌드 산출물이 onedir 최상위 밖의 경로를 datas 목적지로
            // 쓸 수 없어서). backend/main.py의 EASYPAPER_FRONTEND_DIST env var로
            // 실제 위치를 알려준다.
            let frontend_dist = binary
                .parent()
                .unwrap_or_else(|| die_msg("sidecar 바이너리 경로에 상위 디렉토리가 없습니다"))
                .join("_internal")
                .join("frontend")
                .join("dist");

            let mut command = Command::new(&binary);
            command
                .env("APP_HOST", "127.0.0.1")
                .env("EASYPAPER_CONFIG_DIR", &app_data_dir)
                .env("EASYPAPER_DESKTOP", "1")
                .env("DB_PATH", &db_path)
                .env("UPLOAD_DIR", &uploads_dir)
                .env("CACHE_DIR", &cache_dir)
                .env("LIBRARY_DIR", &library_dir)
                .env("EASYPAPER_LOG_DIR", &logs_dir)
                .env("EASYPAPER_FRONTEND_DIST", &frontend_dist)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            // curl로 설치된 CLI(agy/claude/codex)가 사용자 로그인 셸에서만
            // PATH에 잡혀 있는 macOS/Linux 환경 대응 - 위 resolve_user_shell_path
            // 참고. 사용자 로그인 셸을 띄워 PATH를 얻어오는 데 최대 5초까지 걸릴
            // 수 있으므로(resolve_user_shell_path의 타임아웃), 포트는 반드시 이
            // 호출이 끝난 뒤 spawn 직전에 골라야 한다 - 미리 골라두면 "포트가
            // 비어있음을 확인"한 시점과 "실제로 그 포트를 sidecar가 bind"하는
            // 시점 사이의 창(TOCTOU)이 최대 5초까지 벌어져, 그 사이 다른 로컬
            // 프로세스(예: 동시에 뜬 앱의 두 번째 인스턴스)가 같은 포트를
            // 선점할 여지가 커진다.
            if let Some(shell_path) = resolve_user_shell_path() {
                let current_path = std::env::var("PATH").unwrap_or_default();
                log::info!("enriched sidecar PATH with login shell PATH");
                command.env("PATH", format!("{}:{}", shell_path, current_path));
            }

            #[cfg(windows)]
            command.creation_flags(CREATE_NO_WINDOW);

            // 포트 선택은 spawn 바로 직전에: 위 주석 참고 (TOCTOU 창 최소화).
            // 완전히 없앨 수는 없다(포트가 비어있음을 확인한 시점과 sidecar가
            // 실제로 bind하는 시점 사이에는 항상 미세한 창이 남는다) - 실패하면
            // wait_for_backend()의 헬스체크 타임아웃으로 감지되어 아래에서
            // 에러 로그로 남는다.
            let port = find_available_port(8000);
            command.env("APP_PORT", port.to_string());
            log::info!("spawning backend sidecar: {:?} on port {}", binary, port);

            let mut child = command
                .spawn()
                .unwrap_or_else(|e| die("백엔드 sidecar 프로세스를 실행할 수 없습니다", e));

            // 디버깅 편의를 위해 sidecar의 stdout/stderr을 그대로 로그로 흘려보낸다.
            // tauri_plugin_log는 디버그 빌드에서만 설치되므로(위 참고), 릴리스
            // 빌드에서는 별도 로거가 없어 이 log:: 호출들이 실제로는 아무 데도
            // 쓰이지 않는다 - 별도 볼륨 조정이 필요 없다.
            if let Some(stdout) = child.stdout.take() {
                std::thread::spawn(move || {
                    use std::io::BufRead;
                    for line in std::io::BufReader::new(stdout).lines().flatten() {
                        log::info!("[sidecar] {}", line);
                    }
                });
            }
            if let Some(stderr) = child.stderr.take() {
                std::thread::spawn(move || {
                    use std::io::BufRead;
                    for line in std::io::BufReader::new(stderr).lines().flatten() {
                        log::warn!("[sidecar] {}", line);
                    }
                });
            }

            app.state::<SidecarState>().0.lock().unwrap().replace(child);

            // WindowEvent::CloseRequested/RunEvent::Exit는 GTK/winit 이벤트 루프를
            // 통해서만 발생하고, `kill <pid>`나 시스템 종료가 보내는 SIGTERM은
            // 그 루프를 거치지 않아 두 핸들러 모두 호출되지 않는다(실제로
            // `pkill -f target/debug/app`로 검증됨 - sidecar가 고아로 남았다).
            // 이 경로까지 커버하기 위해 SIGTERM/SIGINT 핸들러를 별도로 등록한다.
            let app_handle_for_signal = app.handle().clone();
            let _ = ctrlc::set_handler(move || {
                log::warn!("received termination signal, killing sidecar");
                kill_sidecar(&app_handle_for_signal.state::<SidecarState>());
                std::process::exit(0);
            });

            let window = app
                .get_webview_window("main")
                .unwrap_or_else(|| die_msg("main 윈도우를 찾을 수 없습니다"));
            std::thread::spawn(move || {
                if wait_for_backend(port, Duration::from_secs(15)) {
                    let url = format!("http://127.0.0.1:{port}/");
                    log::info!("backend ready, navigating window to {}", url);
                    if let Err(e) = window.navigate(url.parse().expect("invalid url")) {
                        log::error!("failed to navigate window: {}", e);
                    }
                } else {
                    log::error!("backend healthcheck did not succeed within timeout");
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Windows에서 X 버튼으로 강제 종료해도 sidecar가 고아 프로세스로
            // 남지 않도록, 창이 실제로 닫히기 전에 명시적으로 kill한다.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                log::info!("window close requested, killing sidecar");
                kill_sidecar(&window.state::<SidecarState>());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 창 이벤트를 놓치는 경로(OS 로그아웃/시스템 종료 시그널 등) 대비
            // 앱 종료 시에도 한 번 더 kill을 시도한다.
            if let tauri::RunEvent::Exit = event {
                log::info!("app exiting, ensuring sidecar is killed");
                kill_sidecar(&app_handle.state::<SidecarState>());
            }
        });
}
