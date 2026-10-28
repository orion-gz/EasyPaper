"""The sidecar must support stdlib imports from post-install parser packages."""
import importlib.util
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

BACKEND = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("parser_stdlib", BACKEND / "packaging/parser_stdlib.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


def test_parser_dependencies_are_collected():
    from parser_stdlib_check import MODULES
    modules = collector.parser_stdlib_modules()
    assert set(MODULES) <= set(modules)
    assert modules == sorted(set(modules))
    assert "unittest" in modules
    assert "tkinter" not in modules
    assert "test" not in modules


def test_enumeration_does_not_import_packages_and_skips_unavailable_modules(tmp_path, monkeypatch):
    package = tmp_path / "sample"
    package.mkdir()
    (package / "__init__.py").write_text('raise RuntimeError("must not execute")')
    (package / "child.py").write_text('raise RuntimeError("must not execute")')
    (package / "tests").mkdir()
    (package / "tests/test_sample.py").write_text("")
    monkeypatch.setattr(sys, "stdlib_module_names", frozenset({"sample", "unavailable"}))
    monkeypatch.setattr(collector.importlib.util, "find_spec", lambda name:
                        SimpleNamespace(submodule_search_locations=[str(package)])
                        if name == "sample" else None)
    assert collector.parser_stdlib_modules() == ["sample", "sample.child"]


def test_smoke_dispatch_runs_before_server_startup():
    result = subprocess.run(
        [sys.executable, str(BACKEND / "main.py"), "--easypaper-check-parser-stdlib"],
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert "Parser stdlib smoke check passed" in result.stdout
    assert "Uvicorn running" not in result.stderr
