import asyncio
import json

import pytest

from services import easy_english as service
from services.generation_errors import GenerationError


def response(groups, sentences=None):
    return json.dumps([{"source_sentence_id": group["source_sentence_id"],
                        "easy_sentences": sentences or [group["source_text"]]} for group in groups])


def test_prefers_single_sentence_but_allows_one_group_with_multiple_sentences():
    groups = service.source_groups('Although it rained, we stayed because the road was closed.')
    single = service.validate_response(response(groups), groups)
    split = service.validate_response(response(groups, ['It rained.', 'We stayed because the road was closed.']), groups)
    assert len(single) == len(split) == 1
    assert len(split[0]['easy_sentences']) == 2
    assert single[0]['source_sentence_id'] == split[0]['source_sentence_id']
    assert 'Keep one output sentence' in service.PROMPT
    assert 'Never merge source sentences' in service.PROMPT


@pytest.mark.parametrize('rows', [[], [{"source_sentence_id": "S1", "easy_sentences": ["One."]}],
    [{"source_sentence_id": "S0", "easy_sentences": []}],
    [{"source_sentence_id": "S0", "easy_sentences": [""]}],
    [{"source_sentence_id": "S0", "easy_sentences": "One."}],
    [{"source_sentence_id": "S0", "easy_sentences": ["One."], "extra": True}],
    [{"source_sentence_id": "S0", "easy_sentences": ["One."]}] * 2])
def test_rejects_invalid_groups_without_approximate_alignment(rows):
    with pytest.raises(GenerationError, match='source sentence groups'):
        service.validate_response(json.dumps(rows), service.source_groups('One.'))


def test_rejects_reordered_ids():
    groups = service.source_groups('First sentence. Second sentence.')
    with pytest.raises(GenerationError):
        service.validate_response(response(list(reversed(groups))), groups)


@pytest.mark.parametrize('changed', ['It uses 200 mg [3].', 'It uses 20 mg.', 'It uses 20 mg [4].'])
def test_preserves_numbers_and_citations(changed):
    groups = service.source_groups('It uses 20 mg [3].')
    with pytest.raises(GenerationError):
        service.validate_response(response(groups, [changed]), groups)


def test_paragraph_ids_repeated_sentences_and_abbreviations():
    groups = service.source_groups('Dr. Smith measured 3.5 mg. It worked.\n\nIt worked.')
    assert [group['source_sentence_id'] for group in groups] == ['S0', 'S1', 'S2']
    assert [group['paragraph'] for group in groups] == [0, 0, 1]
    assert groups[0]['source_text'] == 'Dr. Smith measured 3.5 mg.'


def test_chunking_keeps_whole_sentences(monkeypatch):
    groups = service.source_groups('A short sentence. Another short sentence.')
    monkeypatch.setattr(service, 'MAX_CHUNK_CHARS', 115)
    assert list(service.chunks(groups)) == [[groups[0]], [groups[1]]]
    with pytest.raises(GenerationError):
        list(service.chunks(service.source_groups('a' * 120)))


def test_cache_varies_by_source_revision_text_provider_model():
    session, page = {'content_revision': 1, 'source_language': 'en'}, {'page_num': 1, 'text': 'Source.'}
    original = service.cache_key(session, page, 'openai', 'a')
    keys = [service.cache_key({**session, 'content_revision': 2}, page, 'openai', 'a'),
            service.cache_key(session, {**page, 'text': 'Changed.'}, 'openai', 'a'),
            service.cache_key(session, page, 'claude', 'a'), service.cache_key(session, page, 'openai', 'b')]
    assert original not in keys and len(set(keys)) == 4


@pytest.fixture()
def easy_context(test_client, isolated_dirs, monkeypatch):
    from routers import easy_english as router
    session = {'pages': [{'page_num': 1, 'text': 'It uses 20 mg.'}], 'total_pages': 1,
               'source_language': 'auto', 'detected_source_language': 'en', 'content_revision': 1}
    calls = []
    async def completion(prompt, provider, model, doc_id):
        calls.append(prompt)
        yield response(service.source_groups(session['pages'][0]['text']))
    monkeypatch.setattr(router, 'require_session_owner', lambda *args: session)
    monkeypatch.setattr(router, 'get_trans_provider', lambda: 'openai')
    monkeypatch.setattr(router, 'get_trans_model', lambda: 'test-model')
    monkeypatch.setattr(service, 'LIBRARY_DIR', str(isolated_dirs['library_dir']))
    monkeypatch.setattr(service, 'stream_completion', completion)
    monkeypatch.setattr(isolated_dirs['db'], 'db_get_document', lambda *args: {'content_revision': session['content_revision']})
    return test_client, session, calls


def test_cache_lookup_never_generates_and_revisit_reuses_result(easy_context):
    client, _, calls = easy_context
    url = '/api/easy-english/doc/1'
    assert client.get(url).status_code == 404
    assert calls == []
    first = client.post(url, json={})
    assert first.status_code == 200 and '"done": true' in first.text
    assert len(calls) == 1
    stored = client.get(url).json()
    assert stored['sentences'][0]['source_sentence_id'] == 'S0'
    assert stored['cached']
    assert '"cached": true' in client.post(url, json={}).text
    assert len(calls) == 1


def test_failed_regeneration_keeps_old_complete_result(easy_context, monkeypatch):
    client, _, _ = easy_context
    url = '/api/easy-english/doc/1'
    client.post(url, json={})
    previous = client.get(url).json()
    async def broken(*args):
        yield '[]'
    monkeypatch.setattr(service, 'stream_completion', broken)
    assert 'easy_english_invalid_mapping' in client.post(url, json={'regenerate': True}).text
    assert client.get(url).json() == previous


@pytest.mark.parametrize('language', ['ko', 'und', 'mul'])
def test_language_gate_and_manual_english_override(easy_context, language):
    client, session, calls = easy_context
    session['detected_source_language'] = language
    assert client.get('/api/easy-english/doc/1').status_code == 409
    assert client.post('/api/easy-english/doc/1', json={}).status_code == 409
    assert calls == []
    session['source_language'] = 'en'
    assert '"done": true' in client.post('/api/easy-english/doc/1', json={}).text
    assert len(calls) == 1


def test_privacy_classification_and_ocr_block_before_generation(easy_context):
    client, session, calls = easy_context
    url = '/api/easy-english/doc/1'
    session['processing_policy'] = 'local_only'
    assert client.post(url, json={}).status_code == 409
    session['processing_policy'] = 'inherit'
    session['classification_status'] = 'pending'
    assert client.post(url, json={}).status_code == 409
    session['classification_status'] = 'confirmed'
    session['pages'][0]['text_recovery'] = 'failed'
    assert client.post(url, json={}).status_code == 422
    assert client.post('/api/easy-english/doc/9', json={}).status_code == 404
    assert calls == []


async def test_concurrent_requests_share_task(monkeypatch):
    gate = asyncio.Event()
    calls = []
    async def generate(*args):
        calls.append(1)
        await gate.wait()
        return {'text': 'Complete.'}
    monkeypatch.setattr(service, 'generate', generate)
    first = service.start_generation('concurrent', {}, {}, 'key', 'openai', 'test')
    second = service.start_generation('concurrent', {}, {}, 'key', 'openai', 'test')
    assert first is second
    gate.set()
    assert await first == await second
    await asyncio.sleep(0)
    assert calls == [1] and ('concurrent', 'key') not in service._running


async def test_changed_document_does_not_save(easy_context, monkeypatch):
    _, session, _ = easy_context
    from services import db
    monkeypatch.setattr(db, 'db_get_document', lambda *_: {'content_revision': 2})
    with pytest.raises(GenerationError):
        await service.generate('doc', session, session['pages'][0], 'stale', 'openai', 'test')
    assert service.read_result('doc', 'stale') is None
