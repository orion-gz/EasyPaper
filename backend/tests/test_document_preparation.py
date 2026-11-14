import asyncio
import threading

import pytest


@pytest.fixture
def document(isolated_dirs, monkeypatch):
    from routers import upload
    from services import document_preparation
    monkeypatch.setattr(upload, 'sessions', {})
    monkeypatch.setattr(document_preparation, '_tasks', {})
    pdf = isolated_dirs['library_dir'] / 'book' / 'document.pdf'
    pdf.parent.mkdir()
    pdf.write_bytes(b'%PDF-1.4')
    isolated_dirs['db'].db_save_document(
        'book', 'testuser', 'Computer Networking.pdf', str(pdf), 797, {},
    )
    return isolated_dirs['library'].get_document('book')


@pytest.mark.asyncio
async def test_pdf_metadata_text_and_history_do_not_wait_for_analysis(document, monkeypatch):
    from routers import upload, library, chat
    from services import document_preparation as preparation
    started, release = threading.Event(), threading.Event()
    calls = []

    def restore(doc_id):
        calls.append(doc_id)
        started.set()
        assert release.wait(5)
        upload.sessions[doc_id] = {
            **document, 'pages': [{'page_num': 1, 'text_recovery': 'ocr', 'text_layer': []}],
        }
        return True

    monkeypatch.setattr(upload, '_restore_session', restore)
    try:
        metadata = await asyncio.wait_for(library.get_library_document('book', current_user='testuser'), .5)
        assert metadata['preparation']['status'] == 'running'
        assert await asyncio.to_thread(started.wait, 1)
        assert (await library.get_document_preparation('book', 'testuser'))['status'] == 'running'
        pdf = await asyncio.wait_for(library.get_library_pdf('book', 'testuser'), .5)
        assert str(pdf.path) == document['pdf_path']
        text = await asyncio.wait_for(upload.get_pdf_text_layer('book', 1, 'testuser', nonblocking=True), .5)
        assert text['recovery'] is None
        assert text['preparation']['status'] == 'running'
        assert await asyncio.wait_for(chat.get_chat_history('book', 'testuser'), .5) == {'history': []}
        assert calls == ['book']
    finally:
        release.set()
        await asyncio.gather(*preparation._tasks.values())
    assert (await library.get_document_preparation('book', 'testuser'))['status'] == 'ready'
    assert (await upload.get_pdf_text_layer('book', 1, 'testuser', nonblocking=True))['recovery'] == 'ocr'


@pytest.mark.asyncio
async def test_failed_analysis_can_retry_and_cache_reset_can_restore_again(document, monkeypatch):
    from routers import upload
    from services import document_preparation as preparation
    calls = []

    def restore(doc_id):
        calls.append(doc_id)
        if len(calls) == 1:
            raise RuntimeError('parser unavailable')
        upload.sessions[doc_id] = {**document, 'pages': []}
        return True

    monkeypatch.setattr(upload, 'ensure_session', restore)
    assert preparation.start_preparation(document)['status'] == 'running'
    await asyncio.gather(*preparation._tasks.values())
    assert preparation.preparation_status(document)['status'] == 'failed'
    assert preparation.start_preparation(document)['status'] == 'failed'
    assert calls == ['book']
    assert preparation.start_preparation(document, retry=True)['status'] == 'running'
    await asyncio.gather(*preparation._tasks.values())
    assert preparation.preparation_status(document)['status'] == 'ready'
    upload.sessions.clear()
    assert preparation.start_preparation(document)['status'] == 'running'
    await asyncio.gather(*preparation._tasks.values())
    assert calls == ['book', 'book', 'book']


def test_foreign_document_cannot_start_preparation(test_client, isolated_dirs, monkeypatch):
    from services import document_preparation
    isolated_dirs['db'].db_save_document('foreign-book', 'other', 'Book.pdf', '/missing.pdf', 797, {})
    monkeypatch.setattr(document_preparation, 'start_preparation', lambda *a, **kw: pytest.fail('foreign analysis started'))
    assert test_client.get('/api/library/foreign-book').status_code == 404
    assert test_client.get('/api/library/foreign-book/preparation').status_code == 404
    assert test_client.get('/api/pdf-text/foreign-book/1?nonblocking=true').status_code == 404
    assert test_client.get('/api/chat/foreign-book/history').status_code == 404


@pytest.mark.asyncio
async def test_mutation_joins_background_parser_before_changing_document(document, monkeypatch):
    from routers import upload
    from services import document_preparation as preparation, document_workers
    started, release = threading.Event(), threading.Event()
    entered_mutation = asyncio.Event()

    def restore(doc_id):
        started.set()
        assert release.wait(5)
        return True

    async def mutate():
        async with document_workers.quiesce_document('book'):
            entered_mutation.set()

    monkeypatch.setattr(upload, '_restore_session', restore)
    preparation.start_preparation(document)
    mutation = None
    try:
        assert await asyncio.to_thread(started.wait, 1)
        assert document_workers.workers_for_document('book') == preparation.workers_for_document('book')
        mutation = asyncio.create_task(mutate())
        await asyncio.sleep(.05)
        assert not entered_mutation.is_set()
    finally:
        release.set()
        if mutation:
            await mutation
        await preparation.shutdown()
    assert entered_mutation.is_set()
