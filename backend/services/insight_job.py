"""Cancellable page insight jobs with cost estimates and progress."""
from __future__ import annotations
import asyncio
from datetime import datetime, timezone

from services.library import get_page_insight, save_page_insight
from services.llm_client import stream_page_insight

_running_tasks: dict[tuple[str, str], asyncio.Task] = {}
_job_status: dict[tuple[str, str], dict] = {}
VALID_JOB_KINDS = {"keywords", "summary"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _eligible_pages(session_id: str, pages: list, kind: str, suffix: str) -> list:
    return [p for p in pages if (p.get("text") or "").strip() and not get_page_insight(session_id, int(p["page_num"]), kind, suffix)]


def estimate_insight_job(session_id: str, pages: list, target_lang: str, kind: str,
                         document_mode: str = "research", document_type: str = "research_paper",
                         source_lang: str = "auto") -> dict:
    if kind not in VALID_JOB_KINDS:
        raise ValueError("unsupported insight job kind")
    from services.document_policy import insight_cache_suffix
    suffix = insight_cache_suffix(document_mode, document_type, target_lang, source_lang)
    eligible = _eligible_pages(session_id, pages, kind, suffix)
    return {
        "kind": kind,
        "total_pages": len(pages),
        "eligible_pages": len(eligible),
        "cached_or_empty_pages": len(pages) - len(eligible),
        "estimated_calls": len(eligible),
        "requires_confirmation": len(eligible) > 20,
    }


def get_insight_job_status(session_id: str, kind: str) -> dict | None:
    value = _job_status.get((session_id, kind))
    return dict(value) if value else None


def cancel_insight_job(session_id: str, kind: str) -> bool:
    key = (session_id, kind)
    task = _running_tasks.get(key)
    if task and not task.done():
        task.cancel()
        status = _job_status.get(key, {})
        status.update({"status": "cancelled", "updated_at": _now()})
        return True
    return False


def start_keyword_job(session_id: str, pages: list, target_lang: str, doc_title: str,
                      document_mode: str = "research", document_type: str = "research_paper", source_lang: str = "auto") -> dict:
    return _start_insight_job(session_id, pages, target_lang, doc_title, "keywords", document_mode, document_type, source_lang)


def start_summary_job(session_id: str, pages: list, target_lang: str, doc_title: str,
                      document_mode: str = "research", document_type: str = "research_paper", source_lang: str = "auto") -> dict:
    return _start_insight_job(session_id, pages, target_lang, doc_title, "summary", document_mode, document_type, source_lang)


def _start_insight_job(session_id: str, pages: list, target_lang: str, doc_title: str, kind: str,
                       document_mode: str = "research", document_type: str = "research_paper", source_lang: str = "auto") -> dict:
    from services.library import get_document
    from services.processing_policy import ensure_processing_allowed
    document = get_document(session_id)
    if document:
        ensure_processing_allowed(document, "insight")
    if kind not in VALID_JOB_KINDS:
        raise ValueError("unsupported insight job kind")
    key = (session_id, kind)
    cancel_insight_job(session_id, kind)
    estimate = estimate_insight_job(session_id, pages, target_lang, kind, document_mode, document_type, source_lang)
    status = {
        **estimate, "session_id": session_id, "status": "running", "completed_pages": 0,
        "failed_pages": [], "started_at": _now(), "updated_at": _now(),
    }
    _job_status[key] = status
    task = asyncio.create_task(_run_insight_job(
        session_id, pages, target_lang, doc_title, kind, key, document_mode, document_type, source_lang,
    ))
    _running_tasks[key] = task
    return dict(status)


async def _run_insight_job(session_id: str, pages: list, target_lang: str, doc_title: str,
                           kind: str, task_key: tuple[str, str], document_mode: str,
                           document_type: str, source_lang: str = "auto") -> None:
    from services.document_policy import insight_cache_suffix
    suffix = insight_cache_suffix(document_mode, document_type, target_lang, source_lang)
    status = _job_status[task_key]
    try:
        eligible = _eligible_pages(session_id, pages, kind, suffix)
        for page_data in eligible:
            page_num = int(page_data["page_num"])
            text = (page_data.get("text") or "").strip()
            try:
                result = []
                async for token in stream_page_insight(
                    kind, text, target_lang=target_lang, doc_title=doc_title,
                    document_mode=document_mode, document_type=document_type, session_id=session_id, source_lang=source_lang,
                ):
                    result.append(token)
                content = "".join(result).strip()
                if content:
                    if document_mode == "general" and kind == "keywords":
                        import json
                        from services.vocabulary import validate_vocabulary_result
                        content = json.dumps(validate_vocabulary_result(content, text, page_num), ensure_ascii=False)
                    save_page_insight(session_id, page_num, kind, content, suffix)
                status["completed_pages"] += 1
            except Exception:
                status["failed_pages"].append(page_num)
            status["updated_at"] = _now()
        status["status"] = "completed" if not status["failed_pages"] else "completed_with_errors"
    except asyncio.CancelledError:
        status["status"] = "cancelled"
        raise
    finally:
        status["updated_at"] = _now()
        if _running_tasks.get(task_key) is asyncio.current_task():
            _running_tasks.pop(task_key, None)
        from services.observability import record_document_mode_event
        record_document_mode_event(
            "system", "vocabulary" if kind == "keywords" else "overview",
            document_mode, document_type, status=status["status"],
            numeric_value=status["completed_pages"],
        )
