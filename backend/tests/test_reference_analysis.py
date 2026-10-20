import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest
from services.reference_analysis import collect_contexts, validate_result, request_analysis, cache_suffix, ambiguous_author_year


def output(**changes):
    defaults = dict(status='complete', method_score=35, understanding_score=30, background_score=10,
                score_reason='Required to reproduce the method.', citation_reason='Uses this method.',
                roles=['method'], evidence_ids=[0])
    return {**defaults, **changes}


@pytest.mark.parametrize('text,key', [
    ('We use [ 1 ].', '1'), ('We use [3–5].', '4'), ('We use [BCV13, LBH+15].', 'LBH+15'),
    ('Prior work (Smith, 2020; Jones et al., 2019) supports this.', 'smith2020'),
    ('Smith et al. (2020) proposed this.', 'smith2020'),
    ('Li and Wang (2023) proposed this.', 'li2023'),
])
def test_supported_citations(text, key):
    result = collect_contexts([{'page_num': 2, 'text': text}], key)
    assert result[0]['quote'] == text
    assert result[0]['page_num'] == 2


def test_excludes_bibliography_preserves_before_header_and_appendix():
    pages = [{'page_num': 1, 'text': 'We use [1].\nReferences\n[1] Title.'},
             {'page_num': 2, 'text': '[1] More bibliography.\nAppendix A\nWe extend [1].'}]
    found = collect_contexts(pages, '1')
    assert len(found) == 2
    assert all('bibliography' not in row['quote'] and 'Title' not in row['quote'] for row in found)


def test_deduplication_grouping_and_budget():
    pages = [{'page_num': n, 'text': f'Experiment {n} uses [1,2].'} for n in range(1, 30)]
    found = collect_contexts(pages, '1')
    assert len(found) == 12
    assert found[0]['page_num'] == 1 and found[-1]['page_num'] == 29
    assert all(row['grouped'] for row in found)
    assert len(collect_contexts(pages[:1] * 3, '1')) == 1
    assert collect_contexts([{'page_num': 1, 'text': 'See [1-999].'}], '1') == []


def test_validation_uses_only_server_evidence_and_sum():
    contexts = [{'id': 0, 'page_num': 2, 'quote': 'We use [1].', 'grouped': False}]
    result = validate_result(json.dumps(output()), contexts)
    assert result['score'] == 75
    assert result['evidence'] == contexts
    for invalid in [output(evidence_ids=[10]), output(method_score=41), output(method_score=True),
                    output(roles=['invented']), output(roles=['support']), output(evidence_ids=[]), {**output(), 'quote': 'invented'}]:
        with pytest.raises(ValueError):
            validate_result(json.dumps(invalid), contexts)
    assert validate_result(json.dumps(output(status='insufficient_evidence')), contexts)['score'] is None


def create_doc(dirs):
    dirs['db'].db_save_document('doc-1', 'testuser', 'paper.pdf', '/x/paper.pdf', 3, {'title': 'Test'})


def test_cache_lookup_does_not_generate_and_ownership(test_client, isolated_dirs):
    create_doc(isolated_dirs)
    with patch('services.reference_analysis.generate_analysis', new=AsyncMock()) as generate:
        assert test_client.get('/api/library/doc-1/references/1/analysis').json() == {'status': 'not_analyzed'}
        generate.assert_not_called()
    isolated_dirs['db'].db_save_document('other', 'otheruser', 'paper.pdf', '/x/a.pdf', 1, {})
    assert test_client.get('/api/library/other/references/1/analysis').status_code == 404
    assert test_client.post('/api/library/other/references/1/analysis', json={}).status_code == 404
    assert test_client.post('/api/library/doc-1/references/1/analysis', json={'target_lang': 'invalid'}).status_code == 422


def test_analysis_cache_force_and_language(test_client, isolated_dirs):
    create_doc(isolated_dirs)
    pages = [{'page_num': 1, 'text': 'We use [1].\nReferences\n[1] Someone. A paper. 2020.'}]
    result = validate_result(json.dumps(output()), collect_contexts(pages, '1'))
    url = '/api/library/doc-1/references/1/analysis'
    with patch('services.library.get_pdf_path', return_value='/fake.pdf'), \
         patch('services.cache.get_cached_pages', return_value=pages), \
         patch('services.reference_analysis.generate_analysis', new=AsyncMock(return_value=result)) as generate:
        response = test_client.post(url, json={})
        assert response.status_code == 200, response.text
        assert response.json()['score'] == 75
        assert test_client.get(url).json()['score'] == 75
        test_client.post(url, json={})
        assert generate.await_count == 1
        test_client.post(url, json={'force': True})
        assert generate.await_count == 2
        test_client.post(url, json={'target_lang': 'en'})
        assert generate.await_count == 3


def test_no_context_no_model_and_transient_failure_retry(test_client, isolated_dirs):
    create_doc(isolated_dirs)
    url = '/api/library/doc-1/references/1/analysis'
    pages = [{'page_num': 1, 'text': 'References\n[1] Someone. A paper. 2020.'}]
    with patch('services.library.get_pdf_path', return_value='/fake.pdf'), \
         patch('services.cache.get_cached_pages', return_value=pages), \
         patch('services.reference_analysis.generate_analysis', new=AsyncMock()) as generate:
        response = test_client.post(url, json={})
        assert response.status_code == 200, response.text
        assert response.json()['score'] is None
        generate.assert_not_called()
        pages[0]['text'] = 'We use [1].\n' + pages[0]['text']
        generate.side_effect = ValueError('bad JSON')
        assert test_client.post(url, json={'force': True}).status_code == 502
        # A failed regeneration leaves the previous valid cache intact.
        assert test_client.get(url).json()['status'] == 'insufficient_evidence'
        assert test_client.post(url, json={'force': True}).status_code == 502
        assert generate.await_count == 2


def test_model_and_revision_invalidate_cache(test_client, isolated_dirs):
    create_doc(isolated_dirs)
    suffix = cache_suffix('1', 'ko')
    isolated_dirs['db'].db_save_page_insight('doc-1', 0, 'reference_analysis', '{"status":"complete"}', suffix=suffix)
    url = '/api/library/doc-1/references/1/analysis'
    assert test_client.get(url).json()['status'] == 'complete'
    with patch('services.reference_analysis.get_chat_model', return_value='different-model'):
        assert test_client.get(url).json()['status'] == 'not_analyzed'
    with isolated_dirs['db'].get_db() as conn:
        conn.execute('UPDATE documents SET content_revision = content_revision + 1 WHERE id = ?', ('doc-1',))
        conn.commit()
    assert test_client.get(url).json()['status'] == 'not_analyzed'


def test_concurrent_requests_coalesce(isolated_dirs):
    create_doc(isolated_dirs)
    async def scenario():
        async def generate(*args, **kwargs):
            await asyncio.sleep(.01)
            return {'status': 'complete'}
        with patch('services.reference_analysis.analyze_document', side_effect=generate) as analyze:
            doc = {'id': 'doc-1', 'content_revision': 1}
            results = await asyncio.gather(*(request_analysis(doc, '1', 'ko', True) for _ in range(3)))
            assert analyze.call_count == 1
            assert len(results) == 3
    asyncio.run(scenario())


def test_author_year_collision_is_not_attributed_to_first_reference():
    pages = [{'page_num': 1, 'text': 'Smith (2020) proposed this.\nReferences\n'
              'Smith, A. (2020a). First title.\nSmith, A. (2020b). Second title.'}]
    assert ambiguous_author_year(pages, 'smith2020')
    assert not ambiguous_author_year(pages, '1')


def test_changed_document_does_not_cache_inflight_result(test_client, isolated_dirs):
    create_doc(isolated_dirs)
    pages = [{'page_num': 1, 'text': 'We use [1].\nReferences\n[1] Someone. A paper. 2020.'}]
    async def generate(*args, **kwargs):
        with isolated_dirs['db'].get_db() as conn:
            conn.execute('UPDATE documents SET content_revision = 2 WHERE id = ?', ('doc-1',))
            conn.commit()
        return validate_result(json.dumps(output()), collect_contexts(pages, '1'))
    url = '/api/library/doc-1/references/1/analysis'
    with patch('services.library.get_pdf_path', return_value='/fake.pdf'), \
         patch('services.cache.get_cached_pages', return_value=pages), \
         patch('services.reference_analysis.generate_analysis', side_effect=generate):
        assert test_client.post(url, json={}).status_code == 409
        assert test_client.get(url).json()['status'] == 'not_analyzed'


def test_generation_is_stateless_and_model_selects_server_evidence():
    from services.reference_analysis import generate_analysis
    contexts = [{'id': 0, 'page_num': 3, 'quote': 'We compare against [1,2].', 'grouped': True}]
    captured = {}
    async def stream(system_prompt, history_messages, session_id=None):
        captured.update(system=system_prompt, messages=history_messages, session=session_id)
        yield '```json\n' + json.dumps(output(roles=['comparison'], method_score=0)) + '\n```'
    with patch('services.llm_client.stream_chat', side_effect=stream):
        result = asyncio.run(generate_analysis('A reference', contexts, 'Current paper', {}, 'en', ref_key='1'))
    assert result['evidence'][0]['quote'] == contexts[0]['quote']
    assert captured['session'] is None
    assert 'Do not reward citation count' in captured['system']
    assert 'uncertainty about individual attribution' in captured['system']
    payload = json.loads(captured['messages'][0]['content'])
    assert payload['contexts'] == contexts
    assert payload['target_reference'] == {'key': '1', 'text': 'A reference'}
    assert 'method_score=0' in captured['system']
    assert 'NOT citation keys' in captured['system']


def test_references_word_in_body_is_not_a_bibliography_header():
    pages = [{'page_num': 1, 'text': 'References to [1] motivate our method.\n'
              'We implement the algorithm from [1].\nReferences\n[1] Someone. A paper. 2020.'}]
    contexts = collect_contexts(pages, '1')
    assert contexts and 'implement the algorithm' in contexts[0]['quote']
    assert all('Someone' not in context['quote'] for context in contexts)


@pytest.mark.parametrize('header', ['References', '**References**', 'Bibliography', '참고문헌'])
def test_inline_first_reference_participates_in_collision_detection(header):
    pages = [{'page_num': 1, 'text': f'Smith (2020) introduced the method.\n{header} '
              'Smith, A. (2020a). First title.\nSmith, A. (2020b). Second title.'}]
    assert ambiguous_author_year(pages, 'smith2020')
    assert all('First title' not in context['quote'] for context in collect_contexts(pages, 'smith2020'))


def test_inline_reference_collision_returns_no_score_without_model(test_client, isolated_dirs):
    create_doc(isolated_dirs)
    pages = [{'page_num': 1, 'text': 'Smith (2020) introduced the method.\nReferences '
              'Smith, A. (2020a). First title.\nSmith, A. (2020b). Second title.'}]
    with patch('services.library.get_pdf_path', return_value='/fake.pdf'), \
         patch('services.cache.get_cached_pages', return_value=pages), \
         patch('services.reference_analysis.generate_analysis', new=AsyncMock()) as generate:
        response = test_client.post('/api/library/doc-1/references/smith2020/analysis', json={})
        assert response.status_code == 200
        assert response.json()['status'] == 'insufficient_evidence'
        assert response.json()['score'] is None
        generate.assert_not_called()


def test_sampling_preserves_sole_method_evidence_among_thirteen_contexts():
    pages = [{'page_num': i + 1, 'text': ('Methods\nWe reproduce the core algorithm from [1].'
              if i == 6 else f'Background\nExample {i} mentions [1].')} for i in range(13)]
    contexts = collect_contexts(pages, '1')
    assert len(contexts) == 12
    assert any('core algorithm' in item['quote'] and item['section'] == 'method' for item in contexts)
    assert {item['section'] for item in contexts} == {'method', 'intro_related'}
    assert [item['id'] for item in contexts] == list(range(12))


def test_sampling_reserves_all_sections_and_keeps_page_order():
    pages = [{'page_num': i + 1, 'text': f'Background\nBackground context {i} cites [1].'} for i in range(20)]
    pages += [{'page_num': 21, 'text': '2. Methods\nWe implement [1].'},
              {'page_num': 22, 'text': '3. Experiments\nWe evaluate [1].'},
              {'page_num': 23, 'text': '4. Discussion\nWe question [1].'},
              {'page_num': 24, 'text': 'Appendix A\nDetails of [1].'}]
    contexts = collect_contexts(pages, '1')
    assert {item['section'] for item in contexts} == {'intro_related', 'method', 'results', 'conclusion', 'appendix'}
    assert [item['page_num'] for item in contexts] == sorted(item['page_num'] for item in contexts)
    assert len(contexts) == 12


@pytest.mark.parametrize('header', ['Methods', '2. Methodology', '2.1 Approach', '**Materials and Methods**', '## 3. 방법론', 'Model Architecture', 'Training'])
def test_section_state_crosses_pages_and_heading_formats(header):
    pages = [{'page_num': 1, 'text': header + '\nWe adopt [1].'},
             {'page_num': 2, 'text': 'The implementation details of [1] follow.'}]
    assert [item['section'] for item in collect_contexts(pages, '1')] == ['method', 'method']


def test_unheaded_documents_keep_distributed_fallback_and_small_budget():
    pages = [{'page_num': i + 1, 'text': f'Context {i} cites [1].'} for i in range(20)]
    contexts = collect_contexts(pages, '1')
    assert len(contexts) == 12
    assert contexts[0]['page_num'] == 1 and contexts[-1]['page_num'] == 20
    assert len(collect_contexts(pages, '1', limit=1)) == 1
    assert collect_contexts(pages, '1', limit=0) == []


def test_contexts_do_not_join_across_sections_or_removed_bibliography():
    text = ('Methods\nWe implement [1].\nReferences\n[1] Someone. Title.\n'
            'Appendix A\nWe extend [1].')
    contexts = collect_contexts([{'page_num': 1, 'text': text}], '1')
    assert len(contexts) == 2
    assert all(item['quote'] in text for item in contexts)
    assert {item['section'] for item in contexts} == {'method', 'appendix'}
    assert all('Someone' not in item['quote'] for item in contexts)


def test_duplicate_excerpt_retains_grouped_citation_warning():
    pages = [{'page_num': 1, 'text': 'We use [1] and compare [1,2].'}]
    contexts = collect_contexts(pages, '1')
    assert len(contexts) == 1
    assert contexts[0]['grouped'] is True


@pytest.mark.parametrize('version', [1, 2])
def test_old_analysis_cache_is_not_reused(test_client, isolated_dirs, version):
    import hashlib
    from services.reference_analysis import get_chat_model, get_chat_provider
    create_doc(isolated_dirs)
    identity = [version, '1', 'ko', get_chat_provider(), get_chat_model()]
    old_suffix = hashlib.sha256(json.dumps(identity, ensure_ascii=False).encode()).hexdigest()
    isolated_dirs['db'].db_save_page_insight('doc-1', 0, 'reference_analysis',
        '{"status":"complete","score":99}', suffix=old_suffix)
    assert test_client.get('/api/library/doc-1/references/1/analysis').json() == {'status': 'not_analyzed'}


def test_invalid_role_score_gets_one_grounded_repair():
    from services.reference_analysis import generate_analysis
    contexts = [{'id': 0, 'page_num': 3, 'quote': 'Long paths limit learning [12].', 'grouped': False}]
    histories = []
    async def stream(system_prompt, history_messages):
        histories.append(history_messages)
        value = output(roles=['support'], method_score=20 if len(histories) == 1 else 0)
        yield json.dumps(value)
    with patch('services.llm_client.stream_chat', side_effect=stream):
        result = asyncio.run(generate_analysis('A reference', contexts, 'Current paper', {}, 'en', ref_key='12'))
    assert len(histories) == 2
    assert result['method_score'] == 0
    assert result['roles'] == ['support']
    assert 'Method dependency points require' in histories[1][-1]['content']
    assert 'Do not add an unsupported role' in histories[1][-1]['content']
    assert histories[0][0]['content'] in histories[1][-1]['content']
    assert len(histories[1]) == 1  # CLI providers read only the latest user message.


def test_failed_repair_does_not_loop_or_accept_invented_evidence():
    from services.reference_analysis import generate_analysis
    calls = []
    async def stream(*args):
        calls.append(1)
        yield json.dumps(output(evidence_ids=[99]))
    with patch('services.llm_client.stream_chat', side_effect=stream):
        with pytest.raises(ValueError, match='Unknown evidence id'):
            asyncio.run(generate_analysis('A reference', [], 'Current paper', {}, 'en', ref_key='1'))
    assert len(calls) == 2


def test_transport_errors_are_not_retried_as_validation_failures():
    from services.reference_analysis import generate_analysis
    calls = []
    async def stream(*args):
        calls.append(1)
        raise RuntimeError('provider unavailable')
        yield  # Keep this an async generator, matching the provider interface.
    with patch('services.llm_client.stream_chat', side_effect=stream):
        with pytest.raises(RuntimeError, match='provider unavailable'):
            asyncio.run(generate_analysis('A reference', [], 'Current paper', {}, 'en', ref_key='1'))
    assert len(calls) == 1


def test_requested_page_survives_sampling_and_duplicate_excerpts():
    pages = [{'page_num': i, 'text': 'Background\nExample [1].'} for i in range(1, 20)]
    contexts = collect_contexts(pages, '1', requested_page=18)
    assert contexts[0]['page_num'] == 18
    assert len(contexts) == 12
    assert any(item['page_num'] != 18 for item in contexts)


def test_page_scoped_cache_and_no_local_evidence(test_client, isolated_dirs):
    create_doc(isolated_dirs)
    pages = [{'page_num': 1, 'text': 'We use [1].'},
             {'page_num': 2, 'text': 'We compare [1].'},
             {'page_num': 3, 'text': 'References\n[1] Someone. A paper. 2020.'}]
    result = validate_result(json.dumps(output()), collect_contexts(pages, '1'))
    url = '/api/library/doc-1/references/1/analysis'
    with patch('services.library.get_pdf_path', return_value='/fake.pdf'), \
         patch('services.cache.get_cached_pages', return_value=pages), \
         patch('services.reference_analysis.generate_analysis', new=AsyncMock(return_value=result)) as generate:
        assert test_client.post(url, json={'page_num': 1}).status_code == 200
        assert generate.call_args.kwargs['page_num'] == 1
        assert {item['page_num'] for item in generate.call_args.args[1]} == {1, 2}
        assert test_client.get(url + '?page_num=1').json()['score'] == 75
        assert test_client.get(url + '?page_num=2').json()['status'] == 'not_analyzed'
        assert test_client.get(url).json()['status'] == 'not_analyzed'
        assert test_client.post(url, json={'page_num': 3}).json()['status'] == 'insufficient_evidence'
        assert generate.await_count == 1
    assert test_client.get(url + '?page_num=0').status_code == 422
    assert test_client.post(url, json={'page_num': 0}).status_code == 422


@pytest.mark.parametrize('bad', [
    {'citation_reason': 'One. Two. Three. Four.'},
    {'evidence_ids': [1]},
])
def test_page_scoped_generation_repairs_length_and_other_page_evidence(bad):
    from services.reference_analysis import generate_analysis
    contexts = [{'id': 0, 'page_num': 1, 'quote': 'We use [1].'},
                {'id': 1, 'page_num': 2, 'quote': 'We compare [1].'}]
    calls = []
    async def stream(prompt, history):
        calls.append((prompt, history))
        value = output(citation_reason='The method is adopted here. It defines this procedure.')
        if len(calls) == 1:
            value.update(bad)
        yield json.dumps(value)
    with patch('services.llm_client.stream_chat', side_effect=stream):
        result = asyncio.run(generate_analysis('Reference', contexts, 'Title', {}, 'en', ref_key='1', page_num=1))
    assert len(calls) == 2
    assert [item['page_num'] for item in result['evidence']] == [1]
    payload = json.loads(calls[0][1][0]['content'])
    assert payload['requested_page'] == 1
    assert payload['contexts'] == contexts
    assert 'MUST NOT appear in citation_reason' in calls[0][0]
