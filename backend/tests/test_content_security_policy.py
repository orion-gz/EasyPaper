"""Desktop and served frontend CSP settings must stay restrictive and aligned."""

import json
from pathlib import Path

from main import FRONTEND_CSP


def test_tauri_and_frontend_csp_match():
    repo_root = Path(__file__).resolve().parents[2]
    config = json.loads((repo_root / "src-tauri" / "tauri.conf.json").read_text())

    assert config["app"]["security"]["csp"] == FRONTEND_CSP


def test_frontend_csp_blocks_unsafe_embedding_and_plugins():
    assert "default-src 'self'" in FRONTEND_CSP
    assert "object-src 'none'" in FRONTEND_CSP
    assert "frame-ancestors 'none'" in FRONTEND_CSP
    assert "http://127.0.0.1:*" in FRONTEND_CSP
