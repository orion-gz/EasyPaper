from services.workspace_search import search_workspace


def test_search_includes_owned_documents_notes_and_questions(isolated_dirs):
    db = isolated_dirs['db']
    for doc_id, owner in [('own', 'testuser'), ('other', 'someone-else'), ('trash', 'testuser')]:
        db.db_save_document(doc_id, owner, 'Attention.pdf', '/x.pdf', 2, {})
        db.db_save_chat_message(doc_id, 'user', 'What is attention?')
        db.db_save_chat_message(doc_id, 'assistant', 'An answer')
        db.db_put_memos(doc_id, {'page_2': [{'id': 'memo-1', 'content': 'attention memo', 'sentenceIdx': 0}]})
    with db.get_db() as conn:
        conn.execute("UPDATE documents SET is_deleted=1 WHERE id='trash'")
        conn.commit()
    results = search_workspace('testuser', 'attention', 'research')
    assert {item['kind'] for item in results} == {'document', 'memo', 'question'}
    assert {item['doc_id'] for item in results} == {'own'}
    assert next(item for item in results if item['kind'] == 'memo')['page'] == 2
    assert next(item for item in results if item['kind'] == 'question')['question'] == 0
    assert search_workspace('testuser', 'attention', 'general') == []
    assert all(item['kind'] == 'document' for item in search_workspace('testuser', '', 'research'))


def test_search_treats_sql_wildcards_as_literal(isolated_dirs):
    db = isolated_dirs['db']
    db.db_save_document('own', 'testuser', 'Paper.pdf', '/x.pdf', 1, {})
    db.db_save_chat_message('own', 'user', '100% certainty?')
    db.db_save_chat_message('own', 'user', 'Different question')
    results = search_workspace('testuser', '%', 'research')
    questions = [item for item in results if item['kind'] == 'question']
    assert len(questions) == 1
    assert '100%' in questions[0]['text']


def test_search_endpoint_enforces_scope_and_query_limit(test_client, isolated_dirs):
    db = isolated_dirs['db']
    db.db_save_document('own', 'testuser', 'Attention.pdf', '/x.pdf', 1, {})
    db.db_save_document('other', 'another-user', 'Attention.pdf', '/x.pdf', 1, {})
    response = test_client.get('/api/library/command-search?q=attention')
    assert response.status_code == 200
    assert {item['doc_id'] for item in response.json()['results']} == {'own'}
    assert test_client.get('/api/library/command-search', params={'q': 'x' * 201}).status_code == 422


def test_search_caps_each_result_kind_and_preserves_unicode(isolated_dirs):
    db = isolated_dirs['db']
    for index in range(25):
        doc_id = f'paper-{index:02}'
        db.db_save_document(doc_id, 'testuser', 'Match.pdf', '/x.pdf', 1, {})
        db.db_put_memos(doc_id, {'page_1': [{'id': 'memo', 'content': 'Straße match'}]})
    assert len(search_workspace('testuser', '', 'research')) == 20
    results = search_workspace('testuser', 'match', 'research')
    assert len([item for item in results if item['kind'] == 'document']) == 20
    assert len([item for item in results if item['kind'] == 'memo']) == 20
    assert len([item for item in search_workspace('testuser', 'STRASSE', 'research') if item['kind'] == 'memo']) == 20
