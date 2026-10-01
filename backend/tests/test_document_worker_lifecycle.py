import asyncio
import pytest
from fastapi import HTTPException


def seed(isolated_dirs, doc_id, **kwargs):
    db = isolated_dirs['db']
    db.db_save_document(doc_id, 'testuser', 'paper.pdf', '/unused', 2, {}, **kwargs)
    from routers.upload import sessions
    session = {**db.db_get_document(doc_id), 'pages': [{'page_num': n, 'text': 'A long enough English sentence.'} for n in (1, 2)]}
    sessions[doc_id] = session
    return session


@pytest.mark.asyncio
async def test_delete_awaits_translation_and_prevents_late_writes(isolated_dirs, monkeypatch):
    from routers.library import delete_library_document_permanently
    from services import translation_job as jobs, library
    session = seed(isolated_dirs, 'delete-active', document_mode='general', document_type='manual')
    started = asyncio.Event()
    async def translate(*args, **kwargs):
        started.set()
        await asyncio.Event().wait()
    monkeypatch.setattr(jobs, '_translate_page', translate)
    monkeypatch.setattr(library, 'delete_chat_sessions', lambda *args: None)
    jobs.start_job('delete-active', session['pages'], source_lang='en')
    worker = jobs._running_tasks['delete-active']
    await started.wait()
    await delete_library_document_permanently('delete-active', 'testuser')
    assert worker.done()
    db = isolated_dirs['db']
    db.db_save_translation('delete-active', 1, 'late response')
    db.db_save_chat_message('delete-active', 'assistant', 'late answer')
    with db.get_db() as conn:
        for table in ('documents', 'translations', 'document_tasks', 'chats'):
            key = 'id' if table == 'documents' else 'doc_id'
            assert conn.execute(f'SELECT COUNT(*) FROM {table} WHERE {key} = ?', ('delete-active',)).fetchone()[0] == 0


@pytest.mark.asyncio
async def test_local_only_stops_current_worker_before_returning(isolated_dirs, monkeypatch):
    from routers.library import patch_document_processing_policy, DocumentProcessingPolicyUpdateRequest
    from services import translation_job as jobs
    session = seed(isolated_dirs, 'policy-active', document_mode='general', document_type='manual')
    started = asyncio.Event()
    calls = []
    async def translate(*args, **kwargs):
        calls.append(kwargs['page_num']); started.set()
        await asyncio.Event().wait()
    monkeypatch.setattr(jobs, '_translate_page', translate)
    jobs.start_job('policy-active', session['pages'], source_lang='en')
    worker = jobs._running_tasks['policy-active']
    await started.wait()
    await patch_document_processing_policy('policy-active', DocumentProcessingPolicyUpdateRequest(processing_policy='local_only'), 'testuser')
    assert worker.done()
    assert calls == [1]
    assert isolated_dirs['db'].db_get_document('policy-active')['processing_policy'] == 'local_only'


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['primer', 'classification'])
async def test_cancel_stops_worker_and_classification_has_manual_fallback(isolated_dirs, monkeypatch, kind):
    from routers import primer, tasks
    from services import document_classification as classifier, document_tasks
    session = seed(isolated_dirs, f'cancel-{kind}', classification_status='pending' if kind == 'classification' else 'confirmed')
    started = asyncio.Event()
    async def generate(*args, **kwargs):
        started.set(); await asyncio.Event().wait()
    if kind == 'primer':
        monkeypatch.setattr(primer, 'generate_adaptive_document_briefing', generate)
        primer._ensure_generation_started(f'cancel-{kind}', 'ko', 'en', session, 'testuser')
    else:
        monkeypatch.setattr(classifier, 'recommend_classification', generate)
        classifier.start_classification_task(f'cancel-{kind}', 'Title', session['pages'])
    await started.wait()
    task = document_tasks.latest_task(f'cancel-{kind}', kind)
    result = await tasks.cancel_document_task(task['id'], 'testuser')
    assert result['status'] == 'cancelled'
    assert result['cancel_requested']
    if kind == 'classification':
        assert isolated_dirs['db'].db_get_document(f'cancel-{kind}')['classification_status'] == 'failed'


@pytest.mark.asyncio
async def test_retry_completed_is_conflict_and_failed_session_keeps_failure(isolated_dirs):
    from routers import tasks, upload
    from services import document_tasks
    seed(isolated_dirs, 'retry-invalid')
    task = document_tasks.create_task('retry-invalid', 'translate', {}, [1], status='succeeded')
    with pytest.raises(HTTPException) as error:
        await tasks.retry_document_task(task['id'], 'testuser')
    assert error.value.status_code == 409
    document_tasks.update_task(task['id'], status='failed')
    upload.sessions.pop('retry-invalid')
    with pytest.raises(HTTPException):
        await tasks.retry_document_task(task['id'], 'testuser')
    assert document_tasks.get_task(task['id'])['status'] == 'failed'

@pytest.mark.asyncio
async def test_cancelled_primer_poll_does_not_restart(isolated_dirs, monkeypatch):
    from routers import primer
    from services.document_tasks import create_task, request_cancel
    session = seed(isolated_dirs, 'primer-poll', source_language='en', detected_source_language='en')
    task = create_task('primer-poll', 'primer', {'target_lang': 'ko', 'source_lang': 'en'})
    request_cancel(task['id'])
    for name in ('get_cached_adaptive_briefing', 'get_cached_document_overview', 'get_cached_primer'):
        monkeypatch.setattr(primer, name, lambda *args, **kwargs: None)
    monkeypatch.setattr(primer, '_ensure_generation_started', lambda *a, **kw: pytest.fail('cancelled work restarted'))
    assert (await primer.get_primer('primer-poll', 'ko', 'testuser'))['status'] == 'cancelled'
