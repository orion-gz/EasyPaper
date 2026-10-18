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
                    output(roles=['invented']), output(evidence_ids=[]), {**output(), 'quote': 'invented'}]:
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
        async def generate(*args):
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
    async def generate(*args):
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
        yield '```json\n' + json.dumps(output(roles=['comparison'])) + '\n```'
    with patch('services.llm_client.stream_chat', side_effect=stream):
        result = asyncio.run(generate_analysis('A reference', contexts, 'Current paper', {}, 'en'))
    assert result['evidence'][0]['quote'] == contexts[0]['quote']
    assert captured['session'] is None
    assert 'Do not reward citation count' in captured['system']
    assert 'uncertainty about individual attribution' in captured['system']
    assert json.loads(captured['messages'][0]['content'])['contexts'] == contexts
