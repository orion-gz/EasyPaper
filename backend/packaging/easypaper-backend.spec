# PyInstaller spec — EasyPaper 백엔드를 Tauri sidecar용 onedir 바이너리로 빌드한다.
#
# 실행: (backend/ 안의 venv를 활성화한 상태에서) 저장소 루트 기준
#   pyinstaller backend/packaging/easypaper-backend.spec --distpath backend/packaging/dist --workpath backend/packaging/build
#
# one-file이 아니라 one-dir을 쓰는 이유는 tauri-desktop-spike.md 계획 Phase 1 참고:
# 매 실행마다 임시 디렉토리에 압축을 푸는 one-file은 시작 지연이 크고, 그 임시
# 디렉토리가 매번 새로 생겨 "코드 위치 기준 상대경로에 무언가를 영속화"하는
# 기존 backend/config.py 패턴과 상성이 나쁘다.

import os
from PyInstaller.utils.hooks import collect_all

block_cipher = None

# 데스크탑 배포본의 제한된 설치 모드에서 pip를 직접 호출할 수 있도록
# pip의 동적 모듈과 데이터를 sidecar에 포함한다.
pip_datas, pip_binaries, pip_hiddenimports = collect_all("pip")

BACKEND_DIR = os.path.join(os.path.dirname(os.path.abspath(SPEC)), "..")
BACKEND_DIR = os.path.abspath(BACKEND_DIR)

a = Analysis(
    [os.path.join(BACKEND_DIR, "main.py")],
    pathex=[BACKEND_DIR],
    binaries=pip_binaries,
    datas=pip_datas + [
        # DEFAULT_PROMPT_TEMPLATE 폴백이 config.py에 있어 필수는 아니지만,
        # 사용자가 커스터마이징하기 전 기본 템플릿 파일을 그대로 들고 있으면
        # 첫 실행 UX가 서버/Docker 배포와 동일해진다.
        (os.path.join(BACKEND_DIR, "translation_prompt.txt"), "."),
        # frontend/dist를 _internal/frontend/dist에 둔다(PyInstaller는 datas
        # 목적지가 onedir 최상위 밖을 가리키는 것을 허용하지 않는다). main.py는
        # EASYPAPER_FRONTEND_DIST 환경변수가 있으면 그 경로를 그대로 쓰도록
        # 되어 있으므로, 이 위치는 src-tauri/src/lib.rs가 sidecar를 실행할 때
        # "<sidecar 실행파일 디렉토리>/_internal/frontend/dist"로 알려준다.
        (os.path.join(BACKEND_DIR, "..", "frontend", "dist"), "frontend/dist"),
    ],
    hiddenimports=pip_hiddenimports + [
        # uvicorn은 프로토콜/루프 구현체를 동적으로 임포트하므로 PyInstaller의
        # 정적 분석이 놓치기 쉽다. main.py가 uvicorn.run(app, ...)으로 앱
        # 객체를 직접 넘기도록 바뀌어(문자열 임포트 아님) 최소 요구치는 줄었지만,
        # 프로토콜/루프 구현체 자체는 여전히 동적 로딩이라 명시가 필요하다.
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.loops.asyncio",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.http.httptools_impl",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="easypaper-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name="easypaper-backend",
)
