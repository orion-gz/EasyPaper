"""venv_manager.py 순수 로직 테스트. 실제 venv 생성/실행 없이, 가짜
디렉터리 구조(bin/python 존재 여부)만으로 판단 분기를 검증한다."""
import os
import sys

import pytest

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


@pytest.mark.parametrize(
    ("platform_name", "expected_parts"),
    [
        ("darwin", ("bin", "python")),
        ("linux", ("bin", "python")),
        ("win32", ("Scripts", "python.exe")),
    ],
)
def test_venv_python_is_platform_aware(monkeypatch, platform_name, expected_parts):
    monkeypatch.setattr(venv_manager.sys, "platform", platform_name)
    path = venv_manager.venv_python("/parser-venv")
    assert path == os.path.join("/parser-venv", *expected_parts)


def test_packaged_desktop_installs_outside_read_only_bundle(tmp_path, monkeypatch):
    app_data = tmp_path / "app-data"
    monkeypatch.setattr(venv_manager.sys, "frozen", True, raising=False)
    monkeypatch.setenv("EASYPAPER_DESKTOP", "1")
    monkeypatch.setenv("EASYPAPER_CONFIG_DIR", str(app_data))

    command = venv_manager.parser_install_command("marker")

    assert venv_manager.is_packaged_desktop() is True
    assert command == [
        sys.executable,
        "--easypaper-install-pdf-parser",
        "marker",
    ]
    assert venv_manager.parser_packages_dir("marker") == str(
        app_data / "pdf-parser-packages" / "marker"
    )
    assert "-m" not in command


def test_packaged_installer_atomically_publishes_verified_package(tmp_path, monkeypatch):
    import pip._internal.cli.main as pip_cli

    monkeypatch.setenv("EASYPAPER_CONFIG_DIR", str(tmp_path))

    def fake_pip_main(args):
        staging = args[args.index("--target") + 1]
        os.makedirs(os.path.join(staging, "pdfplumber"))
        return 0

    monkeypatch.setattr(pip_cli, "main", fake_pip_main)

    result = venv_manager.run_packaged_parser_installer(
        ["--easypaper-install-pdf-parser", "pdfplumber"]
    )

    assert result == 0
    assert venv_manager.is_parser_installed("pdfplumber") is True
    assert not list((tmp_path / "pdf-parser-packages").glob(".pdfplumber-install-*"))


def test_packaged_installer_keeps_existing_package_when_upgrade_fails(
    tmp_path, monkeypatch
):
    import pip._internal.cli.main as pip_cli

    monkeypatch.setenv("EASYPAPER_CONFIG_DIR", str(tmp_path))
    existing = tmp_path / "pdf-parser-packages" / "marker" / "marker"
    existing.mkdir(parents=True)

    monkeypatch.setattr(pip_cli, "main", lambda _args: 1)

    result = venv_manager.run_packaged_parser_installer(
        ["--easypaper-install-pdf-parser", "marker"]
    )

    assert result == 1
    assert existing.is_dir()
    assert not list((tmp_path / "pdf-parser-packages").glob(".marker-install-*"))


def test_packaged_parser_activation_and_restart_decision(tmp_path, monkeypatch):
    app_data = tmp_path / "app-data"
    package_dir = app_data / "pdf-parser-packages" / "mineru"
    (package_dir / "mineru").mkdir(parents=True)

    monkeypatch.setattr(venv_manager.sys, "frozen", True, raising=False)
    monkeypatch.setenv("EASYPAPER_DESKTOP", "1")
    monkeypatch.setenv("EASYPAPER_CONFIG_DIR", str(app_data))
    monkeypatch.setattr(venv_manager, "_active_engine", "pymupdf")

    assert venv_manager.restart_required_for_engine("mineru") is True

    original_path = list(sys.path)
    try:
        venv_manager.relaunch_into_required_venv("mineru")
        assert sys.path[0] == str(package_dir)
        assert venv_manager.restart_required_for_engine("mineru") is False
        assert venv_manager.restart_required_for_engine("pymupdf") is True
    finally:
        sys.path[:] = original_path
        venv_manager._active_engine = "pymupdf"



def test_packaged_installer_configures_windows_streams_as_utf8(monkeypatch):
    class FakeStream:
        def __init__(self):
            self.config = None
            self.output = []

        def reconfigure(self, **kwargs):
            self.config = kwargs

        def write(self, value):
            self.output.append(value)
            return len(value)

        def flush(self):
            return None

    stdout = FakeStream()
    stderr = FakeStream()
    monkeypatch.setattr(venv_manager.sys, "platform", "win32")
    monkeypatch.setattr(venv_manager.sys, "stdout", stdout)
    monkeypatch.setattr(venv_manager.sys, "stderr", stderr)

    result = venv_manager.run_packaged_parser_installer(
        ["--easypaper-install-pdf-parser", "unsupported"]
    )

    assert result == 2
    assert stdout.config == {"encoding": "utf-8", "errors": "replace"}
    assert stderr.config == {"encoding": "utf-8", "errors": "replace"}
