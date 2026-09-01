from pathlib import Path

import pytest

from services.web_import import FetchResult


@pytest.fixture(autouse=True)
def reset_upload_rate_limit():
    from services.rate_limiter import request_rate_limiter
    request_rate_limiter.reset()
    yield
    request_rate_limiter.reset()


ARTICLE = ("<!doctype html><html><head><title>Imported article</title>"
           "<meta name='author' content='Ada Author'><meta property='article:published_time' content='2026-01-02'>"
           "</head><body><article><h1>Imported article</h1><p>" +
           "Readable article content for translation and search. " * 20 +
           "</p><h2>Second section</h2><p>More useful details for the reader.</p></article></body></html>").encode()


def test_import_html_endpoint_is_atomic_and_serves_manifest(test_client, isolated_dirs, monkeypatch):
    from routers import web_import as router
    from routers import upload
    monkeypatch.setattr(router, "LIBRARY_DIR", str(isolated_dirs["library_dir"]))
    monkeypatch.setattr(router, "UPLOAD_DIR", str(isolated_dirs["upload_dir"]))
    monkeypatch.setattr(router, "fetch_url", lambda url: FetchResult("web_article", url, "text/html", {}, content=ARTICLE))
    upload_id = "123e4567-e89b-42d3-a456-426614174010"
    response = test_client.post("/api/import-url", json={"url": "https://example.test/article", "upload_id": upload_id, "translation_mode": "manual"})
    assert response.status_code == 200, response.text
    body = response.json(); doc_id = body["session_id"]
    assert doc_id == upload_id
    assert body["content_kind"] == "html_article"
    assert body["source_origin"] == "web"
    assert body["total_units"] >= 1
    doc = isolated_dirs["db"].db_get_document(doc_id)
    assert doc["content_kind"] == "html_article"
    assert Path(doc["pdf_path"]).is_file()
    manifest = test_client.get(f"/api/library/{doc_id}/article")
    assert manifest.status_code == 200
    assert manifest.json()["author"] == "Ada Author"
    upload.sessions.pop(doc_id, None)


def test_import_failure_leaves_no_document_or_directory(test_client, isolated_dirs, monkeypatch):
    from routers import web_import as router
    monkeypatch.setattr(router, "LIBRARY_DIR", str(isolated_dirs["library_dir"]))
    monkeypatch.setattr(router, "UPLOAD_DIR", str(isolated_dirs["upload_dir"]))
    monkeypatch.setattr(router, "fetch_url", lambda url: FetchResult("web_article", url, "text/html", {}, content=b"<html><p>short</p></html>"))
    before = set(isolated_dirs["library_dir"].iterdir())
    response = test_client.post("/api/import-url", json={"url": "https://example.test/empty", "translation_mode": "manual"})
    assert response.status_code == 422
    assert set(isolated_dirs["library_dir"].iterdir()) == before
    assert isolated_dirs["db"].db_list_documents("testuser") == []


def test_import_rejects_invalid_client_upload_id(test_client):
    response = test_client.post(
        "/api/import-url",
        json={"url": "https://example.test/article", "upload_id": "not-a-uuid"},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "invalid_upload_id"


def test_import_remote_pdf_uses_client_id_and_finishes_parse(test_client, isolated_dirs, monkeypatch, tmp_path):
    import fitz
    from routers import primer
    from routers import upload
    from routers import web_import as router

    source = tmp_path / "remote.pdf"
    document = fitz.open()
    page = document.new_page()
    page.insert_text((72, 72), "Remote PDF body text for import recovery testing.")
    document.save(source)
    document.close()

    monkeypatch.setattr(router, "LIBRARY_DIR", str(isolated_dirs["library_dir"]))
    monkeypatch.setattr(router, "UPLOAD_DIR", str(isolated_dirs["upload_dir"]))
    monkeypatch.setattr(router, "fetch_url", lambda url: FetchResult(
        "remote_pdf", url, "application/pdf", {}, temp_path=str(source),
    ))
    monkeypatch.setattr(primer, "_ensure_generation_started", lambda *args, **kwargs: None)
    upload_id = "123e4567-e89b-42d3-a456-426614174011"
    response = test_client.post("/api/import-url", json={
        "url": "https://example.test/remote.pdf",
        "upload_id": upload_id,
        "translation_mode": "manual",
    })
    assert response.status_code == 200, response.text
    assert response.json()["session_id"] == upload_id
    assert response.json()["content_kind"] == "pdf"
    assert isolated_dirs["db"].db_get_document(upload_id)["source_origin"] == "web"
    upload.sessions.pop(upload_id, None)
