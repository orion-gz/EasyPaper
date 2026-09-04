"""Persistent document task state, page checkpoints, and retry policy."""
from __future__ import annotations

import asyncio
import json
import random
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Iterable, Optional, TypeVar

import httpx

from services.db import get_db

TASK_KINDS = {"parse", "translate", "keywords", "summary", "primer", "chapter_summary", "full_summary"}
TASK_STATUSES = {"queued", "running", "retry_wait", "succeeded", "partial_failed", "failed", "cancelled"}
PAGE_STATUSES = {"queued", "running", "retry_wait", "succeeded", "failed", "cancelled"}
RECOVERABLE_STATUSES = {"queued", "running", "retry_wait"}
BACKOFF_SECONDS = (2, 10, 30)
T = TypeVar("T")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _decode_task(row: sqlite3.Row, pages: list[sqlite3.Row]) -> dict:
    task = dict(row)
    task["options"] = json.loads(task.get("options") or "{}")
    task["cancel_requested"] = bool(task.get("cancel_requested"))
    task["pages"] = [dict(page) for page in pages]
    task["total_pages"] = len(pages)
    task["completed_pages"] = [p["page_num"] for p in task["pages"] if p["status"] == "succeeded"]
    task["failed_pages"] = [p["page_num"] for p in task["pages"] if p["status"] == "failed"]
    task["current_page"] = next((p["page_num"] for p in task["pages"] if p["status"] == "running"), None)
    return task


def create_task(doc_id: str, kind: str, options: Optional[dict] = None,
                page_numbers: Optional[Iterable[int]] = None, max_attempts: int = 3,
                task_id: Optional[str] = None, status: str = "queued") -> dict:
    if kind not in TASK_KINDS:
        raise ValueError("unsupported document task kind")
    if status not in TASK_STATUSES:
        raise ValueError("unsupported document task status")
    task_id = task_id or str(uuid.uuid4())
    now = _now()
    pages = sorted({int(page) for page in (page_numbers or []) if int(page) > 0})
    with get_db() as conn:
        conn.execute(
            """INSERT INTO document_tasks
               (id, doc_id, kind, status, options, attempt_count, max_attempts,
                cancel_requested, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?)""",
            (task_id, doc_id, kind, status, json.dumps(options or {}, ensure_ascii=False),
             max(1, int(max_attempts)), now, now),
        )
        conn.executemany(
            """INSERT INTO document_task_pages
               (task_id, page_num, status, attempt_count, updated_at)
               VALUES (?, ?, 'queued', 0, ?)""",
            [(task_id, page, now) for page in pages],
        )
        conn.commit()
    return get_task(task_id)


def get_task(task_id: str) -> Optional[dict]:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM document_tasks WHERE id = ?", (task_id,)).fetchone()
        if not row:
            return None
        pages = conn.execute(
            "SELECT * FROM document_task_pages WHERE task_id = ? ORDER BY page_num", (task_id,),
        ).fetchall()
    return _decode_task(row, pages)


def list_tasks(doc_id: Optional[str] = None) -> list[dict]:
    with get_db() as conn:
        if doc_id:
            rows = conn.execute(
                "SELECT id FROM document_tasks WHERE doc_id = ? ORDER BY created_at DESC", (doc_id,),
            ).fetchall()
        else:
            rows = conn.execute("SELECT id FROM document_tasks ORDER BY created_at DESC").fetchall()
    return [task for row in rows if (task := get_task(row["id"]))]


def latest_task(doc_id: str, kind: str) -> Optional[dict]:
    with get_db() as conn:
        row = conn.execute(
            "SELECT id FROM document_tasks WHERE doc_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1",
            (doc_id, kind),
        ).fetchone()
    return get_task(row["id"]) if row else None


def update_task(task_id: str, *, status: Optional[str] = None,
                last_error_code: Optional[str] = None, next_retry_at: Optional[str] = None,
                increment_attempt: bool = False, cancel_requested: Optional[bool] = None) -> dict:
    if status is not None and status not in TASK_STATUSES:
        raise ValueError("unsupported document task status")
    assignments = ["updated_at = ?", "last_error_code = ?", "next_retry_at = ?"]
    params: list[object] = [_now(), last_error_code, next_retry_at]
    if status is not None:
        assignments.append("status = ?")
        params.append(status)
    if increment_attempt:
        assignments.append("attempt_count = attempt_count + 1")
    if cancel_requested is not None:
        assignments.append("cancel_requested = ?")
        params.append(1 if cancel_requested else 0)
    params.append(task_id)
    with get_db() as conn:
        cursor = conn.execute(f"UPDATE document_tasks SET {', '.join(assignments)} WHERE id = ?", params)
        if cursor.rowcount != 1:
            raise ValueError("document task not found")
        conn.commit()
    return get_task(task_id)


def update_page(task_id: str, page_num: int, status: str, *,
                last_error_code: Optional[str] = None, next_retry_at: Optional[str] = None,
                increment_attempt: bool = False) -> dict:
    if status not in PAGE_STATUSES:
        raise ValueError("unsupported document task page status")
    assignments = ["status = ?", "last_error_code = ?", "next_retry_at = ?", "updated_at = ?"]
    params: list[object] = [status, last_error_code, next_retry_at, _now()]
    if increment_attempt:
        assignments.append("attempt_count = attempt_count + 1")
    params.extend([task_id, int(page_num)])
    with get_db() as conn:
        cursor = conn.execute(
            f"UPDATE document_task_pages SET {', '.join(assignments)} WHERE task_id = ? AND page_num = ?", params,
        )
        if cursor.rowcount != 1:
            raise ValueError("document task page not found")
        conn.execute("UPDATE document_tasks SET updated_at = ? WHERE id = ?", (_now(), task_id))
        conn.commit()
    return get_task(task_id)


def finish_from_pages(task_id: str) -> dict:
    task = get_task(task_id)
    if not task:
        raise ValueError("document task not found")
    statuses = {page["status"] for page in task["pages"]}
    if task["cancel_requested"] or statuses == {"cancelled"}:
        status = "cancelled"
    elif "failed" in statuses and "succeeded" in statuses:
        status = "partial_failed"
    elif "failed" in statuses:
        status = "failed"
    elif not statuses or statuses <= {"succeeded"}:
        status = "succeeded"
    else:
        status = task["status"]
    return update_task(task_id, status=status, last_error_code=task.get("last_error_code"))


def request_cancel(task_id: str) -> dict:
    task = update_task(task_id, status="cancelled", cancel_requested=True)
    with get_db() as conn:
        conn.execute(
            "UPDATE document_task_pages SET status = 'cancelled', updated_at = ? WHERE task_id = ? AND status IN ('queued','running','retry_wait')",
            (_now(), task_id),
        )
        conn.commit()
    return get_task(task_id)


def reset_failed(task_id: str) -> dict:
    task = get_task(task_id)
    if not task:
        raise ValueError("document task not found")
    if task["status"] not in {"failed", "partial_failed", "cancelled"}:
        raise ValueError("only failed or cancelled tasks can be retried")
    with get_db() as conn:
        conn.execute(
            """UPDATE document_task_pages SET status = 'queued', last_error_code = NULL,
               next_retry_at = NULL, updated_at = ? WHERE task_id = ? AND status IN ('failed','cancelled')""",
            (_now(), task_id),
        )
        conn.execute(
            """UPDATE document_tasks SET status = 'queued', last_error_code = NULL,
               next_retry_at = NULL, cancel_requested = 0, updated_at = ? WHERE id = ?""",
            (_now(), task_id),
        )
        conn.commit()
    return get_task(task_id)


def recoverable_tasks() -> list[dict]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id FROM document_tasks WHERE status IN ('queued','running','retry_wait') ORDER BY created_at",
        ).fetchall()
    return [task for row in rows if (task := get_task(row["id"]))]


def classify_error(exc: Exception) -> tuple[str, bool]:
    status_code = getattr(exc, "status_code", None)
    response = getattr(exc, "response", None)
    if response is not None:
        status_code = getattr(response, "status_code", status_code)
    text = str(exc).lower()
    if status_code == 429:
        return "rate_limited", True
    if isinstance(status_code, int) and status_code >= 500:
        return "provider_unavailable", True
    if isinstance(exc, (httpx.TimeoutException, TimeoutError, asyncio.TimeoutError)):
        return "timeout", True
    if isinstance(exc, (httpx.NetworkError, ConnectionError)):
        return "network_error", True
    if status_code in {401, 403} or any(token in text for token in ("api key", "authentication", "unauthorized")):
        return "authentication_failed", False
    if any(token in text for token in ("unsupported model", "model not found", "invalid model")):
        return "unsupported_model", False
    return "generation_failed", False


async def retry_async(operation: Callable[[], Awaitable[T]], *, max_attempts: int = 3,
                      on_retry: Optional[Callable[[int, str, str], None]] = None,
                      sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
                      jitter: Callable[[], float] = random.random) -> T:
    attempts = max(1, int(max_attempts))
    for attempt in range(1, attempts + 1):
        try:
            return await operation()
        except Exception as exc:
            code, transient = classify_error(exc)
            if not transient or attempt >= attempts:
                setattr(exc, "document_task_error_code", code)
                raise
            delay = BACKOFF_SECONDS[min(attempt - 1, len(BACKOFF_SECONDS) - 1)] + jitter()
            retry_at = (datetime.now(timezone.utc) + timedelta(seconds=delay)).isoformat()
            if on_retry:
                on_retry(attempt, code, retry_at)
            await sleep(delay)
    raise RuntimeError("retry loop exhausted")


async def wait_for_retry(task_id: str, sleep: Callable[[float], Awaitable[None]] = asyncio.sleep) -> bool:
    """Wait for a persisted retry deadline and stop if the task was cancelled."""
    task = get_task(task_id)
    if not task or task["cancel_requested"] or task["status"] == "cancelled":
        return False
    retry_at = task.get("next_retry_at")
    if retry_at:
        try:
            deadline = datetime.fromisoformat(retry_at.replace("Z", "+00:00"))
            delay = max(0.0, (deadline - datetime.now(timezone.utc)).total_seconds())
        except (TypeError, ValueError):
            delay = 0.0
        if delay:
            await sleep(delay)
    task = get_task(task_id)
    return bool(task and not task["cancel_requested"] and task["status"] != "cancelled")


def migrate_legacy_translation(doc_id: str, legacy: dict) -> dict:
    existing = latest_task(doc_id, "translate")
    if existing:
        return existing
    target_pages = legacy.get("target_pages") or list(range(1, int(legacy.get("total_pages", 0)) + 1))
    old_status = legacy.get("status", "running")
    status = "running" if old_status == "running" else "succeeded"
    task = create_task(doc_id, "translate", legacy.get("options") or {}, target_pages,
                       task_id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"easypaper:legacy:{doc_id}")), status=status)
    completed = set(legacy.get("completed_pages") or [])
    failed = set(legacy.get("failed_pages") or [])
    for page in target_pages:
        if page in completed:
            update_page(task["id"], page, "succeeded")
        elif page in failed:
            update_page(task["id"], page, "failed", last_error_code="legacy_generation_failed")
    if failed:
        update_task(task["id"], status="partial_failed" if completed else "failed")
    return get_task(task["id"])


def legacy_translation_view(task: dict) -> dict:
    status_map = {
        "queued": "running", "running": "running", "retry_wait": "running",
        "succeeded": "completed", "partial_failed": "completed_with_errors", "failed": "failed", "cancelled": "cancelled",
    }
    return {
        "task_id": task["id"], "session_id": task["doc_id"],
        "status": status_map[task["status"]], "task_status": task["status"],
        "total_pages": task["total_pages"],
        "target_pages": [page["page_num"] for page in task["pages"]],
        "completed_pages": task["completed_pages"], "failed_pages": task["failed_pages"],
        "options": task["options"], "last_error_code": task.get("last_error_code"),
        "next_retry_at": task.get("next_retry_at"), "updated_at": task["updated_at"],
    }


def recover_document_tasks(sessions: dict) -> None:
    """Requeue incomplete durable work after sessions have been restored."""
    for task in recoverable_tasks():
        if task["kind"] == "parse":
            from services.parse_job import resume_parse_task
            resume_parse_task(task["id"], sessions)
            continue
        session = sessions.get(task["doc_id"])
        if not session:
            continue
        if task["kind"] == "translate":
            continue
        if task["kind"] in {"keywords", "summary"}:
            from services.insight_job import start_keyword_job, start_summary_job
            starter = start_keyword_job if task["kind"] == "keywords" else start_summary_job
            options = task["options"]
            starter(
                task["doc_id"], session["pages"], options.get("target_lang", "ko"),
                session.get("metadata", {}).get("title") or session.get("filename", ""),
                session.get("document_mode", "research"), session.get("document_type", "research_paper"),
                options.get("source_lang", "auto"), durable_task_id=task["id"],
            )
        elif task["kind"] == "primer":
            from routers.primer import _ensure_generation_started
            options = task["options"]
            _ensure_generation_started(
                task["doc_id"], options.get("target_lang", "ko"), options.get("source_lang", "auto"),
                session, session.get("username", "admin"), durable_task_id=task["id"],
            )
        elif task["kind"] in {"chapter_summary", "full_summary"}:
            from services.chapter_summaries import recover_summary_task
            from services.db import db_get_document
            document = db_get_document(task["doc_id"])
            if document:
                recover_summary_task(
                    task, document, session["pages"], session.get("pdf_path", document.get("pdf_path", "")),
                )
