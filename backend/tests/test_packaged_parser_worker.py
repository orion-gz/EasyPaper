import json
import os
from pathlib import Path
import subprocess
import sys

import fitz


def test_frozen_worker_uses_dispatch_flag(monkeypatch):
    from services import reparse
    import venv_manager
    monkeypatch.setattr(venv_manager, 'is_packaged_desktop', lambda: True)
    monkeypatch.setattr(sys, 'executable', '/bundle/easypaper-backend')
    command, _ = reparse._worker_command('pymupdf', '/input.pdf', '/output.json')
    assert command == ['/bundle/easypaper-backend', '--easypaper-parser-worker', '--pdf', '/input.pdf', '--engine', 'pymupdf', '--output', '/output.json']


def test_server_entry_dispatches_real_parser_without_starting_http(tmp_path):
    source = tmp_path / 'source.pdf'
    document = fitz.open(); page = document.new_page()
    page.insert_text((72, 72), 'Packaged worker parses this document.')
    document.save(source); document.close()
    output = tmp_path / 'output.json'
    backend = Path(__file__).resolve().parents[1]
    result = subprocess.run([sys.executable, str(backend / 'main.py'), '--easypaper-parser-worker', '--pdf', str(source), '--engine', 'pymupdf', '--output', str(output)], timeout=30, capture_output=True,
                            env={**os.environ, 'EASYPAPER_CONFIG_DIR': str(tmp_path)})
    assert result.returncode == 0, result.stderr.decode()
    payload = json.loads(output.read_text())
    assert payload['parser_engine'] == 'pymupdf'
    assert 'Packaged worker' in payload['pages'][0]['text']
    assert 'Uvicorn running' not in result.stderr.decode()


def test_packaged_workers_use_selected_dependencies_after_switching(tmp_path):
    """Fresh workers must not mix server or previously selected engine packages."""
    bundle = tmp_path / 'bundle'
    bundle.mkdir()
    (bundle / 'parser_dependency.py').write_text("SOURCE = 'bundle'\n")
    for engine in ('marker', 'mineru'):
        package = tmp_path / 'pdf-parser-packages' / engine
        (package / engine).mkdir(parents=True)
        (package / 'parser_dependency.py').write_text(f"SOURCE = '{engine}'\n")
    backend = Path(__file__).resolve().parents[1]
    script = '''
import sys
import venv_manager
sys.path.insert(0, sys.argv[1])
# Simulate startup with the previously selected engine in the search path.
venv_manager._activate_packaged_parser(sys.argv[2])
venv_manager._activate_packaged_parser(sys.argv[3], worker=True)
import parser_dependency
assert parser_dependency.SOURCE == sys.argv[3]
assert venv_manager.parser_packages_dir(sys.argv[2]) not in sys.path
'''
    for previous, selected in (('marker', 'mineru'), ('mineru', 'marker')):
        result = subprocess.run(
            [sys.executable, '-c', script, str(bundle), previous, selected],
            cwd=backend, env={**os.environ, 'EASYPAPER_CONFIG_DIR': str(tmp_path)},
            capture_output=True, text=True, timeout=15,
        )
        assert result.returncode == 0, result.stderr


def test_multiprocessing_dispatch_precedes_server_and_parser_imports(tmp_path):
    backend = Path(__file__).resolve().parents[1]
    script = """
import multiprocessing
import runpy
import sys

def dispatch():
    assert 'config' not in sys.modules
    assert 'parser_worker' not in sys.modules
    print('multiprocessing dispatched')
    raise SystemExit(0)

multiprocessing.freeze_support = dispatch
sys.argv = [sys.argv[1], '--multiprocessing-fork']
runpy.run_path(sys.argv[0], run_name='__main__')
"""
    result = subprocess.run([sys.executable, '-c', script, str(backend / 'main.py')],
                            cwd=backend, capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert 'multiprocessing dispatched' in result.stdout
