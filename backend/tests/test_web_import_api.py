from pathlib import Path

from services.web_import import FetchResult


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
    response = test_client.post("/api/import-url", json={"url": "https://example.test/article", "translation_mode": "manual"})
    assert response.status_code == 200, response.text
    body = response.json(); doc_id = body["session_id"]
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
