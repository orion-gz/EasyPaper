"""Quiesce document workers before destructive changes or policy changes."""
import asyncio
from contextlib import asynccontextmanager

from fastapi import HTTPException

_mutating: set[str] = set()
_deleted: set[tuple[str, str]] = set()


def is_deleted(doc_id: str) -> bool:
    from services.db import DB_PATH
    return (DB_PATH, doc_id) in _deleted


def ensure_document_available(doc_id: str) -> None:
    if is_deleted(doc_id):
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다.")
    if doc_id in _mutating:
        raise HTTPException(status_code=409, detail="문서 작업을 정리 중입니다. 잠시 후 다시 시도해 주세요.")


def workers_for_document(doc_id: str) -> set[asyncio.Task]:
    from services import translation_job, insight_job, easy_english, chapter_summaries, document_classification, parse_job, reparse
    from routers import primer
    from services.document_tasks import list_tasks
    ids = {task['id'] for task in list_tasks(doc_id)}
    workers = {translation_job._running_tasks.get(doc_id)}
    workers.update(task for (document, _), task in insight_job._running_tasks.items() if document == doc_id)
    workers.update(task for (document, _), task in easy_english._running.items() if document == doc_id)
    for registry in (chapter_summaries._running, document_classification._running, parse_job._running_parse_tasks):
        workers.update(task for key, task in registry.items() if key in ids)
    workers.update(task for key, task in primer._pending_generations.items() if key.startswith(f'{doc_id}:'))
    for key, task in reparse._preview_workers.items():
        preview = reparse.get_preview(key)
        if preview and preview['doc_id'] == doc_id:
            workers.add(task)
    return {task for task in workers if task is not None and not task.done()}


def cancel_document_now(doc_id: str, *, deleted: bool = False) -> set[asyncio.Task]:
    """Also guard synchronous deletion callers against late worker writes."""
    if deleted:
        from services.db import DB_PATH
        _deleted.add((DB_PATH, doc_id))
    from services.document_tasks import list_tasks, request_cancel
    workers = workers_for_document(doc_id)
    for task in list_tasks(doc_id):
        if task['status'] in {'queued', 'running', 'retry_wait'}:
            request_cancel(task['id'])
            if task['kind'] == 'classification':
                from services.db import db_update_document_classification_recommendation
                db_update_document_classification_recommendation(doc_id, 'failed', error='classification_cancelled')
    for worker in workers:
        worker.cancel()
    return workers


@asynccontextmanager
async def quiesce_document(doc_id: str):
    ensure_document_available(doc_id)
    _mutating.add(doc_id)
    try:
        workers = cancel_document_now(doc_id)
        if workers:
            await asyncio.gather(*workers, return_exceptions=True)
        yield
    finally:
        _mutating.discard(doc_id)
