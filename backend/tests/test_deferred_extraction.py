import asyncio
import fitz
import pytest


def _make_pdf(path, pages=2):
    doc = fitz.open()
    for index in range(pages):
        page = doc.new_page()
        page.insert_text((72, 72), f"Page {index} of a plain English document about parsing.")
    doc.save(str(path))


@pytest.mark.asyncio
async def test_upload_defers_extraction_until_document_is_opened(isolated_dirs, monkeypatch):
    from routers import upload
    from services import parse_job, pdf_parser
    from services.db import db_get_document
    from services.document_tasks import create_task, get_task

    doc_id = "deferred-doc"
    source_dir = isolated_dirs["upload_dir"] / doc_id
    source_dir.mkdir()
    _make_pdf(source_dir / "document.pdf")
    monkeypatch.setattr(upload, "sessions", {})
    monkeypatch.setattr(parse_job, "UPLOAD_DIR", str(isolated_dirs["upload_dir"]))
    started = []
    monkeypatch.setattr(parse_job, "start_processing_after_classification",
                        lambda doc, sessions: started.append(doc))
    # The upload phase must not run the (slow) page extractor at all.
    real_extract = pdf_parser.extract_pages
    monkeypatch.setattr(pdf_parser, "extract_pages",
                        lambda *a, **k: pytest.fail("extraction ran during upload"))
    task = create_task(doc_id, "parse", {
        "filename": "d.pdf", "username": "testuser", "document_mode": "general",
        "document_type": "report", "source_lang": "en", "target_lang": "ko",
        "classification_method": "manual", "defer_extraction": True, "parser_engine": "pymupdf",
    })
    result = await parse_job.execute_parse_task(
        task["id"], upload.sessions, upload_root=str(isolated_dirs["upload_dir"]),
        metadata_reader=pdf_parser.get_pdf_metadata, page_extractor=pdf_parser.extract_pages,
    )
    assert get_task(task["id"])["status"] == "succeeded"
    assert result["total_pages"] == 2
    assert doc_id not in upload.sessions and not started
    assert db_get_document(doc_id)["metadata"][parse_job.EXTRACTION_DEFERRED] is True

    monkeypatch.setattr(pdf_parser, "extract_pages", real_extract)  # open phase extracts
    assert upload.ensure_session(doc_id)
    assert upload.sessions[doc_id]["pages"][0]["layout"]["rule_version"]
    await parse_job.finalize_deferred_document(doc_id)
    await parse_job.finalize_deferred_document(doc_id)  # idempotent

    document = db_get_document(doc_id)
    assert parse_job.EXTRACTION_DEFERRED not in document["metadata"]
    assert document["detected_source_language"] == "en"
    assert started == [doc_id]


@pytest.mark.parametrize("engine", ["marker", "mineru"])
@pytest.mark.asyncio
async def test_upload_defers_isolated_parser_until_document_is_opened(isolated_dirs, monkeypatch, engine):
    from routers import upload
    from services import cache, parse_job, pdf_parser, reparse
    from services.db import db_get_document
    from services.document_tasks import create_task, get_task

    doc_id = f"deferred-{engine}"
    source_dir = isolated_dirs["upload_dir"] / doc_id
    source_dir.mkdir()
    _make_pdf(source_dir / "document.pdf")
    monkeypatch.setattr(upload, "sessions", {})
    monkeypatch.setattr(parse_job, "UPLOAD_DIR", str(isolated_dirs["upload_dir"]))
    started = []
    monkeypatch.setattr(parse_job, "start_processing_after_classification",
                        lambda doc, sessions: started.append(doc))

    calls = []

    def fake_isolated(path, selected, *, normalize_layout=True):
        calls.append(selected)
        return {
            "parser_engine": selected,
            "parser_version": f"{selected}-1.0",
            "pages": [{"page_num": 1, "text": "Page 1 of a plain English document about parsing and layout.", "blocks": [], "parser_engine": selected}],
            "images": [{"page": 1, "type": "figure", "bbox_percent": {"x": 10, "y": 10, "width": 50, "height": 40}}],
        }

    monkeypatch.setattr(reparse, "parse_document_isolated", fake_isolated)
    monkeypatch.setattr(pdf_parser, "extract_pdf_images",
                        lambda *a, **k: pytest.fail("extract_pdf_images called for isolated parser"))

    task = create_task(doc_id, "parse", {
        "filename": "isolated.pdf", "username": "testuser", "document_mode": "general",
        "document_type": "report", "source_lang": "en", "target_lang": "ko",
        "classification_method": "manual", "defer_extraction": True, "parser_engine": engine,
    })
    result = await parse_job.execute_parse_task(
        task["id"], upload.sessions, upload_root=str(isolated_dirs["upload_dir"]),
        metadata_reader=pdf_parser.get_pdf_metadata, page_extractor=pdf_parser.extract_pages,
    )
    assert get_task(task["id"])["status"] == "succeeded"
    assert result["total_pages"] == 2
    assert calls == []
    assert doc_id not in upload.sessions and not started
    assert db_get_document(doc_id)["metadata"][parse_job.EXTRACTION_DEFERRED] is True

    assert upload.ensure_session(doc_id)
    assert calls == [engine]
    assert upload.sessions[doc_id]["parser_engine"] == engine
    assert upload.sessions[doc_id]["parser_version"] == f"{engine}-1.0"
    await parse_job.finalize_deferred_document(doc_id)
    assert calls == [engine]  # finalize reuses the images cache saved during restore

    document = db_get_document(doc_id)
    assert parse_job.EXTRACTION_DEFERRED not in document["metadata"]
    assert document["parser_version"] == f"{engine}-1.0"
    assert document["detected_source_language"] == "en"
    assert cache.get_cached_images(doc_id, upload.sessions[doc_id]["pdf_path"], engine, f"{engine}-1.0")
    assert started == [doc_id]


@pytest.mark.asyncio
async def test_ai_classification_upload_is_deferred_and_reports_progress_on_open(isolated_dirs, monkeypatch):
    from routers import upload
    from services import document_classification, document_preparation, parse_job, pdf_parser
    from services.db import db_get_document
    from services.document_tasks import create_task, get_task, latest_task

    doc_id = "deferred-ai-classify"
    source_dir = isolated_dirs["upload_dir"] / doc_id
    source_dir.mkdir()
    _make_pdf(source_dir / "document.pdf", pages=3)
    monkeypatch.setattr(upload, "sessions", {})
    monkeypatch.setattr(document_preparation, "_tasks", {})
    monkeypatch.setattr(document_preparation, "_progress", {})
    monkeypatch.setattr(parse_job, "UPLOAD_DIR", str(isolated_dirs["upload_dir"]))

    classify_calls = []
    monkeypatch.setattr(
        document_classification, "start_classification_task",
        lambda doc, title, pages, **kw: classify_calls.append((doc, len(pages))),
    )
    real_extract = pdf_parser.extract_pages
    monkeypatch.setattr(pdf_parser, "extract_pages",
                        lambda *a, **k: pytest.fail("extraction ran during AI-classified upload"))

    task = create_task(doc_id, "parse", {
        "filename": "ai.pdf", "username": "testuser", "document_mode": "research",
        "document_type": "research_paper", "source_lang": "en", "target_lang": "ko",
        "classification_method": "ai", "defer_extraction": True, "parser_engine": "pymupdf",
    })
    result = await parse_job.execute_parse_task(
        task["id"], upload.sessions, upload_root=str(isolated_dirs["upload_dir"]),
        metadata_reader=pdf_parser.get_pdf_metadata, page_extractor=pdf_parser.extract_pages,
    )
    assert get_task(task["id"])["status"] == "succeeded"
    assert result["classification_status"] == "pending"
    assert classify_calls == []
    assert latest_task(doc_id, "classification") is None
    doc = db_get_document(doc_id)
    assert doc["classification_status"] == "pending"
    assert doc["metadata"][parse_job.EXTRACTION_DEFERRED] is True

    monkeypatch.setattr(pdf_parser, "extract_pages", real_extract)
    status = document_preparation.start_preparation(doc)
    assert status["status"] == "running"
    assert "percent" in status
    await asyncio.gather(*document_preparation._tasks.values())

    ready = document_preparation.preparation_status(db_get_document(doc_id))
    assert ready["status"] == "ready"
    assert ready["percent"] == 100
    assert classify_calls == [(doc_id, 3)]


