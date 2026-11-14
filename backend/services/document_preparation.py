"""Restore analysis sessions without making PDF readers wait for OCR."""
import asyncio
import logging

_tasks: dict[tuple[str, str, int], asyncio.Task] = {}


def _key(document: dict) -> tuple[str, str, int]:
    from services.db import DB_PATH
    return DB_PATH, document['id'], int(document.get('content_revision') or 1)


def preparation_status(document: dict) -> dict:
    from routers.upload import sessions
    session = sessions.get(document['id'])
    if session and int(session.get('content_revision') or 1) == _key(document)[2]:
        return {'status': 'ready'}
    task = _tasks.get(_key(document))
    if task is None:
        return {'status': 'not_started'}
    if not task.done():
        return {'status': 'running'}
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

    async def restore():
        from routers.upload import ensure_session
        try:
            if await asyncio.to_thread(ensure_session, document['id']):
                return {'status': 'ready'}
        except Exception:
            logging.getLogger(__name__).exception('Document preparation failed: %s', document['id'])
        return {'status': 'failed', 'error_code': 'document_preparation_failed'}

    _tasks[_key(document)] = asyncio.create_task(restore())
    return {'status': 'running'}


def workers_for_document(doc_id: str) -> set[asyncio.Task]:
    from services.db import DB_PATH
    return {task for (database, document, _), task in _tasks.items()
            if database == DB_PATH and document == doc_id and not task.done()}


async def shutdown():
    tasks = list(_tasks.values())
    _tasks.clear()
    for task in tasks:
        if not task.done():
            task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
