"""Restore analysis sessions without making PDF readers wait for OCR."""
import asyncio
import logging

_tasks: dict[tuple[str, str, int], asyncio.Task] = {}
_progress: dict[tuple[str, str, int], dict] = {}


def _key(document: dict) -> tuple[str, str, int]:
    from services.db import DB_PATH
    return DB_PATH, document['id'], int(document.get('content_revision') or 1)


def update_progress(
    doc_id: str,
    stage: str,
    percent: int,
    current_page: int | None = None,
    total_pages: int | None = None,
    content_revision: int = 1,
) -> None:
    from services.db import DB_PATH
    key = (DB_PATH, doc_id, int(content_revision or 1))
    info: dict = {'stage': stage, 'percent': max(0, min(99, int(percent)))}
    if current_page is not None:
        info['current_page'] = int(current_page)
    if total_pages is not None:
        info['total_pages'] = int(total_pages)
    _progress[key] = info


def preparation_status(document: dict) -> dict:
    from routers.upload import sessions
    session = sessions.get(document['id'])
    from services.parse_job import EXTRACTION_DEFERRED
    deferred = bool((document.get('metadata') or {}).get(EXTRACTION_DEFERRED))
    key = _key(document)
    if session and not deferred and int(session.get('content_revision') or 1) == key[2]:
        return {'status': 'ready', 'percent': 100}
    task = _tasks.get(key)
    if task is None:
        return {'status': 'not_started'}
    if not task.done():
        return {'status': 'running', **_progress.get(key, {'stage': 'extracting', 'percent': 5})}
    if task.cancelled():
        return {'status': 'failed', 'error_code': 'document_preparation_cancelled'}
    result = task.result()
    # Cache invalidation may have removed a previously restored session.
    return {'status': 'not_started'} if result['status'] == 'ready' else result


def start_preparation(document: dict, *, retry: bool = False) -> dict:
    from services.document_workers import ensure_document_available
    ensure_document_available(document['id'])
    status = preparation_status(document)
    if status['status'] in {'running', 'ready'} or (status['status'] == 'failed' and not retry):
        return status

    key = _key(document)
    total = int(document.get('total_pages') or 0)
    update_progress(document['id'], 'extracting', 5, 0, total, key[2])

    async def restore():
        from routers.upload import ensure_session
        try:
            if await asyncio.to_thread(ensure_session, document['id']):
                from services.parse_job import finalize_deferred_document
                await finalize_deferred_document(document['id'])
                _progress.pop(key, None)
                return {'status': 'ready', 'percent': 100}
        except Exception:
            logging.getLogger(__name__).exception('Document preparation failed: %s', document['id'])
        _progress.pop(key, None)
        return {'status': 'failed', 'error_code': 'document_preparation_failed'}

    _tasks[key] = asyncio.create_task(restore())
    return {'status': 'running', **_progress.get(key, {'stage': 'extracting', 'percent': 5})}


def workers_for_document(doc_id: str) -> set[asyncio.Task]:
    from services.db import DB_PATH
    return {task for (database, document, _), task in _tasks.items()
            if database == DB_PATH and document == doc_id and not task.done()}


async def shutdown():
    tasks = list(_tasks.values())
    _tasks.clear()
    _progress.clear()
    for task in tasks:
        if not task.done():
            task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
