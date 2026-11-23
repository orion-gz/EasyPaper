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
