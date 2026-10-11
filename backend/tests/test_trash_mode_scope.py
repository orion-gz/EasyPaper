import pytest


@pytest.mark.parametrize('mode', ['research', 'general'])
def test_empty_trash_preserves_other_mode_and_user(test_client, isolated_dirs, mode):
    db = isolated_dirs['db']
    for doc_id, owner, doc_mode, deleted in [
        ('research', 'testuser', 'research', True),
        ('general', 'testuser', 'general', True),
        ('other-user', 'otheruser', mode, True),
        ('active', 'testuser', mode, False),
    ]:
        db.db_save_document(doc_id, owner, doc_id + '.pdf', '/nonexistent', 1, {},
                            doc_mode, 'manual' if doc_mode == 'general' else 'research_paper')
        if deleted:
            db.db_soft_delete_document(doc_id)
    response = test_client.delete('/api/library/trash/empty', params={'document_mode': mode})
    assert response.status_code == 200
    assert db.db_get_document(mode) is None
    for doc_id in ({'research', 'general'} - {mode}) | {'other-user', 'active'}:
        assert db.db_get_document(doc_id) is not None


def test_empty_trash_rejects_invalid_scope(test_client):
    assert test_client.delete('/api/library/trash/empty?document_mode=all').status_code == 422
