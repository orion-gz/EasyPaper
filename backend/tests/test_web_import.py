import httpx
import json
from pathlib import Path
import pytest

from services import web_import
from services.web_import import FetchResult, WebImportError


def test_rejects_private_and_nonstandard_urls(monkeypatch):
    monkeypatch.setattr(web_import.socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("127.0.0.1", 80))])
    with pytest.raises(WebImportError, match="사설") as exc:
        web_import._validate_url("http://example.test/article")
    assert exc.value.code == "blocked_address"
    with pytest.raises(WebImportError) as exc:
        web_import._validate_url("ftp://example.test/file")
    assert exc.value.code == "invalid_url"


def test_magic_bytes_override_content_type(monkeypatch):
    monkeypatch.setattr(web_import, "_validate_url", lambda url: None)
    transport = httpx.MockTransport(lambda request: httpx.Response(200, headers={"content-type": "application/octet-stream"}, content=b"%PDF-1.7\nbody", request=request))
    with httpx.Client(transport=transport) as client:
        result = web_import.fetch_url("https://example.test/download", client)
    assert result.kind == "remote_pdf"


def test_extracts_sanitized_stable_article_units(tmp_path):
    html = b"""<!doctype html><html><head><title>Useful article</title><link rel='canonical' href='/canonical'></head><body><article><h1>Useful article</h1><p onclick='bad()'>""" + (b"A useful paragraph. " * 20) + b"""</p><script>alert(1)</script><h2>Details</h2><p>Second section with enough meaningful content for extraction and translation.</p><a href='javascript:alert(1)'>bad</a></article></body></html>"""
    result = FetchResult("web_article", "https://example.test/post", "text/html", {"x-frame-options": "DENY"}, html)
    manifest, pages = web_import.extract_article(result, tmp_path / "article")
    assert manifest["canonical_url"] == "https://example.test/canonical"
    assert manifest["embed_allowed"] is False
    assert len(manifest["units"]) >= 1
    assert pages[0]["page_num"] == 1
    serialized = (tmp_path / "article" / "article.json").read_text()
    assert "<script" not in serialized
    assert "onclick" not in serialized
    assert "javascript:" not in serialized
    assert manifest["blocks"][0]["id"] == "block-1"


def test_fetch_streams_large_octet_pdf_to_temp_file(monkeypatch, tmp_path):
    monkeypatch.setattr(web_import, "_validate_url", lambda url: None)
    payload = b"%PDF-1.7\n" + b"x" * (11 * 1024 * 1024)
    transport = httpx.MockTransport(lambda request: httpx.Response(200, headers={"content-type": "application/octet-stream"}, content=payload, request=request))
    with httpx.Client(transport=transport) as client:
        result = web_import.fetch_url("https://example.test/download", client)
    try:
        assert result.kind == "remote_pdf"
        assert result.content is None
        assert result.temp_path and Path(result.temp_path).stat().st_size == len(payload)
    finally:
        result.cleanup()
    assert not Path(result.temp_path).exists()


def test_manifest_rebuilds_pages_without_cache(tmp_path):
    manifest = {"units": [{"index": 1, "id": "section-1", "title": "Intro", "text": "Recovered text"}]}
    path = tmp_path / "article.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    pages = web_import.pages_from_manifest(path)
    assert pages[0]["text"] == "Recovered text"
    assert pages[0]["unit_id"] == "section-1"
