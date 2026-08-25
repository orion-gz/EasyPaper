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
    if value:
        return dict(value)
    from services.document_tasks import latest_task
    task = latest_task(session_id, kind)
    if not task:
        return None
    return {
        "task_id": task["id"], "session_id": session_id, "kind": kind,
        "status": task["status"], "completed_pages": len(task["completed_pages"]),
        "failed_pages": task["failed_pages"], "total_pages": task["total_pages"],
        "next_retry_at": task.get("next_retry_at"), "last_error_code": task.get("last_error_code"),
        "updated_at": task["updated_at"],
    }


def cancel_insight_job(session_id: str, kind: str) -> bool:
    key = (session_id, kind)
    task = _running_tasks.get(key)
    if task and not task.done():
        task.cancel()
        status = _job_status.get(key, {})
        status.update({"status": "cancelled", "updated_at": _now()})
        if status.get("task_id"):
            from services.document_tasks import request_cancel
            request_cancel(status["task_id"])
        return True
    return False


def start_keyword_job(session_id: str, pages: list, target_lang: str, doc_title: str,
                      document_mode: str = "research", document_type: str = "research_paper", source_lang: str = "auto", durable_task_id: str | None = None) -> dict:
    return _start_insight_job(session_id, pages, target_lang, doc_title, "keywords", document_mode, document_type, source_lang, durable_task_id)


def start_summary_job(session_id: str, pages: list, target_lang: str, doc_title: str,
                      document_mode: str = "research", document_type: str = "research_paper", source_lang: str = "auto", durable_task_id: str | None = None) -> dict:
    return _start_insight_job(session_id, pages, target_lang, doc_title, "summary", document_mode, document_type, source_lang, durable_task_id)


def _start_insight_job(session_id: str, pages: list, target_lang: str, doc_title: str, kind: str,
                       document_mode: str = "research", document_type: str = "research_paper", source_lang: str = "auto",
                       durable_task_id: str | None = None) -> dict:
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
    from services.document_tasks import create_task, get_task, update_task
    options = {"target_lang": target_lang, "source_lang": source_lang,
               "document_mode": document_mode, "document_type": document_type}
    durable = get_task(durable_task_id) if durable_task_id else None
    if durable is None:
        eligible_pages = [int(page["page_num"]) for page in _eligible_pages(
            session_id, pages, kind,
            __import__("services.document_policy", fromlist=["insight_cache_suffix"]).insight_cache_suffix(
                document_mode, document_type, target_lang, source_lang,
            ),
        )]
        durable = create_task(session_id, kind, options, eligible_pages, status="running")
    else:
        update_task(durable["id"], status="retry_wait" if durable.get("next_retry_at") else "running",
                    cancel_requested=False, last_error_code=durable.get("last_error_code"),
                    next_retry_at=durable.get("next_retry_at"))
    status = {
        **estimate, "task_id": durable["id"], "session_id": session_id,
        "status": "retry_wait" if durable.get("next_retry_at") else "running", "completed_pages": 0,
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
        from services.document_tasks import update_task, wait_for_retry
        if not await wait_for_retry(status["task_id"]):
            status["status"] = "cancelled"
            return
        update_task(status["task_id"], status="running", next_retry_at=None)
        eligible = _eligible_pages(session_id, pages, kind, suffix)
        for page_data in eligible:
            page_num = int(page_data["page_num"])
            text = (page_data.get("text") or "").strip()
            try:
                from services.document_tasks import retry_async, update_page, update_task
                durable_id = status["task_id"]
                update_page(durable_id, page_num, "running", increment_attempt=True)

                async def generate_page():
                    result = []
                    async for token in stream_page_insight(
                        kind, text, target_lang=target_lang, doc_title=doc_title,
                        document_mode=document_mode, document_type=document_type,
                        session_id=session_id, source_lang=source_lang,
                    ):
                        result.append(token)
                    return "".join(result).strip()

                def record_retry(_attempt: int, code: str, retry_at: str) -> None:
                    status.update({"status": "retry_wait", "last_error_code": code,
                                   "next_retry_at": retry_at, "updated_at": _now()})
                    update_page(durable_id, page_num, "retry_wait", last_error_code=code,
                                next_retry_at=retry_at, increment_attempt=True)
                    update_task(durable_id, status="retry_wait", last_error_code=code,
                                next_retry_at=retry_at)

                content = await retry_async(generate_page, on_retry=record_retry)
                status.update({"status": "running", "last_error_code": None, "next_retry_at": None})
                if content:
                    if document_mode == "general" and kind == "keywords":
                        import json
                        from services.vocabulary import validate_vocabulary_result
                        content = json.dumps(validate_vocabulary_result(content, text, page_num), ensure_ascii=False)
                    save_page_insight(session_id, page_num, kind, content, suffix)
                status["completed_pages"] += 1
                update_page(status["task_id"], page_num, "succeeded")
            except Exception as exc:
                code = getattr(exc, "document_task_error_code", "generation_failed")
                status["failed_pages"].append(page_num)
                update_page(status["task_id"], page_num, "failed", last_error_code=code)
            status["updated_at"] = _now()
        status["status"] = "completed" if not status["failed_pages"] else "completed_with_errors"
        from services.document_tasks import finish_from_pages
        finish_from_pages(status["task_id"])
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
