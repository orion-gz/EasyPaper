import asyncio
import threading
import time

import pytest
from fastapi import HTTPException


@pytest.mark.asyncio
async def test_slow_restore_does_not_block_other_requests(monkeypatch):
    from routers import upload
    entered = threading.Event()
    release = threading.Event()
    def slow_owner(*args):
        entered.set()
        assert release.wait(2)
        return {'pages': [], 'total_pages': 0}
    monkeypatch.setattr(upload, 'require_session_owner', slow_owner)
    # Invoke a real async route so a synchronous regression blocks the heartbeat.
    task = asyncio.create_task(upload.get_pdf_text_layer('slow', 1, 'testuser'))
    try:
        for _ in range(50):
            if entered.is_set():
                break
            await asyncio.sleep(.01)
        assert entered.is_set()
        assert not task.done()
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)


def test_concurrent_restore_parses_once(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from routers import upload
    monkeypatch.setattr(upload, 'sessions', {})
    calls = []
    def restore(doc_id):
        if doc_id not in upload.sessions:
            calls.append(doc_id)
            time.sleep(.05)
            upload.sessions[doc_id] = {}
        return True
    monkeypatch.setattr(upload, '_restore_session', restore)
    with ThreadPoolExecutor(2) as pool:
        assert list(pool.map(upload.ensure_session, ['same', 'same'])) == [True, True]
    assert calls == ['same']


def test_foreign_owner_is_rejected_before_restore(monkeypatch):
    from routers import upload
    from services import db
    monkeypatch.setattr(upload, 'sessions', {})
    monkeypatch.setattr(db, 'db_get_document', lambda _: {'username': 'someone-else'})
    monkeypatch.setattr(upload, 'ensure_session', lambda _: pytest.fail('foreign document parsed'))
    with pytest.raises(HTTPException) as error:
        upload.require_session_owner('foreign', 'testuser')
    assert error.value.status_code == 404


@pytest.mark.asyncio
async def test_document_mutation_waits_for_parser_thread(monkeypatch):
    from routers import upload
    from services import document_workers as workers
    started, release = threading.Event(), threading.Event()
    finished = []
    def restore(doc_id):
        started.set()
        assert release.wait(2)
        finished.append(doc_id)
        return True
    monkeypatch.setattr(upload, '_restore_session', restore)
    monkeypatch.setattr(workers, 'cancel_document_now', lambda _: set())
    parser = asyncio.create_task(asyncio.to_thread(upload.ensure_session, 'restore-delete'))
    mutation_entered = asyncio.Event()
    async def mutate():
        async with workers.quiesce_document('restore-delete'):
            mutation_entered.set()
            assert finished == ['restore-delete']
    try:
        while not started.is_set():
            await asyncio.sleep(.01)
        mutation = asyncio.create_task(mutate())
        await asyncio.sleep(.05)
        assert not mutation_entered.is_set()
        with pytest.raises(HTTPException):
            workers.ensure_document_available('restore-delete')
    finally:
        release.set()
        await parser
    await mutation
    assert mutation_entered.is_set()
