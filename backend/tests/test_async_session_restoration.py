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
