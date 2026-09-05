"""Durable PDF parsing and upload finalization."""
from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timezone
from typing import Callable, Optional

from config import UPLOAD_DIR
from services.document_tasks import get_task, update_task

LONG_DOCUMENT_PAGE_THRESHOLD = 50
_running_parse_tasks: dict[str, asyncio.Task] = {}


def _source_path(doc_id: str, configured_path: str | None, upload_root: str) -> str:
    expected = os.path.realpath(os.path.join(upload_root, doc_id, "document.pdf"))
    actual = os.path.realpath(configured_path or expected)
    if actual != expected:
        raise ValueError("invalid_parse_source_path")
    if not os.path.isfile(actual):
        raise FileNotFoundError("parse_source_missing")
    return actual


async def execute_parse_task(
    task_id: str,
    sessions: dict,
    *,
    page_extractor: Optional[Callable] = None,
    metadata_reader: Optional[Callable] = None,
    translation_starter: Optional[Callable] = None,
    primer_starter: Optional[Callable] = None,
    keyword_starter: Optional[Callable] = None,
    summary_starter: Optional[Callable] = None,
    upload_root: str | None = None,
) -> dict:
    """Parse one persisted upload and finish every document-facing artifact."""
    upload_root = upload_root or UPLOAD_DIR
    task = get_task(task_id)
    if not task or task["kind"] != "parse":
        raise ValueError("parse_task_not_found")
    if task["cancel_requested"] or task["status"] == "cancelled":
        raise asyncio.CancelledError
    if int(task["attempt_count"]) >= int(task["max_attempts"]):
        update_task(task_id, status="failed", last_error_code="parse_attempts_exhausted")
        raise RuntimeError("parse_attempts_exhausted")

    options = task["options"]
    doc_id = task["doc_id"]
    try:
        pdf_path = _source_path(doc_id, options.get("pdf_path"), upload_root)
    except ValueError:
        update_task(task_id, status="failed", last_error_code="invalid_parse_source_path")
        raise
    except FileNotFoundError:
        update_task(task_id, status="failed", last_error_code="parse_source_missing")
        raise

    if metadata_reader is None or page_extractor is None:
        from services.pdf_parser import extract_pages, get_pdf_metadata
        metadata_reader = metadata_reader or get_pdf_metadata
        page_extractor = page_extractor or extract_pages

    update_task(
        task_id, status="running", last_error_code=None,
        next_retry_at=None, increment_attempt=True,
    )
    try:
        metadata, pages = await asyncio.gather(
            asyncio.to_thread(metadata_reader, pdf_path),
            asyncio.to_thread(page_extractor, pdf_path),
        )
        if not isinstance(pages, list):
            raise ValueError("invalid_parser_output")
    except asyncio.CancelledError:
        update_task(task_id, status="cancelled", cancel_requested=True)
        raise
    except Exception:
        update_task(task_id, status="failed", last_error_code="invalid_pdf")
        raise

    from services.languages import detect_document_language
    detection = detect_document_language(pages)
    source_lang = options.get("source_lang", "auto")
    target_lang = options.get("target_lang", "ko")
    detected_source_language = str(detection["language"])
    resolved_source_language = source_lang if source_lang != "auto" else detected_source_language
    source_supported = bool(detection["supported"]) if source_lang == "auto" else True
    active_parser_engine = (pages[0].get("parser_engine") or "pymupdf") if pages else "pymupdf"
    from services.pdf_diagnostics import diagnose_pages, parser_version
    active_parser_version = parser_version(active_parser_engine)
    classification_status = "pending" if options.get("classification_method", "ai") == "ai" else "confirmed"

    try:
        from services.library import get_document, get_pdf_path, save_document
        existing = get_document(doc_id)
        if existing:
            from services.db import db_finalize_document_parse
            db_finalize_document_parse(
                doc_id, len(pages), metadata, detected_source_language,
                float(detection["confidence"]), active_parser_engine, active_parser_version,
            )
            persistent_pdf_path = get_pdf_path(doc_id)
            if not persistent_pdf_path or not os.path.isfile(persistent_pdf_path):
                raise FileNotFoundError("persisted_pdf_missing")
        else:
            save_document(
                doc_id, options.get("filename") or "document.pdf", pdf_path,
                len(pages), metadata, username=options.get("username", "admin"),
                document_mode=options.get("document_mode", "research"),
                document_type=options.get("document_type", "research_paper"),
                source_language=source_lang,
                detected_source_language=detected_source_language,
                source_language_confidence=float(detection["confidence"]),
                preferred_target_language=target_lang,
                content_revision=1, parser_engine=active_parser_engine,
                parser_version=active_parser_version,
                classification_status=classification_status,
            )
            persistent_pdf_path = get_pdf_path(doc_id)

        from services.cache import save_images_cache, save_pages_cache
        save_pages_cache(
            doc_id, persistent_pdf_path, pages, active_parser_engine,
            active_parser_version, strict=True,
        )
        detected_images = []
        try:
            from services.pdf_parser import extract_pdf_images
            detected_images = await asyncio.to_thread(
                extract_pdf_images, persistent_pdf_path, active_parser_engine,
            )
            save_images_cache(
                doc_id, persistent_pdf_path, detected_images,
                active_parser_engine, active_parser_version, strict=True,
            )
        except Exception:
            detected_images = []

        initial_report = diagnose_pages(
            pages, detected_images, active_parser_engine, active_parser_version,
        )
        from services.db import get_db
        with get_db() as conn:
            conn.execute(
                """INSERT OR REPLACE INTO parsing_diagnostics
                   (doc_id, content_revision, parser_engine, parser_version, report, created_at)
                   VALUES (?, 1, ?, ?, ?, ?)""",
                (
                    doc_id, active_parser_engine, active_parser_version,
                    json.dumps(initial_report, ensure_ascii=False),
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
            conn.commit()

        from services.context_retrieval import index_document_chunks
        indexed_chunks = index_document_chunks(doc_id, pages)
        if not existing:
            from services.observability import record_document_mode_event
            record_document_mode_event(
                options.get("username", "admin"), "upload",
                options.get("document_mode", "research"),
                options.get("document_type", "research_paper"),
                numeric_value=len(pages), status="indexed" if indexed_chunks else "fallback",
            )
    except asyncio.CancelledError:
        update_task(task_id, status="cancelled", cancel_requested=True)
        raise
    except Exception:
        update_task(task_id, status="failed", last_error_code="parse_persistence_failed")
        raise

    sessions[doc_id] = {
        "pdf_path": pdf_path,
        "filename": options.get("filename") or "document.pdf",
        "pages": pages,
        "total_pages": len(pages),
        "metadata": metadata,
        "from_library": False,
        "username": options.get("username", "admin"),
        "document_mode": options.get("document_mode", "research"),
        "document_type": options.get("document_type", "research_paper"),
        "classification_status": classification_status,
        "source_language": source_lang,
        "detected_source_language": detected_source_language,
        "source_language_confidence": detection["confidence"],
        "preferred_target_language": target_lang,
        "processing_policy": "inherit",
        "content_revision": 1,
        "parser_engine": active_parser_engine,
        "parser_version": active_parser_version,
    }

    translation_skipped_reason = None
    if not source_supported:
        translation_skipped_reason = "unsupported_source_language"
    elif resolved_source_language == target_lang:
        translation_skipped_reason = "same_source_and_target_language"
    sessions[doc_id]["translation_skipped_reason"] = translation_skipped_reason

    from services.document_tasks import latest_task
    if translation_starter is None:
        from services.translation_job import start_job
        translation_starter = start_job
    if (
        False and latest_task(doc_id, "translate") is None
        and options.get("translation_mode", "auto") == "auto"
        and len(pages) < LONG_DOCUMENT_PAGE_THRESHOLD
        and translation_skipped_reason is None
    ):
        translation_starter(
            doc_id, pages, target_lang=target_lang,
            source_lang=resolved_source_language,
            style=options.get("style", "academic"),
            ignore_math=bool(options.get("ignore_math", False)),
            ignore_table=bool(options.get("ignore_table", True)),
            ignore_refs=bool(options.get("ignore_refs", False)),
        )

    if primer_starter is None:
        from routers.primer import _ensure_generation_started
        primer_starter = _ensure_generation_started
    if keyword_starter is None or summary_starter is None:
        from services.insight_job import start_keyword_job, start_summary_job
        keyword_starter = keyword_starter or start_keyword_job
        summary_starter = summary_starter or start_summary_job

    async def _run_followups() -> None:
        try:
            if (
                options.get("document_mode", "research") == "research"
                and latest_task(doc_id, "primer") is None
            ):
                primer_starter(
                    doc_id, target_lang, resolved_source_language, sessions[doc_id],
                    options.get("username", "admin"),
                )
        except Exception as exc:
            print(f"[Upload {doc_id}] Primer 생성 실패: {exc}")
        if (
            options.get("keyword_mode", "manual") == "auto"
            and latest_task(doc_id, "keywords") is None
        ):
            if options.get("document_mode", "research") != "general" or len(pages) <= 20:
                keyword_starter(
                    doc_id, pages, target_lang,
                    metadata.get("title") or options.get("filename", "document.pdf"),
                    options.get("document_mode", "research"),
                    options.get("document_type", "research_paper"),
                    resolved_source_language,
                )
        if (
            options.get("summary_mode", "manual") == "auto"
            and latest_task(doc_id, "summary") is None
        ):
            summary_starter(
                doc_id, pages, target_lang,
                metadata.get("title") or options.get("filename", "document.pdf"),
                options.get("document_mode", "research"),
                options.get("document_type", "research_paper"),
                resolved_source_language,
            )

    # Only an explicit AI choice starts classification. Manual selections are final.
    if options.get("classification_method", "ai") == "ai":
        from services.document_classification import start_classification_task
        start_classification_task(
            doc_id, metadata.get("title") or options.get("filename", "document.pdf"), pages,
        )
    await asyncio.sleep(0)
    update_task(task_id, status="succeeded", last_error_code=None)
    if classification_status == "confirmed":
        start_processing_after_classification(doc_id, sessions)
    return {
        "session_id": doc_id,
        "filename": options.get("filename") or "document.pdf",
        "total_pages": len(pages),
        "file_size_mb": float(options.get("file_size_mb") or 0),
        "metadata": metadata,
        "document_mode": options.get("document_mode", "research"),
        "document_type": options.get("document_type", "research_paper"),
        "classification_status": classification_status,
        "source_language": source_lang,
        "detected_source_language": detected_source_language,
        "source_language_confidence": float(detection["confidence"]),
        "preferred_target_language": target_lang,
        "translation_skipped_reason": translation_skipped_reason,
    }


def resume_parse_task(task_id: str, sessions: dict, **execute_kwargs) -> asyncio.Task | None:
    """Resume an orphaned upload directly from its server-owned source file."""
    existing = _running_parse_tasks.get(task_id)
    if existing is not None and not existing.done():
        return existing
    task = get_task(task_id)
    if not task or task["status"] not in {"queued", "running", "retry_wait"}:
        return None
    worker = asyncio.create_task(execute_parse_task(task_id, sessions, **execute_kwargs))
    _running_parse_tasks[task_id] = worker

    def _finished(done: asyncio.Task) -> None:
        _running_parse_tasks.pop(task_id, None)
        try:
            done.result()
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

    worker.add_done_callback(_finished)
    return worker


def start_processing_after_classification(doc_id: str, sessions: dict) -> None:
    """Idempotently start deferred AI work after the user confirms a type."""
    from services.document_tasks import latest_task
    from services.db import db_get_document
    session = sessions.get(doc_id)
    doc = db_get_document(doc_id)
    if not session or not doc:
        return
    options = (latest_task(doc_id, "parse") or {}).get("options") or session.get("processing_options") or {}
    source = session.get("source_language", "auto")
    resolved = session.get("detected_source_language", source) if source == "auto" else source
    target = session.get("preferred_target_language") or options.get("target_lang", "ko")
    pages = session["pages"]
    if (
        options.get("translation_mode", "auto") == "auto"
        and len(pages) < LONG_DOCUMENT_PAGE_THRESHOLD
        and resolved not in {"und", "mul", target}
        and latest_task(doc_id, "translate") is None
    ):
        from services.translation_job import start_job
        start_job(doc_id, pages, target_lang=target, source_lang=resolved, style=options.get("style", "academic"), ignore_math=bool(options.get("ignore_math", False)), ignore_table=bool(options.get("ignore_table", True)), ignore_refs=bool(options.get("ignore_refs", False)))
    if latest_task(doc_id, "primer") is None:
        from routers.primer import _ensure_generation_started
        _ensure_generation_started(doc_id, target, resolved, session, doc["username"])
    title = session.get("metadata", {}).get("title") or session.get("filename", "document.pdf")
    if options.get("keyword_mode") == "auto" and latest_task(doc_id, "keywords") is None:
        from services.insight_job import start_keyword_job
        start_keyword_job(doc_id, pages, target, title, doc["document_mode"], doc["document_type"], resolved)
    if options.get("summary_mode") == "auto" and latest_task(doc_id, "summary") is None:
        from services.insight_job import start_summary_job
        start_summary_job(doc_id, pages, target, title, doc["document_mode"], doc["document_type"], resolved)
