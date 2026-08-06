"""venv_manager.py 순수 로직 테스트. 실제 venv 생성/실행 없이, 가짜
디렉터리 구조(bin/python 존재 여부)만으로 판단 분기를 검증한다."""
import os
import sys

import venv_manager


def _make_fake_venv(base_dir):
    bin_dir = "Scripts" if sys.platform == "win32" else "bin"
    python_name = "python.exe" if sys.platform == "win32" else "python"
    os.makedirs(os.path.join(base_dir, bin_dir), exist_ok=True)
    python_path = os.path.join(base_dir, bin_dir, python_name)
    with open(python_path, "w") as f:
        f.write("")
    return python_path


def test_required_venv_for_engine():
    assert venv_manager.required_venv_for_engine("mineru") == venv_manager.MINERU_VENV
    for engine in ["pymupdf", "pdfplumber", "marker"]:
        assert venv_manager.required_venv_for_engine(engine) == venv_manager.DEFAULT_VENV


def test_restart_required_for_engine_false_when_target_venv_missing(tmp_path, monkeypatch):
    missing_venv = tmp_path / "does-not-exist"
    monkeypatch.setattr(venv_manager, "MINERU_VENV", str(missing_venv))
    # mineru venv가 아예 설치 전이면 재시작해봐야 의미 없다(폴백될 뿐)
    assert venv_manager.restart_required_for_engine("mineru") is False


def test_restart_required_for_engine_true_when_different_venv(tmp_path, monkeypatch):
    target_venv = tmp_path / "mineru-venv"
    target_venv.mkdir()
    _make_fake_venv(str(target_venv))
    monkeypatch.setattr(venv_manager, "MINERU_VENV", str(target_venv))
    monkeypatch.setattr(venv_manager, "current_venv_root", lambda: os.path.realpath(sys.prefix))

    assert venv_manager.restart_required_for_engine("mineru") is True


def test_restart_required_for_engine_false_when_already_active(tmp_path, monkeypatch):
    target_venv = tmp_path / "mineru-venv"
    target_venv.mkdir()
    _make_fake_venv(str(target_venv))
    monkeypatch.setattr(venv_manager, "MINERU_VENV", str(target_venv))
    monkeypatch.setattr(venv_manager, "current_venv_root", lambda: os.path.realpath(str(target_venv)))

    assert venv_manager.restart_required_for_engine("mineru") is False
