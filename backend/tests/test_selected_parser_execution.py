"""Selected engines must execute consistently across upload, restore and consumers."""
import json
import pytest
from test_pdf_reparse import _make_document


@pytest.mark.parametrize('engine', ['marker', 'mineru'])
@pytest.mark.parametrize('global_clear', [False, True])
def test_reset_adopts_engine_and_invalidates_derived_revision(test_client, isolated_dirs, monkeypatch, engine, global_clear):
    import config
    from services import cache
    from routers.upload import sessions
    db = isolated_dirs['db']
    path = _make_document(isolated_dirs)
    db.db_save_translation('reparse-doc', 1, 'old translation', 'ko')
    cache.save_pages_cache('reparse-doc', str(path), [{'page_num': 1, 'text': 'old', 'parser_engine': 'pymupdf'}])
    sessions['reparse-doc'] = {'username': 'testuser'}
    monkeypatch.setattr(config, 'PDF_PARSER_ENGINE', engine)
    url = '/api/settings/clear-pages-cache' if global_clear else '/api/library/reparse-doc/clear-cache'
    response = test_client.post(url)
    assert response.status_code == 200, response.text
    doc = db.db_get_document('reparse-doc')
    assert doc['parser_engine'] == engine
    assert doc['content_revision'] == 2
    assert 'bibliography' not in doc['metadata']
    assert db.db_get_translation('reparse-doc', 1, 'ko', fallback=False) is None
    assert db.db_get_translation('reparse-doc', 1, 'ko', fallback=False, content_revision=1) == 'old translation'
    assert 'reparse-doc' not in sessions
    assert test_client.post(url).status_code == 200
    assert db.db_get_document('reparse-doc')['content_revision'] == 2


@pytest.mark.parametrize('engine', ['marker', 'mineru'])
def test_references_first_uses_shared_worker(test_client, isolated_dirs, monkeypatch, engine):
    import config
    from services import reparse, pdf_parser, cache
    from routers.upload import ensure_session, sessions
    path = _make_document(isolated_dirs)
    monkeypatch.setattr(config, 'PDF_PARSER_ENGINE', engine)
    assert test_client.post('/api/library/reparse-doc/clear-cache').status_code == 200
    calls = []
    def parse(*args, **kwargs):
        calls.append(args[1])
        return {'parser_engine': engine, 'parser_version': 'worker-version',
                'pages': [{'page_num': 1, 'text': 'Selected parser text.', 'blocks': [], 'parser_engine': engine}], 'images': []}
    monkeypatch.setattr(reparse, 'parse_document_isolated', parse)
    monkeypatch.setattr(pdf_parser, 'extract_pages', lambda *a, **k: pytest.fail('server parser used'))
    assert test_client.get('/api/library/reparse-doc/references').status_code == 200
    assert ensure_session('reparse-doc')
    doc = isolated_dirs['db'].db_get_document('reparse-doc')
    assert doc['parser_version'] == 'worker-version'
    assert cache.get_cached_pages('reparse-doc', str(path))[0]['parser_engine'] == engine
    assert calls == [engine]
    sessions.pop('reparse-doc', None)


@pytest.mark.parametrize('engine', ['marker', 'mineru'])
def test_failed_references_do_not_cache_fallback(test_client, isolated_dirs, monkeypatch, engine):
    import config
    from services import reparse, cache, library
    path = _make_document(isolated_dirs)
    monkeypatch.setattr(config, 'PDF_PARSER_ENGINE', engine)
    assert test_client.post('/api/library/reparse-doc/clear-cache').status_code == 200
    def fail(*a, **k):
        raise RuntimeError('model unavailable')
    monkeypatch.setattr(reparse, 'parse_document_isolated', fail)
    assert test_client.get('/api/library/reparse-doc/references').status_code == 503
    assert cache.get_cached_pages('reparse-doc', str(path)) is None
    assert library.get_page_insight('reparse-doc', 0, 'reference_list') is None
    from routers.upload import ensure_session
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        ensure_session('reparse-doc')
    assert exc.value.status_code == 503


@pytest.mark.parametrize('engine', ['marker', 'mineru'])
def test_settings_reject_runtime_failure_without_saving(test_client, monkeypatch, engine):
    import config
    from routers import auth
    from services import reparse
    monkeypatch.setattr(config, 'PDF_PARSER_ENGINE', 'pymupdf')
    def fail(*a):
        raise RuntimeError('model initialization failed')
    monkeypatch.setattr(reparse, 'validate_parser_runtime', fail)
    monkeypatch.setattr(auth, 'update_system_settings', lambda **k: pytest.fail('saved invalid engine'))
    response = test_client.post('/api/settings/system', json={'pdf_parser_engine': engine, 'ollama_host': 'http://localhost:11434', 'trans_provider': 'ollama', 'trans_model': 'test', 'chat_provider': 'ollama', 'chat_model': 'test'})
    assert response.status_code == 400
    assert 'model initialization failed' in response.text


@pytest.mark.parametrize('engine', ['marker', 'mineru'])
def test_missing_managed_environment_never_uses_server_python(monkeypatch, engine):
    import venv_manager
    from services.reparse import _worker_command
    monkeypatch.setattr(venv_manager, 'is_packaged_desktop', lambda: False)
    monkeypatch.setattr(venv_manager, 'is_venv_available', lambda _: False)
    with pytest.raises(RuntimeError, match='managed environment'):
        _worker_command(engine, '/source.pdf', '/result.json')


@pytest.mark.parametrize('engine', ['marker', 'mineru'])
@pytest.mark.asyncio
async def test_upload_uses_persisted_engine_and_one_worker(isolated_dirs, monkeypatch, engine):
    import config
    from services import parse_job, reparse, document_classification, cache
    from services.document_tasks import create_task, get_task
    root = isolated_dirs['upload_dir']
    directory = root / 'new-upload'; directory.mkdir()
    source = directory / 'document.pdf'
    source.write_bytes(b'mocked pdf input')
    monkeypatch.setattr(config, 'PDF_PARSER_ENGINE', 'pymupdf')
    monkeypatch.setattr(document_classification, 'start_classification_task', lambda *a: None)
    calls = []
    def parse(path, selected):
        calls.append(selected)
        return {'parser_engine': selected, 'parser_version': 'actual-version',
                'pages': [{'page_num': 1, 'text': 'Document text.', 'blocks': [], 'parser_engine': selected}], 'images': []}
    monkeypatch.setattr(reparse, 'parse_document_isolated', parse)
    task = create_task('new-upload', 'parse', {'parser_engine': engine, 'filename': 'new.pdf', 'username': 'testuser', 'document_mode': 'general'})
    sessions = {}
    await parse_job.execute_parse_task(task['id'], sessions, upload_root=str(root),
        metadata_reader=lambda _: {}, page_extractor=lambda _: pytest.fail('server parser used'))
    assert calls == [engine]
    assert get_task(task['id'])['status'] == 'succeeded'
    assert sessions['new-upload']['parser_engine'] == engine
    assert sessions['new-upload']['parser_version'] == 'actual-version'


@pytest.mark.parametrize('engine', ['marker', 'mineru'])
@pytest.mark.asyncio
async def test_upload_engine_failure_is_not_success(isolated_dirs, monkeypatch, engine):
    from services import parse_job, reparse
    from services.document_tasks import create_task, get_task
    root = isolated_dirs['upload_dir']
    directory = root / 'failed-upload'; directory.mkdir()
    (directory / 'document.pdf').write_bytes(b'mocked pdf')
    def fail(*a, **k):
        raise RuntimeError('model load failed')
    monkeypatch.setattr(reparse, 'parse_document_isolated', fail)
    task = create_task('failed-upload', 'parse', {'parser_engine': engine})
    with pytest.raises(RuntimeError, match='model load failed'):
        await parse_job.execute_parse_task(task['id'], {}, upload_root=str(root), metadata_reader=lambda _: {})
    assert get_task(task['id'])['last_error_code'] == 'parser_failed'
    assert isolated_dirs['db'].db_get_document('failed-upload') is None


def test_cache_rejects_wrong_engine_result(isolated_dirs):
    from services import cache
    path = _make_document(isolated_dirs)
    pages = [{'page_num': 1, 'text': 'fallback', 'parser_engine': 'pymupdf'}]
    with pytest.raises(ValueError, match='parser_engine_mismatch'):
        cache.save_pages_cache('reparse-doc', str(path), pages, 'marker', 'test', strict=True)


@pytest.mark.parametrize('engine', ['marker', 'mineru'])
@pytest.mark.asyncio
async def test_missing_environment_marks_preview_failed(isolated_dirs, monkeypatch, engine):
    from services import reparse
    from test_pdf_reparse import _insert_preview
    path = _make_document(isolated_dirs)
    task_id = _insert_preview(isolated_dirs, 'reparse-doc', str(path.parent / 'candidate.json'), status='queued')
    with isolated_dirs['db'].get_db() as conn:
        conn.execute('UPDATE reparse_previews SET candidate_engine = ? WHERE id = ?', (engine, task_id))
        conn.commit()
    def unavailable(*args):
        raise RuntimeError(f'{engine} parser unavailable: install its managed environment first')
    monkeypatch.setattr(reparse, '_worker_command', unavailable)
    await reparse._run_preview(task_id, str(path))
    result = reparse.get_preview(task_id)
    assert result['status'] == 'failed'
    assert result['last_error_code'] == 'parser_unavailable'


@pytest.mark.parametrize('engine', ['marker', 'mineru'])
def test_missing_packaged_engine_is_rejected(monkeypatch, engine):
    import venv_manager
    from services.reparse import _worker_command
    monkeypatch.setattr(venv_manager, 'is_packaged_desktop', lambda: True)
    monkeypatch.setattr(venv_manager, 'is_parser_installed', lambda _: False)
    with pytest.raises(RuntimeError, match='managed packages'):
        _worker_command(engine, '/source.pdf', '/result.json')


@pytest.mark.parametrize('engine', ['marker', 'mineru'])
@pytest.mark.parametrize('product', ['text', 'images'])
def test_engine_exception_never_falls_back(monkeypatch, engine, product):
    import sys
    from types import ModuleType
    from services import pdf_parser
    renderer = ModuleType('marker.renderers.json')
    renderer.JSONRenderer = object
    monkeypatch.setitem(sys.modules, 'marker.renderers.json', renderer)
    def fail(*args):
        raise RuntimeError('model initialization failed')
    monkeypatch.setattr(pdf_parser, '_build_marker_document', fail)
    monkeypatch.setattr(pdf_parser, '_run_mineru', fail)
    monkeypatch.setattr(pdf_parser, '_extract_pages_pymupdf', lambda *a: pytest.fail('fallback used'))
    extractor = pdf_parser.extract_pages if product == 'text' else pdf_parser.extract_pdf_images
    with pytest.raises(RuntimeError, match='model initialization failed'):
        extractor('/source.pdf', engine=engine)
