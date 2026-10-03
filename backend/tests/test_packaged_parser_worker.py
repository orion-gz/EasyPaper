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
