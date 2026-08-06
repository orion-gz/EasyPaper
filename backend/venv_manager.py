"""marker/mineru PDF 파서 엔진 전용 venv 관리.

marker-pdf(surya-ocr)는 transformers>=5.12.1을, mineru[pipeline]은
transformers<5.0.0을 요구해 같은 venv에 절대 공존할 수 없다(런타임에서
직접 확인된 충돌 - surya는 transformers>=5 미만에서, mineru는 5 이상에서
각각 다른 이유로 즉시 크래시함). 그래서 mineru만 별도 venv(.venv-mineru)에
설치하고, 설정에서 선택된 엔진에 맞는 venv로 프로세스를 전환해 실행한다.
pymupdf/pdfplumber/marker는 기본 venv(.venv)에서, mineru만 .venv-mineru에서 돈다.
"""
import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_VENV = os.path.join(_BACKEND_DIR, ".venv")
MINERU_VENV = os.path.join(_BACKEND_DIR, ".venv-mineru")


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
    target = required_venv_for_engine(engine)
    if not is_venv_available(target):
        return
    target_python = os.path.realpath(venv_python(target))
    if target_python == os.path.realpath(sys.executable):
        return
    os.execv(target_python, [target_python] + sys.argv)
