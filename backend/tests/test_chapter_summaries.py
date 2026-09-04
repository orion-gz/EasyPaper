import json

import pytest

from services import chapter_summaries as summaries


def _document(**overrides):
    value = {
        "id": "doc-1", "total_pages": 6, "content_revision": 1,
        "document_type": "thesis", "content_kind": "pdf",
    }
    value.update(overrides)
    return value


def test_heading_detection_creates_real_ranges_when_toc_is_missing(monkeypatch):
    monkeypatch.setattr(summaries, "_pdf_outline", lambda *_: [])
    pages = [
        {"page_num": 1, "text": "Chapter 1 Introduction\nBody"},
        {"page_num": 2, "text": "Body"},
        {"page_num": 3, "text": "Chapter 2 Methods\nBody"},
        {"page_num": 6, "text": "Body"},
    ]
    result = summaries.detect_chapters(_document(), pages, "missing.pdf")
    assert result["status"] == "available"
    assert [(c["start_page"], c["end_page"]) for c in result["chapters"]] == [(1, 2), (3, 6)]
    assert all(c["source"] == "heading" for c in result["chapters"])


def test_no_toc_or_heading_is_explicitly_unavailable(monkeypatch):
    monkeypatch.setattr(summaries, "_pdf_outline", lambda *_: [])
    result = summaries.detect_chapters(_document(), [{"page_num": 1, "text": "plain text"}], "")
    assert result == {"status": "unavailable", "reason": "chapter_structure_unconfirmed", "chapters": []}


def test_empty_document_and_ocr_failure_do_not_invent_chapters(monkeypatch):
    monkeypatch.setattr(summaries, "_pdf_outline", lambda *_: [])
    assert summaries.detect_chapters(_document(total_pages=0), [], "")["reason"] == "empty_document"
    assert summaries.detect_chapters(_document(), [{"page_num": 1, "text": ""}], "")["chapters"] == []


def test_chapter_request_matches_number_and_title():
    chapters = [{"id": "a", "title": "Introduction"}, {"id": "b", "title": "방법론"}]
    assert summaries.match_chapter_request("2장 요약해줘", chapters)["id"] == "b"
    assert summaries.match_chapter_request("방법론 장 설명", chapters)["id"] == "b"


def test_cache_key_changes_with_revision_type_language_and_range(monkeypatch):
    seen = []
    monkeypatch.setattr(summaries, "get_page_insight", lambda *args, **kwargs: seen.append(kwargs["suffix"]) or None)
    chapter = {"id": "chapter", "start_page": 1, "end_page": 2}
    for document, lang in [
        (_document(), "ko"), (_document(content_revision=2), "ko"),
        (_document(document_type="manual"), "ko"), (_document(), "en"),
    ]:
        summaries.get_cached_chapter_summary(document, chapter, lang)
    chapter["end_page"] = 3
    summaries.get_cached_chapter_summary(_document(), chapter, "ko")
    assert len(set(seen)) == 5


def test_full_summary_estimate_reuses_cached_chapters(monkeypatch):
    chapters = [
        {"id": "a", "start_page": 1, "end_page": 2},
        {"id": "b", "start_page": 3, "end_page": 4},
    ]
    pages = [{"page_num": n, "text": "x" * 100} for n in range(1, 5)]
    monkeypatch.setattr(summaries, "get_cached_chapter_summary", lambda _d, c, _l: {"summary": "done"} if c["id"] == "a" else None)
    estimate = summaries.estimate_full_summary(_document(), pages, chapters, "ko")
    assert estimate["chapter_count"] == 2
    assert estimate["missing_chapter_count"] == 1
    assert estimate["estimated_llm_calls"] == 2
    assert estimate["estimated_input_tokens"] > 0


def test_chapter_input_is_capped_at_16000_characters():
    pages = [{"page_num": 1, "text": "x" * 30_000}]
    chapter = {"start_page": 1, "end_page": 1}
    assert len(summaries._chapter_text(pages, chapter)) == 16_000


@pytest.mark.asyncio
async def test_full_summary_requires_explicit_confirmation():
    from fastapi import HTTPException
    from routers.chapters import FullSummaryStartRequest, start_document_full_summary
    with pytest.raises(HTTPException) as error:
        await start_document_full_summary("doc", FullSummaryStartRequest(confirmed=False), "user")
    assert error.value.status_code == 400


@pytest.mark.asyncio
async def test_full_summary_status_uses_language_from_latest_task(monkeypatch):
    from routers import chapters as router
    seen = []
    monkeypatch.setattr(router, "require_owned_document", lambda *_: {"id": "doc", "preferred_target_language": "ko"})
    monkeypatch.setattr(router, "latest_full_summary_task", lambda *_: {"status": "succeeded", "options": {"target_lang": "en"}})
    monkeypatch.setattr(router, "get_cached_full_summary", lambda _doc, lang: seen.append(lang) or {"summary": "done"})
    response = await router.full_summary_status("doc", "user")
    assert seen == ["en"]
    assert response["target_lang"] == "en"
    assert response["status"] == "completed"


def test_real_pdf_toc_boundaries_take_precedence(tmp_path):
    import fitz
    pdf_path = tmp_path / "toc.pdf"
    document = fitz.open()
    for _ in range(6):
        document.new_page()
    document.set_toc([[1, "Chapter One", 1], [2, "Section 1.1", 2], [1, "Chapter Two", 4]])
    document.save(pdf_path)
    document.close()

    result = summaries.detect_chapters(_document(), [], str(pdf_path))
    assert result["status"] == "available"
    assert [(item["title"], item["start_page"], item["end_page"]) for item in result["chapters"]] == [
        ("Chapter One", 1, 3), ("Chapter Two", 4, 6),
    ]
    assert all(item["source"] == "toc" for item in result["chapters"])


@pytest.mark.asyncio
async def test_generated_chapter_summary_is_cached_and_normalized(isolated_dirs, monkeypatch):
    isolated_dirs["db"].db_save_document(
        "doc-1", "testuser", "paper.pdf", "/x.pdf", 2, {}, document_type="thesis",
    )
    async def fake_llm(*_args, **_kwargs):
        return [{"headline": "H", "summary": "S", "key_points": "invalid", "terms": [{"name": "T", "description": "D"}], "limitations": ["L"]}]
    monkeypatch.setattr("services.llm_client._llm_json_array_with_retry", fake_llm)
    document = _document(total_pages=2)
    chapter = {"id": "one", "title": "One", "start_page": 1, "end_page": 2, "source": "toc"}
    result = await summaries._generate_chapter(document, [{"page_num": 1, "text": "content"}], chapter, "ko", "doc-1")
    assert result["key_points"] == []
    assert result["terms"] == [{"term": "T", "definition": "D"}]
    assert summaries.get_cached_chapter_summary(document, chapter, "ko") == result
    assert summaries.get_cached_chapter_summary(_document(total_pages=2, content_revision=2), chapter, "ko") is None


@pytest.mark.asyncio
async def test_running_chapter_task_can_be_cancelled(isolated_dirs, monkeypatch):
    import asyncio
    from services.document_tasks import get_task, request_cancel
    isolated_dirs["db"].db_save_document("doc-1", "testuser", "paper.pdf", "/x.pdf", 1, {}, document_type="thesis")
    entered = asyncio.Event()
    async def slow_generate(*_args, **_kwargs):
        entered.set()
        await asyncio.Event().wait()
    monkeypatch.setattr(summaries, "_generate_chapter", slow_generate)
    chapter = {"id": "one", "title": "One", "start_page": 1, "end_page": 1, "source": "toc"}
    task = summaries.start_chapter_summary(_document(total_pages=1), [{"page_num": 1, "text": "content"}], chapter, "ko")
    await entered.wait()
    request_cancel(task["id"])
    assert summaries.cancel_summary_task(task["id"])
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert get_task(task["id"])["status"] == "cancelled"


def test_chapter_router_returns_cached_summary_without_starting(test_client, monkeypatch):
    from routers import chapters as router
    document = _document(id="route-doc", total_pages=2)
    chapter = {"id": "one", "title": "One", "start_page": 1, "end_page": 2, "source": "toc"}
    monkeypatch.setattr(router, "require_owned_document", lambda *_: document)
    monkeypatch.setattr(router, "require_session_owner", lambda *_: {"pages": [], "pdf_path": "/x.pdf"})
    monkeypatch.setattr(router, "detect_chapters", lambda *_: {"status": "available", "reason": None, "chapters": [chapter]})
    monkeypatch.setattr(router, "get_cached_chapter_summary", lambda *_: {"chapter": chapter, "summary": "cached"})
    response = test_client.get("/api/library/route-doc/chapters/one/summary")
    assert response.status_code == 200
    assert response.json()["status"] == "completed"
    assert response.json()["summary"]["summary"] == "cached"


def test_chapter_router_reports_unconfirmed_structure(test_client, monkeypatch):
    from routers import chapters as router
    monkeypatch.setattr(router, "require_owned_document", lambda *_: _document(id="route-doc"))
    monkeypatch.setattr(router, "require_session_owner", lambda *_: {"pages": [], "pdf_path": "/x.pdf"})
    monkeypatch.setattr(router, "detect_chapters", lambda *_: {"status": "unavailable", "reason": "chapter_structure_unconfirmed", "chapters": []})
    response = test_client.get("/api/library/route-doc/full-summary/estimate")
    assert response.status_code == 409
    assert response.json()["code"] == "chapter_structure_unconfirmed"
