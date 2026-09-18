import os
from types import SimpleNamespace

import fitz
import pytest

from services import pdf_text_recovery as recovery
from services.pdf_parser import _extract_page


def test_cid_values_are_not_treated_as_unicode():
    class Page:
        def get_text(self, mode, *, flags):
            assert not flags & fitz.TEXT_CID_FOR_UNKNOWN_UNICODE
            return "Linux " + "\ufffd" * 20
    assert recovery.needs_text_recovery(Page())


@pytest.mark.parametrize("text", ["", "Greek Ελληνικά", "日本語の正常な文章です。", "العربية", "a" * 1000 + "\ufffd\ufffd\ufffd"])
def test_valid_scripts_and_sparse_missing_symbols_do_not_trigger_ocr(text):
    class Page:
        def get_text(self, *_args, **_kwargs):
            return text
    assert not recovery.needs_text_recovery(Page())


def test_missing_ocr_never_sends_corrupted_text_to_translation(monkeypatch):
    with fitz.open() as doc:
        page = doc.new_page()
        page.insert_text((72, 72), "Wrong glyph IDs")
        monkeypatch.setattr(recovery, "needs_text_recovery", lambda page: True)
        def fail(*args):
            raise recovery.TextRecoveryError("pdf_ocr_unavailable")
        monkeypatch.setattr(recovery, "recover_text", fail)
        result = _extract_page(page, 1)
    assert result["text"] == ""
    assert result["text_layer"] == []
    assert result["text_recovery_error"] == "pdf_ocr_unavailable"


def test_recovered_text_and_viewer_coordinates_share_one_source(monkeypatch):
    with fitz.open() as doc:
        page = doc.new_page()
        page.insert_text((72, 72), "Recovered text")
        raw = page.get_text("dict")
        monkeypatch.setattr(recovery, "needs_text_recovery", lambda page: True)
        monkeypatch.setattr(recovery, "recover_text", lambda *_args: raw)
        result = _extract_page(page, 1)
    assert "Recovered text" in result["text"]
    assert result["text_recovery"] == "ocr"
    assert result["text_layer"][0]["bbox"] == list(raw["blocks"][0]["lines"][0]["spans"][0]["bbox"])


def test_pages_sharing_fonts_select_their_own_script(monkeypatch):
    monkeypatch.delenv("EASYPAPER_OCR_LANGUAGES", raising=False)
    monkeypatch.setattr(recovery, "_ocr_config", lambda: ("/models", ["eng", "jpn", "kor"]))
    scripts = iter([b"Script: Japanese\n", b"Script: Korean\n"])
    monkeypatch.setattr(recovery.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout=next(scripts)))
    selected = []
    class Page:
        def get_pixmap(self, **kwargs):
            return SimpleNamespace(tobytes=lambda *a: b"png")
        def get_textpage_ocr(self, **kwargs):
            selected.append(kwargs["language"])
            return SimpleNamespace(extractDICT=lambda **kw: {"blocks": [
                {"lines": [{"spans": [{"text": "Recovered text"}]}]}]})
    context = {}
    recovery.recover_text(Page(), context)
    recovery.recover_text(Page(), context)
    assert selected == ["jpn+eng", "kor+eng"]


def test_recovery_endpoint_is_owned(test_client, monkeypatch):
    from routers import upload
    monkeypatch.setitem(upload.sessions, "recovery-doc", {
        "username": "testuser", "pages": [{"page_num": 1, "text_recovery": "ocr",
        "text_layer": [{"text": "日本語", "bbox": [10, 20, 50, 30]}]}],
    })
    response = test_client.get("/api/pdf-text/recovery-doc/1")
    assert response.status_code == 200
    assert response.json()["spans"][0]["text"] == "日本語"
    assert test_client.get("/api/pdf-text/recovery-doc/2").status_code == 404
    upload.sessions["recovery-doc"]["username"] = "someone-else"
    assert test_client.get("/api/pdf-text/recovery-doc/1").status_code in {403, 404}


@pytest.mark.parametrize("source", ["auto", "ja"])
def test_failed_ocr_explains_recovery_instead_of_wrong_language(test_client, monkeypatch, source):
    from routers import upload
    monkeypatch.setitem(upload.sessions, "failed-ocr", {
        "username": "testuser", "detected_source_language": "und", "total_pages": 1,
        "pages": [{"page_num": 1, "text": "", "text_recovery": "failed",
                   "text_recovery_error": "pdf_ocr_unavailable"}],
    })
    response = test_client.get(f"/api/translate/failed-ocr/1?source_lang={source}")
    assert response.status_code == 422
    assert response.json()["code"] == "pdf_ocr_unavailable"


@pytest.mark.parametrize("source", ["auto", "ja"])
def test_recovered_japanese_reaches_translation_with_correct_source(test_client, monkeypatch, source):
    from routers import upload, translate
    text = "Linux の基本ソフトについて学習します。"
    monkeypatch.setitem(upload.sessions, "translated-ocr", {
        "username": "testuser", "detected_source_language": "ja", "total_pages": 1,
        "metadata": {}, "pages": [{"page_num": 1, "text": text, "text_recovery": "ocr"}],
    })
    received = []
    async def stream(value, **kwargs):
        received.append((value, kwargs["source_lang"]))
        yield "[S0] Linux의 기본 소프트웨어를 학습합니다."
    monkeypatch.setattr(translate, "stream_translation", stream)
    monkeypatch.setattr(translate, "get_trans_provider", lambda: "ollama")
    monkeypatch.setattr(translate, "lib_save_translation", lambda *a, **k: None)
    response = test_client.get(f"/api/translate/translated-ocr/1?source_lang={source}&ignore_math=true")
    assert response.status_code == 200
    assert received and received[0][1] == "ja" and text in received[0][0]
    assert '"done": true' in response.text


def test_rebuilt_cache_corrects_old_greek_detection(isolated_dirs, tmp_path, monkeypatch):
    from routers import upload
    monkeypatch.setattr(upload, "sessions", {})
    path = tmp_path / "old-japanese.pdf"
    with fitz.open() as doc:
        doc.new_page()
        doc.save(path)
    isolated_dirs["db"].db_save_document(
        "old-japanese", "testuser", "old-japanese.pdf", str(path), 1, {},
        source_language="ja", detected_source_language="el",
    )
    text = "本研究では、多言語文書の言語を安定して判定する方法を提案しました。" * 8
    monkeypatch.setattr(upload, "extract_pages", lambda *a, **k: [{"page_num": 1, "text": text, "text_recovery": "ocr"}])
    assert upload.ensure_session("old-japanese")
    stored = isolated_dirs["db"].db_get_document("old-japanese")
    assert stored["detected_source_language"] == "ja"
    assert stored["source_language"] == "ja"
    assert upload.sessions["old-japanese"]["detected_source_language"] == "ja"


@pytest.mark.skipif(not os.environ.get("EASYPAPER_TEST_JAPANESE_PDF"), reason="User PDF is not redistributed")
def test_linux_textbook_real_ocr():
    from services.languages import detect_document_language
    with fitz.open(os.environ["EASYPAPER_TEST_JAPANESE_PDF"]) as doc:
        assert recovery.needs_text_recovery(doc[10])
        result = _extract_page(doc[10], 11)
    assert result["text_recovery"] == "ocr"
    assert "Linux" in result["text"] and "基本ソフト" in result["text"]
    assert detect_document_language([result])["language"] == "ja"
