import pytest


@pytest.mark.parametrize('trashed', [False, True])
def test_permanent_delete_requires_trash_state(test_client, isolated_dirs, monkeypatch, trashed):
    from routers import library
    db = isolated_dirs['db']
    db.db_save_document('state-check', 'testuser', 'p.pdf', '/nonexistent', 1, {})
    if trashed:
        db.db_soft_delete_document('state-check')
    monkeypatch.setattr(library, 'permanently_delete_document', db.db_delete_document)
    response = test_client.delete('/api/library/state-check/permanent')
    assert response.status_code == (200 if trashed else 409)
    assert (db.db_get_document('state-check') is None) == trashed


@pytest.mark.parametrize("owner, expected", [("another-user", 404), ("testuser", 409)])
def test_rejected_permanent_delete_does_not_cancel_workers(test_client, isolated_dirs, monkeypatch, owner, expected):
    from services import document_workers
    db = isolated_dirs["db"]
    db.db_save_document("reject-check", owner, "p.pdf", "/nonexistent", 1, {})
    cancellations = []
    monkeypatch.setattr(document_workers, "cancel_document_now", lambda doc_id: cancellations.append(doc_id) or set())
    response = test_client.delete("/api/library/reject-check/permanent")
    assert response.status_code == expected
    assert cancellations == []
    assert db.db_get_document("reject-check") is not None
