import json

import pytest

from services.generation_errors import GenerationError, generation_error_payload
from services.translation_quality import check_translation_integrity, TranslationIntegrityError


@pytest.mark.parametrize('option', ['ignore_table', 'ignore_math', 'ignore_refs', 'summary'])
def test_selective_translation_reports_missing_literals_as_warning(option):
    options = {'style': 'summary'} if option == 'summary' else {option: True}
    warnings = check_translation_integrity('Body 1973. Table: 64 50 85 87 512 KiB.', '본문 1973.', **options)
    assert warnings[0]['code'] == 'translation_integrity_warning'
    assert warnings[0]['params']['missing'] == '64, 50, 85, 87, 512'


def test_full_translation_still_rejects_lost_values():
    with pytest.raises(TranslationIntegrityError) as error:
        check_translation_integrity('Keep 512 items.', '누락됨.')
    assert generation_error_payload(error.value)['code'] == 'translation_integrity_failed'
    assert generation_error_payload(error.value)['params'] == {'missing': '512'}


def test_empty_output_is_not_accepted_with_omission_options():
    with pytest.raises(GenerationError) as error:
        check_translation_integrity('Keep 512 items.', '  ', ignore_table=True)
    assert error.value.document_task_error_code == 'translation_empty'


@pytest.mark.parametrize('ignore_table', [True, False])
def test_page_stream_preserves_integrity_feedback(test_client, monkeypatch, ignore_table):
    from routers import translate
    session = {
        'pages': [{'page_num': 1, 'text': 'Body 1973. Table 64 50 85 87 512 KiB.'}],
        'total_pages': 1, 'document_mode': 'general', 'document_type': 'academic_book',
        'detected_source_language': 'en',
    }
    monkeypatch.setattr(translate, 'require_session_owner', lambda *args: session)
    monkeypatch.setattr(translate, 'enforce_rate_limit', lambda *args: None)
    monkeypatch.setattr(translate, 'get_trans_provider', lambda: 'ollama')
    monkeypatch.setattr(translate, 'lib_get_translation_full', lambda *args, **kwargs: {})
    monkeypatch.setattr(translate, 'get_cached_translation_full', lambda *args: {})
    saved = []
    monkeypatch.setattr(translate, 'save_translation_cache', lambda *args: saved.append(args))
    monkeypatch.setattr(translate, 'lib_save_translation', lambda *args: saved.append(args))

    async def stream(*args, **kwargs):
        yield '[S0] 본문 1973.'

    monkeypatch.setattr(translate, 'stream_translation', stream)
    url = f'/api/translate/feedback-test/1?source_lang=en&ignore_table={str(ignore_table).lower()}'
    response = test_client.get(url)
    events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
    final = events[-1]
    assert final['done']
    if ignore_table:
        assert 'error' not in final
        assert final['warnings'][0]['code'] == 'translation_integrity_warning'
        assert len(saved) == 2
        cached = json.loads(saved[0][2])
        assert cached['warnings'] == final['warnings']
        monkeypatch.setattr(translate, 'lib_get_translation_full', lambda *args, **kwargs: cached)
        cached_response = test_client.get(url)
        cached_events = [json.loads(line[6:]) for line in cached_response.text.splitlines() if line.startswith('data: ')]
        assert cached_events[-1]['warnings'] == final['warnings']
    else:
        assert final['error']['code'] == 'translation_integrity_failed'
        assert final['error']['params']['missing'] == '64, 50, 85, 87, 512'
        assert saved == []


def test_background_checkpoint_preserves_failure_code(isolated_dirs):
    from services.document_tasks import create_task, get_task
    from services.translation_job import _save_job
    isolated_dirs['db'].db_save_document('feedback-doc', 'testuser', 'doc.pdf', '/x.pdf', 1, {})
    task = create_task('feedback-doc', 'translate', {}, [1])
    _save_job('feedback-doc', {'task_id': task['id'], 'failed_pages': [1],
                              'status': 'running', 'error_code': 'translation_integrity_failed'})
    assert get_task(task['id'])['pages'][0]['last_error_code'] == 'translation_integrity_failed'


@pytest.mark.asyncio
async def test_cli_timeout_has_safe_structured_code(monkeypatch):
    import asyncio
    from services import llm_client

    class Process:
        killed = False
        returncode = None
        def __init__(self):
            self.stdout = asyncio.StreamReader()
        def kill(self):
            self.killed = True
        async def wait(self):
            return 0

    process = Process()
    monkeypatch.setattr(llm_client, 'CLI_STALL_TIMEOUT_SECONDS', 0.01)
    with pytest.raises(GenerationError) as error:
        await llm_client._read_chunk_with_timeout(process, label='Antigravity CLI')
    assert process.killed
    assert generation_error_payload(error.value)['code'] == 'cli_response_timeout'
    assert generation_error_payload(error.value)['params'] == {'seconds': 0.01}


def test_raw_provider_error_is_not_exposed():
    payload = generation_error_payload(RuntimeError('private stderr /home/secret TOKEN'))
    assert payload['code'] == 'generation_failed'
    assert 'secret' not in json.dumps(payload)


@pytest.mark.asyncio
async def test_cached_translation_endpoints_preserve_warnings(monkeypatch):
    from routers import jobs, library
    from services import library as library_service

    warning = {'code': 'translation_integrity_warning', 'params': {'missing': '512'}}
    cached = {'translation': '본문', 'sentences': [], 'warnings': [warning]}
    document = {'detected_source_language': 'en'}
    monkeypatch.setattr(jobs, 'require_session_owner', lambda *args: document)
    monkeypatch.setattr(library, 'require_owned_document', lambda *args: document)
    monkeypatch.setattr(library_service, 'get_translation_full', lambda *args, **kwargs: cached)
    job_page = await jobs.get_page_translation('doc', 1, source_lang='en', current_user='testuser')
    library_page = await library.get_library_translation('doc', 1, current_user='testuser')
    assert job_page['warnings'] == library_page['warnings'] == [warning]
