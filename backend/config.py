import os
import sys
from dotenv import load_dotenv

# Windows에서 stdout/stderr이 실제 콘솔에 연결되지 않고 파이프로 리다이렉트되면
# (Tauri sidecar로 실행되거나, 백그라운드로 띄우거나, 콘솔이 없는 GUI 프로세스의
# 자식으로 뜨는 경우 등) 기본 인코딩이 시스템 로케일 코드페이지(cp1252 등)로
# 떨어진다. 이 코드페이지가 표현 못 하는 한글 등을 print()하면
# UnicodeEncodeError가 그 자리에서 발생해 프로세스 전체가 죽는다 - 실제로
# Windows CI에서 아래쪽의 기본 관리자 계정 경고 print() 때문에 백엔드가
# 기동 자체를 못 하는 것으로 재현됨. 인코딩을 UTF-8로 강제해 원천 차단한다.
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

def _get_config_dir() -> str:
    """.env / translation_prompt.txt를 읽고 쓸 디렉토리.

    EASYPAPER_CONFIG_DIR이 설정되어 있으면 그 경로(패키징된 데스크탑 앱이
    OS별 사용자 데이터 디렉토리를 주입하는 용도)를, 없으면 기존과 동일하게
    backend/ 디렉토리 자체를 사용한다(서버/Docker 배포 하위호환).
    """
    return os.getenv("EASYPAPER_CONFIG_DIR") or os.path.dirname(os.path.abspath(__file__))


load_dotenv(os.path.join(_get_config_dir(), ".env"))

OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
TRANS_PROVIDER = os.getenv("TRANS_PROVIDER", "ollama")
TRANS_MODEL = os.getenv("TRANS_MODEL", "gemma4:e4b")
CHAT_PROVIDER = os.getenv("CHAT_PROVIDER", "ollama")
CHAT_MODEL = os.getenv("CHAT_MODEL", "gemma4:e4b")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
CLAUDE_API_KEY = os.getenv("CLAUDE_API_KEY", "")

# OpenAlex(참고문헌 링크 연결 기능)는 API 키가 아예 필요 없지만, 요청에 연락
# 가능한 이메일을 mailto 파라미터로 실어 보내면 더 여유로운 한도의 "polite
# pool"로 분류된다. 선택 사항이라 비워둬도 정상 동작한다.
OPENALEX_MAILTO = os.getenv("OPENALEX_MAILTO", "")

PDF_PARSER_ENGINE = os.getenv("PDF_PARSER_ENGINE", "pymupdf")

MAX_FILE_SIZE_MB = int(os.getenv("MAX_FILE_SIZE_MB", "50"))
SESSION_TTL_HOURS = int(os.getenv("SESSION_TTL_HOURS", "24"))
UPLOAD_DIR = os.getenv("UPLOAD_DIR", "./uploads")
CACHE_DIR = os.getenv("CACHE_DIR", "./cache")
LIBRARY_DIR = os.getenv("LIBRARY_DIR", "./library")
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")
PROJECT_ROOT = os.getenv("PROJECT_ROOT", "")
# .env.example에 이 프로젝트를 개발한 서버 전용 절대경로가 예시로 박혀 있어서,
# 사용자가 .env.example을 그대로 복사해 .env를 만들면 자기 기기에는 존재하지
# 않는 PROJECT_ROOT를 그대로 신뢰하게 된다. 이 값은 CLI(Claude Code/Codex/
# Antigravity) 서브프로세스의 cwd로 바로 쓰이기 때문에, 존재하지 않는 경로면
# 서브프로세스 실행 자체가 [Errno 2] No such file or directory로 즉시 실패한다.
# 실제로 존재하는 디렉터리인지 검증하고, 아니면 코드 위치 기준으로 다시 계산한다.
if not PROJECT_ROOT or not os.path.isdir(PROJECT_ROOT):
    PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def get_project_root() -> str:
    return PROJECT_ROOT

def get_ollama_host() -> str:
    return OLLAMA_HOST

def is_ollama_host_local() -> bool:
    """설정된 Ollama 호스트가 이 서버 자신(localhost)을 가리키는지 확인합니다.
    원격 호스트를 가리키는 경우 이 서버에 설치 스크립트를 실행하는 것은 의미가 없습니다."""
    from urllib.parse import urlparse
    try:
        hostname = urlparse(OLLAMA_HOST).hostname or ""
    except Exception:
        return False
    return hostname in ("localhost", "127.0.0.1", "::1", "0.0.0.0")


def windows_safe_exec_args(cmd):
    """CLI 서브프로세스 실행용 argv를 만듭니다.

    claude/codex/agy는 npm 등을 통해 설치되면 Windows에서 실제 실행 파일이
    아니라 .cmd/.bat 래퍼 스크립트로 배포되는 경우가 많다. asyncio의
    create_subprocess_exec(shell=False)는 Windows의 CreateProcess를 그대로
    쓰는데, 이 API는 .cmd/.bat 파일을 이미지로 인식하지 못해 실제로는 정상
    설치되어 있어도 "[WinError 2] 지정된 파일을 찾을 수 없습니다" 오류로
    실행 자체가 실패한다. Windows에서는 cmd.exe를 경유해 PATHEXT 확장자
    검색·해석을 맡기는 방식으로 이를 우회한다 (macOS/Linux는 기존과 동일).

    단, agy(Antigravity)의 공식 Windows 설치본은 .cmd 셔임이 아니라 실제
    agy.exe 네이티브 바이너리다(get_agy_path의 %LOCALAPPDATA%\\agy\\bin
    폴백 참고). 이런 .exe까지 cmd /c로 감싸면, cmd.exe가 전달받은 인자
    문자열을 자기 방식대로 다시 파싱하면서 인자 안의 개행 문자(\\n)를
    명령 경계로 오인해 그 뒤 내용을 통째로 잘라버린다 - 실제로 번역
    프롬프트(안내문 뒤에 \\n\\n으로 이어지는 원문 본문)를 --print 인자로
    넘기면 agy가 안내문만 받고 원문 본문은 통째로 사라져, "번역할 텍스트를
    알려주세요"만 반복 응답하는 버그로 이어졌다. .exe는 CreateProcess가
    셸 없이 바로 실행할 수 있으므로 cmd.exe 경유 자체가 불필요하다 -
    .cmd/.bat 래퍼(확장자가 .exe가 아닌 경우)만 cmd /c로 감싼다.
    """
    import platform
    if platform.system() == "Windows":
        exe_path = cmd[0] if cmd else ""
        if isinstance(exe_path, str) and exe_path.lower().endswith(".exe"):
            return list(cmd)
        return ["cmd", "/c"] + list(cmd)
    return list(cmd)


def find_ollama_binary():
    # 반환값: 찾은 ollama 실행 파일의 경로(str) 또는 못 찾았을 때 None
    """이 서버에 Ollama CLI가 설치되어 있는지 확인합니다.

    shutil.which("ollama")는 현재 프로세스가 시작될 때 캡처된 PATH만 보므로,
    (특히 Windows에서) 설치 스크립트가 레지스트리의 PATH를 갱신해도 이미 떠있는
    백엔드 프로세스에는 반영되지 않아 방금 설치했거나 이미 정상 동작 중인
    Ollama를 "미설치"로 오판하는 문제가 있었다. PATH 조회에 실패하면 OS별로
    흔히 설치되는 실제 경로들을 직접 확인해 이 문제를 우회한다.
    """
    import os
    import platform
    import shutil

    found = shutil.which("ollama")
    if found:
        return found

    system = platform.system()
    candidates = []
    if system == "Windows":
        localappdata = os.environ.get("LOCALAPPDATA", "")
        if localappdata:
            candidates.append(os.path.join(localappdata, "Programs", "Ollama", "ollama.exe"))
    elif system == "Darwin":
        candidates += ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama"]
    else:
        candidates += ["/usr/local/bin/ollama", "/usr/bin/ollama"]

    for path in candidates:
        if path and os.path.exists(path):
            return path
    return None

def get_trans_provider() -> str:
    return TRANS_PROVIDER

def get_trans_model() -> str:
    return TRANS_MODEL

def get_chat_provider() -> str:
    return CHAT_PROVIDER

def get_chat_model() -> str:
    return CHAT_MODEL

def get_openai_api_key() -> str:
    return OPENAI_API_KEY

def get_gemini_api_key() -> str:
    return GEMINI_API_KEY

def get_claude_api_key() -> str:
    return CLAUDE_API_KEY

def get_openalex_mailto() -> str:
    return OPENALEX_MAILTO

def get_pdf_parser_engine() -> str:
    return PDF_PARSER_ENGINE

def update_system_settings(
    ollama_host: str,
    trans_provider: str,
    trans_model: str,
    chat_provider: str,
    chat_model: str,
    openai_api_key: str = "",
    gemini_api_key: str = "",
    claude_api_key: str = "",
    openalex_mailto: str = "",
    pdf_parser_engine: str = "pymupdf"
):
    global OLLAMA_HOST, TRANS_PROVIDER, TRANS_MODEL, CHAT_PROVIDER, CHAT_MODEL, OPENAI_API_KEY, GEMINI_API_KEY, CLAUDE_API_KEY, OPENALEX_MAILTO, PDF_PARSER_ENGINE

    OLLAMA_HOST = ollama_host
    TRANS_PROVIDER = trans_provider
    TRANS_MODEL = trans_model
    CHAT_PROVIDER = chat_provider
    CHAT_MODEL = chat_model
    OPENAI_API_KEY = openai_api_key
    GEMINI_API_KEY = gemini_api_key
    CLAUDE_API_KEY = claude_api_key
    OPENALEX_MAILTO = openalex_mailto
    PDF_PARSER_ENGINE = pdf_parser_engine

    env_path = os.path.join(_get_config_dir(), ".env")
    settings = {
        "OLLAMA_HOST": ollama_host,
        "TRANS_PROVIDER": trans_provider,
        "TRANS_MODEL": trans_model,
        "CHAT_PROVIDER": chat_provider,
        "CHAT_MODEL": chat_model,
        "OPENAI_API_KEY": openai_api_key,
        "GEMINI_API_KEY": gemini_api_key,
        "CLAUDE_API_KEY": claude_api_key,
        "OPENALEX_MAILTO": openalex_mailto,
        "PDF_PARSER_ENGINE": pdf_parser_engine
    }

    if not os.path.exists(env_path):
        with open(env_path, "w", encoding="utf-8") as f:
            for k, v in settings.items():
                f.write(f"{k}={v}\n")
        return
        
    with open(env_path, "r", encoding="utf-8") as f:
        lines = f.readlines()
        
    new_lines = []
    found_keys = set()
    
    for line in lines:
        stripped = line.strip()
        updated = False
        for k in settings.keys():
            if stripped.startswith(f"{k}="):
                new_lines.append(f"{k}={settings[k]}\n")
                found_keys.add(k)
                updated = True
                break
        if not updated:
            new_lines.append(line)
            
    for k, v in settings.items():
        if k not in found_keys:
            new_lines.append(f"{k}={v}\n")
            
    with open(env_path, "w", encoding="utf-8") as f:
        f.writelines(new_lines)


# Authentication settings
APP_USERNAME = os.getenv("APP_USERNAME", "admin")
# 이 해시는 모든 EasyPaper 설치본이 동일하게 공유하는 공개된 기본값(비밀번호
# "admin")이다. 리포지토리 자체가 공개돼 있어 사실상 이미 알려진 값이나
# 마찬가지라, 오프라인 크래킹 대상이라기보다 "설정을 아직 안 바꾼 상태"임을
# 곧바로 알 수 있는 지표에 가깝다. 첫 실행 UX(아이디: admin, 비밀번호: admin
# 으로 로그인 후 설정에서 변경)를 그대로 유지하기 위해 값 자체는 바꾸지
# 않되, 이 기본값 그대로 운영 중이면 서버 시작 시 매번 눈에 띄게 경고한다.
DEFAULT_PASSWORD_HASH = "0102030405060708090a0b0c0d0e0f10:c8c17b1c61732cde577461e36b682deab2dda5cd72797d2517526dfcbc39d6b3"
APP_PASSWORD_HASH = os.getenv("APP_PASSWORD_HASH", DEFAULT_PASSWORD_HASH)
APP_PASSWORD = os.getenv("APP_PASSWORD", "")

if APP_PASSWORD_HASH == DEFAULT_PASSWORD_HASH:
    print(
        "\n" + "!" * 70 +
        "\n[보안 경고] 기본 관리자 계정(admin / admin)을 그대로 사용 중입니다.\n"
        "이 값은 EasyPaper를 설치한 모든 사용자가 동일하게 공유하는 공개된\n"
        "기본값이라, 외부에서 접근 가능한 환경이라면 즉시 로그인 후 설정\n"
        "화면에서 아이디/비밀번호를 변경해주세요.\n"
        + "!" * 70 + "\n"
    )

# 모든 설치본이 동일한 고정 문자열을 SECRET_KEY로 공유하면, 이 리포지토리를
# 본 사람은 누구나 그 값으로 세션 토큰(HMAC 서명)을 위조해 로그인 없이도
# 관리자 세션을 만들 수 있다 - 비밀번호를 바꿔도 세션 서명 키와는 무관해
# 막히지 않는다. .env에 값이 없거나 예전에 쓰이던 고정 기본값 그대로면,
# 안전한 난수 키를 새로 만들어 .env에 영구 저장한다(재시작마다 새로 만들면
# 기존 로그인이 매번 끊기므로 반드시 영속화가 필요함).
_INSECURE_DEFAULT_SECRET_KEYS = {
    "",
    "easypaper_secret_key_change_me_in_production_1234567890",
}

def _persist_secret_key_to_env(new_key: str):
    env_path = os.path.join(_get_config_dir(), ".env")
    if not os.path.exists(env_path):
        with open(env_path, "w", encoding="utf-8") as f:
            f.write(f"SECRET_KEY={new_key}\n")
        return
    with open(env_path, "r", encoding="utf-8") as f:
        lines = f.readlines()
    new_lines = []
    found = False
    for line in lines:
        if line.strip().startswith("SECRET_KEY="):
            new_lines.append(f"SECRET_KEY={new_key}\n")
            found = True
        else:
            new_lines.append(line)
    if not found:
        new_lines.append(f"SECRET_KEY={new_key}\n")
    with open(env_path, "w", encoding="utf-8") as f:
        f.writelines(new_lines)

def _get_or_create_secret_key() -> str:
    existing = os.getenv("SECRET_KEY", "")
    if existing not in _INSECURE_DEFAULT_SECRET_KEYS:
        return existing
    import secrets
    new_key = secrets.token_hex(32)
    try:
        _persist_secret_key_to_env(new_key)
    except Exception:
        pass
    return new_key

SECRET_KEY = _get_or_create_secret_key()

def get_app_username() -> str:
    return APP_USERNAME

def get_app_password_hash() -> str:
    return APP_PASSWORD_HASH

def get_app_password() -> str:
    return APP_PASSWORD

def update_credentials_in_env(new_username: str, new_password_hash: str):
    global APP_USERNAME, APP_PASSWORD_HASH, APP_PASSWORD
    
    APP_USERNAME = new_username
    APP_PASSWORD_HASH = new_password_hash
    APP_PASSWORD = ""  # Clear plaintext password for security
    
    env_path = os.path.join(_get_config_dir(), ".env")
    if not os.path.exists(env_path):
        with open(env_path, "w", encoding="utf-8") as f:
            f.write(f"APP_USERNAME={new_username}\nAPP_PASSWORD_HASH={new_password_hash}\n")
        return
        
    with open(env_path, "r", encoding="utf-8") as f:
        lines = f.readlines()
        
    new_lines = []
    username_found = False
    hash_found = False
    
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("APP_USERNAME="):
            new_lines.append(f"APP_USERNAME={new_username}\n")
            username_found = True
        elif stripped.startswith("APP_PASSWORD_HASH="):
            new_lines.append(f"APP_PASSWORD_HASH={new_password_hash}\n")
            hash_found = True
        elif stripped.startswith("APP_PASSWORD="):
            # Deactivate plaintext password by commenting it out
            new_lines.append(f"# APP_PASSWORD=\n")
        else:
            new_lines.append(line)
            
    if not username_found:
        new_lines.append(f"APP_USERNAME={new_username}\n")
    if not hash_found:
        new_lines.append(f"APP_PASSWORD_HASH={new_password_hash}\n")

    with open(env_path, "w", encoding="utf-8") as f:
        f.writelines(new_lines)


# 로그인 화면을 완전히 건너뛰고 항상 관리자로 자동 인증할지 여부. 신뢰할 수
# 있는 개인/로컬 환경(예: 다른 사람이 접근할 수 없는 개인 PC의 Tauri
# 데스크탑 앱)에서 매번 로그인하는 번거로움을 없애기 위한 설정이다 - 켜면
# 이 서버에 네트워크로 접근 가능한 모든 사람이 인증 없이 전체 기능을 쓸
# 수 있게 되므로, 계정 설정 화면에서 명시적으로 켜야만 활성화된다. "전체
# 기능"에는 /settings/update(git pull + 재빌드 + 서버 재시작)와
# /settings/install-*(Ollama/Claude Code/Codex/Antigravity 원격 설치
# 스크립트 실행)처럼 서버에 소프트웨어를 설치·재시작시킬 수 있는 관리
# 기능도 포함되므로, 단순 조회 권한보다 훨씬 강력한 노출이라는 점에
# 유의해야 한다.
SKIP_LOGIN = os.getenv("SKIP_LOGIN", "false").strip().lower() == "true"

def get_skip_login() -> bool:
    return SKIP_LOGIN

def set_skip_login(enabled: bool):
    global SKIP_LOGIN
    SKIP_LOGIN = enabled

    env_path = os.path.join(_get_config_dir(), ".env")
    value_str = "true" if enabled else "false"
    if not os.path.exists(env_path):
        with open(env_path, "w", encoding="utf-8") as f:
            f.write(f"SKIP_LOGIN={value_str}\n")
        return

    with open(env_path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    new_lines = []
    found = False
    for line in lines:
        if line.strip().startswith("SKIP_LOGIN="):
            new_lines.append(f"SKIP_LOGIN={value_str}\n")
            found = True
        else:
            new_lines.append(line)
    if not found:
        new_lines.append(f"SKIP_LOGIN={value_str}\n")

    with open(env_path, "w", encoding="utf-8") as f:
        f.writelines(new_lines)

if SKIP_LOGIN:
    print(
        "\n" + "!" * 70 +
        "\n[보안 경고] 로그인 없이 사용 설정이 켜져 있습니다.\n"
        "이 서버에 네트워크로 접근 가능한 모든 사람이 인증 없이 전체 기능을\n"
        "쓸 수 있습니다. 여기에는 논문 열람뿐 아니라 git pull + 재빌드 후\n"
        "서버 자동 재시작(시스템 업데이트), Ollama/Claude Code/Codex/\n"
        "Antigravity CLI 원격 설치 스크립트 실행(curl|bash, PowerShell\n"
        "irm|iex) 등 서버에 임의 소프트웨어를 설치하고 프로세스를 재시작할\n"
        "수 있는 관리 기능까지 전부 포함됩니다. 신뢰할 수 있는 개인/로컬\n"
        "환경이 아니라면 설정에서 즉시 꺼주세요.\n"
        + "!" * 70 + "\n"
    )

# 디렉토리 생성
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(LIBRARY_DIR, exist_ok=True)

# App host & port configuration
APP_HOST = os.getenv("APP_HOST", "0.0.0.0")
APP_PORT = int(os.getenv("APP_PORT", "8000"))

# Antigravity/Claude Code/Codex CLI 기본 설치 경로. 예전에는 이 프로젝트를
# 개발한 서버 전용 절대경로(/home/ubuntu/.local/bin/...)가 박혀 있어서 다른
# 사용자 계정에서는 이 기본값 자체가 항상 존재하지 않는 경로였다. 각 CLI의
# 공식 curl 설치 스크립트가 공통으로 쓰는 ~/.local/bin 기준으로 바꿔, PATH
# 탐색(_resolve_cli_path)이 실패하더라도 이 기본값만으로 찾아지는 경우를
# 늘린다.
AGY_PATH = os.getenv("AGY_PATH", os.path.expanduser("~/.local/bin/agy"))
CLAUDE_CODE_PATH = os.getenv("CLAUDE_CODE_PATH", os.path.expanduser("~/.local/bin/claude"))
CODEX_PATH = os.getenv("CODEX_PATH", os.path.expanduser("~/.local/bin/codex"))

def get_app_host() -> str:
    return APP_HOST

def get_app_port() -> int:
    return APP_PORT

def _resolve_cli_path(configured_path: str, bare_command: str) -> str:
    """설정된 CLI 경로가 실제로 존재하면 그대로 쓰고, 없으면 PATH에서 명령
    이름으로 찾은 뒤, 그마저 실패하면 각 CLI 공식 설치 스크립트가 실제로
    쓰는 OS별 잘 알려진 위치도 한 번 더 확인한다(find_ollama_binary와 동일한
    패턴).

    AGY_PATH/CLAUDE_CODE_PATH/CODEX_PATH의 기본값이 존재하지 않거나, PATH
    탐색이 실패하는 경우(특히 Tauri 데스크탑 앱처럼 GUI로 실행되어 로그인
    셸의 PATH를 물려받지 못하는 환경)에도 최대한 찾아보기 위함이다.
    """
    import os
    import platform
    import shutil
    if configured_path and os.path.exists(configured_path):
        return configured_path
    found = shutil.which(bare_command)
    if found:
        return found

    # Codex/Antigravity의 공식 Windows 설치 스크립트는 ~/.local/bin이 아니라
    # 각각 %LOCALAPPDATA%\Programs\OpenAI\Codex\bin, %LOCALAPPDATA%\agy\bin에
    # 설치한다 - *_PATH 기본값(~/.local/bin/...)과 실제 설치 위치가 OS별로
    # 다른 경우라 별도로 확인한다. 이 확인이 없으면 설치 스크립트가 exit
    # code 0으로 정상 종료해도 바이너리를 못 찾아 "성공했는데 실패로 표시"되는
    # 모순이 생긴다(설치 직후 PATH 레지스트리 브로드캐스트는 이미 떠 있는
    # 백엔드 프로세스의 os.environ["PATH"]는 갱신하지 못하므로 shutil.which도
    # 도움이 안 된다).
    if platform.system() == "Windows":
        localappdata = os.environ.get("LOCALAPPDATA", "")
        if localappdata:
            windows_candidates = {
                "codex": os.path.join(localappdata, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
                "agy": os.path.join(localappdata, "agy", "bin", "agy.exe"),
            }
            candidate = windows_candidates.get(bare_command)
            if candidate and os.path.exists(candidate):
                return candidate

    return bare_command

def get_agy_path() -> str:
    return _resolve_cli_path(AGY_PATH, "agy")

def get_claude_code_path() -> str:
    return _resolve_cli_path(CLAUDE_CODE_PATH, "claude")

def get_codex_path() -> str:
    return _resolve_cli_path(CODEX_PATH, "codex")

def get_agy_env() -> dict:
    """CLI(Claude Code/Codex/Antigravity) 서브프로세스에 넘길 환경 변수를 만든다.

    일부 실행 환경(예: 로그인 셸을 거치지 않는 서비스/데몬으로 백엔드를 띄운 경우)에서는
    HOME/USER가 비어 있을 수 있는데, 예전에는 이 값을 이 프로젝트를 개발한 서버 전용
    경로(/home/ubuntu)로 하드코딩해 다른 환경(특히 macOS)에서는 존재하지 않는 디렉터리를
    가리키게 됐다. macOS의 posix_spawn은 존재하지 않는 디렉터리를 만나면 ENOENT 대신
    [Errno 45] Operation not supported를 던지는 경우가 있어, CLI 실행이 알 수 없는 에러로
    실패하는 원인이 됐다. os.path.expanduser("~")/getpass로 실제 현재 사용자의 홈 디렉터리를
    구해 어떤 OS/계정에서도 항상 존재하는 경로를 쓰도록 수정.
    """
    env = os.environ.copy()
    if "HOME" not in env or not env["HOME"]:
        env["HOME"] = os.path.expanduser("~")
    if "USER" not in env or not env["USER"]:
        try:
            import getpass
            env["USER"] = getpass.getuser()
        except Exception:
            pass
    return env

# ── Dynamic Translation Prompt Template ─────────────────
PROMPT_FILE = os.path.join(_get_config_dir(), "translation_prompt.txt")

DEFAULT_PROMPT_TEMPLATE = """당신은 학술 논문 번역 전문가입니다. {{LANG_INSTRUCTION}}

번역 스타일:
{{STYLE_INSTRUCTION}}

번역 규칙:
{{RULES_TEXT}}
- 번역 텍스트를 중간에 절대 끊지 마세요. 반드시 주어진 원문 전체를 빠짐없이 완전하게 번역하여 출력하세요.
- 번역 시작 전 서론(예: '번역 결과:', '다음은 번역입니다:')을 절대 추가하지 마세요. 번역된 내용만 즉시 출력하세요.
- 제공된 [참고 문맥 정보](논문 제목 및 이전 번역)를 참고하여, 전문 용어 번역이나 문장 어조가 일관되게 이어지도록 하세요. 단, 이전 번역 내용을 답변에 다시 포함하여 출력해서는 안 되며, 오직 아래의 '원문'만 새로 번역해야 합니다.
- [여기에 본인만의 추가 번역 규칙이나 어투 지시사항(예: "반드시 경어체 '~합니다' 체만 사용하여 자연스럽게 번역해 주세요")을 자유롭게 입력하여 수정할 수 있습니다]

{{CONTEXT_PART}}

원문:
{{TEXT}}

{{TARGET_LANG}} 번역:"""

def get_translation_prompt_template() -> str:
    if not os.path.exists(PROMPT_FILE):
        with open(PROMPT_FILE, "w", encoding="utf-8") as f:
            f.write(DEFAULT_PROMPT_TEMPLATE.strip())
        return DEFAULT_PROMPT_TEMPLATE.strip()
    with open(PROMPT_FILE, "r", encoding="utf-8") as f:
        return f.read().strip()

def update_translation_prompt_template(new_template: str):
    if not new_template or not new_template.strip():
        # Fall back to default if empty
        template_to_save = DEFAULT_PROMPT_TEMPLATE.strip()
    else:
        template_to_save = new_template.strip()
    with open(PROMPT_FILE, "w", encoding="utf-8") as f:
        f.write(template_to_save)

