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
    assert "frame-ancestors 'self'" in FRONTEND_CSP
    assert "http://127.0.0.1:*" in FRONTEND_CSP


def test_direct_html_and_fallback_responses_include_embedding_policy(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from main import frontend_file_response

    index = tmp_path / "index.html"
    index.write_text("<!doctype html><title>Workspace</title>")
    app = FastAPI()

    @app.get("/")
    @app.get("/index.html")
    @app.get("/viewer")
    def frontend():
        return frontend_file_response(str(index))

    client = TestClient(app)
    for path in ["/", "/index.html", "/viewer"]:
        response = client.get(path)
        assert response.status_code == 200
        assert response.headers["content-security-policy"] == FRONTEND_CSP
        assert "no-store" in response.headers["cache-control"]
