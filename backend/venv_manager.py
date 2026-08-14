"""marker/mineru PDF 파서 엔진 전용 venv 관리.

marker-pdf(surya-ocr)는 transformers>=5.12.1을, mineru[pipeline]은
transformers<5.0.0을 요구해 같은 venv에 절대 공존할 수 없다(런타임에서
직접 확인된 충돌 - surya는 transformers>=5 미만에서, mineru는 5 이상에서
각각 다른 이유로 즉시 크래시함). 그래서 mineru만 별도 venv(.venv-mineru)에
설치하고, 설정에서 선택된 엔진에 맞는 venv로 프로세스를 전환해 실행한다.
pymupdf/pdfplumber/marker는 기본 venv(.venv)에서, mineru만 .venv-mineru에서 돈다.
Tauri PyInstaller 배포본은 일반 Python 인터프리터가 아니므로 별도 venv 대신
사용자 앱 데이터 폴더의 엔진별 site-packages를 앱 재실행 시 활성화한다.
"""
import os
import shutil
import site
import sys
import tempfile

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_VENV = os.path.join(_BACKEND_DIR, ".venv")
MINERU_VENV = os.path.join(_BACKEND_DIR, ".venv-mineru")

PARSER_PACKAGES = {
    "pdfplumber": ("pdfplumber", "pdfplumber"),
    "marker": ("marker-pdf", "marker"),
    "mineru": ("mineru[pipeline]", "mineru"),
}

_PACKAGED_INSTALL_ARG = "--easypaper-install-pdf-parser"
_active_engine = "pymupdf"


def is_packaged_desktop() -> bool:
    """Tauri가 실행한 PyInstaller sidecar인지 판별한다."""
    return bool(getattr(sys, "frozen", False)) and os.getenv("EASYPAPER_DESKTOP") == "1"


def parser_packages_root() -> str:
    config_dir = os.getenv("EASYPAPER_CONFIG_DIR") or _BACKEND_DIR
    return os.path.join(config_dir, "pdf-parser-packages")


def parser_packages_dir(engine: str) -> str:
    if engine not in PARSER_PACKAGES:
        raise ValueError(f"지원되지 않는 파서 엔진입니다: {engine}")
    return os.path.join(parser_packages_root(), engine)


def is_parser_installed(engine: str) -> bool:
    if engine == "pymupdf":
        return True
    package = PARSER_PACKAGES.get(engine)
    if not package:
        return False
    return os.path.isdir(os.path.join(parser_packages_dir(engine), package[1]))


def parser_install_command(engine: str) -> list[str]:
    """현재 sidecar를 제한된 pip 설치 모드로 다시 실행하는 명령."""
    if engine not in PARSER_PACKAGES:
        raise ValueError(f"지원되지 않는 파서 엔진입니다: {engine}")
    return [sys.executable, _PACKAGED_INSTALL_ARG, engine]


def run_packaged_parser_installer(argv: list[str] | None = None) -> int:
    """번들 pip로 선택 파서를 사용자 앱 데이터 폴더에 원자적으로 설치한다."""
    # Windows GUI sidecar의 파이프 stdout은 cp1252 등으로 잡힐 수 있어
    # 한글 진행/오류 메시지가 UnicodeEncodeError로 설치 프로세스를 죽이지
    # 않도록 설치 전용 진입점에서도 UTF-8을 명시한다.
    if sys.platform == "win32":
        for stream in (sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8", errors="replace")

    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 2 or args[0] != _PACKAGED_INSTALL_ARG:
        print("잘못된 PDF 파서 설치 명령입니다.", file=sys.stderr, flush=True)
        return 2

    engine = args[1]
    package = PARSER_PACKAGES.get(engine)
    if not package:
        print(f"지원되지 않는 파서 엔진입니다: {engine}", file=sys.stderr, flush=True)
        return 2

    root = parser_packages_root()
    os.makedirs(root, exist_ok=True)
    staging_dir = tempfile.mkdtemp(prefix=f".{engine}-install-", dir=root)
    target_dir = parser_packages_dir(engine)

    try:
        from pip._internal.cli.main import main as pip_main

        result = pip_main([
            "install",
            "--disable-pip-version-check",
            "--no-input",
            "--target", staging_dir,
            package[0],
        ])
        if result != 0:
            return int(result)
        if not os.path.isdir(os.path.join(staging_dir, package[1])):
            print(
                f"설치 완료 후 모듈을 찾을 수 없습니다: {package[1]}",
                file=sys.stderr,
                flush=True,
            )
            return 1

        if os.path.isdir(target_dir):
            shutil.rmtree(target_dir)
        os.replace(staging_dir, target_dir)
        staging_dir = ""
        print(f"{package[0]} 패키지 검증 및 설치가 완료되었습니다.", flush=True)
        return 0
    except Exception as exc:
        print(f"PDF 파서 패키지 설치 실패: {exc}", file=sys.stderr, flush=True)
        return 1
    finally:
        if staging_dir and os.path.isdir(staging_dir):
            shutil.rmtree(staging_dir, ignore_errors=True)


def uninstall_packaged_parser(engine: str) -> None:
    target_dir = parser_packages_dir(engine)
    if not os.path.isdir(target_dir):
        raise FileNotFoundError(target_dir)
    shutil.rmtree(target_dir)


def _activate_packaged_parser(engine: str) -> None:
    """선택 엔진의 격리된 site-packages를 이번 sidecar에만 활성화한다."""
    global _active_engine
    _active_engine = "pymupdf"
    if engine == "pymupdf" or not is_parser_installed(engine):
        return

    package_dir = parser_packages_dir(engine)
    site.addsitedir(package_dir)
    while package_dir in sys.path:
        sys.path.remove(package_dir)
    sys.path.insert(0, package_dir)
    _active_engine = engine


def required_venv_for_engine(engine: str) -> str:
    return MINERU_VENV if engine == "mineru" else DEFAULT_VENV


def venv_python(venv_dir: str) -> str:
    if sys.platform == "win32":
        return os.path.join(venv_dir, "Scripts", "python.exe")
    return os.path.join(venv_dir, "bin", "python")


def is_venv_available(venv_dir: str) -> bool:
    return os.path.isfile(venv_python(venv_dir))


def current_venv_root() -> str:
    """현재 실행 중인 인터프리터가 속한 venv의 루트 경로."""
    return os.path.realpath(sys.prefix)


def restart_required_for_engine(engine: str) -> bool:
    """설정된 엔진을 쓰려면 지금과 다른 venv로 재시작해야 하는지 여부.
    필요한 venv가 아직 설치 전이면(mineru 미설치 등) 재시작해봐야 의미가
    없으므로(어차피 폴백된다) False를 반환한다 - 설치 자체는 별도 설치
    플로우(install-pdf-parser)의 몫이다."""
    if is_packaged_desktop():
        return is_parser_installed(engine) and engine != _active_engine

    target = required_venv_for_engine(engine)
    if not is_venv_available(target):
        return False
    return os.path.realpath(target) != current_venv_root()


def relaunch_into_required_venv(engine: str) -> None:
    """프로세스 시작 시점에 호출한다. 설정된 엔진에 필요한 venv가 지금과
    다르면 그 venv의 python으로 현재 프로세스를 즉시 교체한다(os.execv).
    아직 어떤 소켓도 열지 않은 시작 시점에만 안전하게 쓸 수 있다 - 이미
    떠 있는 서버를 재시작할 때는 이 함수 대신 routers/auth.py의
    _restart_server_process()(systemctl 또는 자체 프로세스 교체)를 통해
    프로세스 자체를 새로 띄워야 하고, 그 새 프로세스가 시작하면서 다시
    이 함수를 거쳐 올바른 venv로 한 번 더 스스로 전환된다."""
    if is_packaged_desktop():
        _activate_packaged_parser(engine)
        return

    target = required_venv_for_engine(engine)
    if not is_venv_available(target):
        return
    target_python = os.path.realpath(venv_python(target))
    if target_python == os.path.realpath(sys.executable):
        return
    os.execv(target_python, [target_python] + sys.argv)
