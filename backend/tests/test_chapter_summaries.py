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
