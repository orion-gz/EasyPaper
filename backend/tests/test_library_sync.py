import copy
import hashlib
import json
from pathlib import Path
import uuid

import pytest

from services import library_sync as sync, data_transfer as transfer
from test_user_data_transfer import dataset


def snapshot(user, path):
    return sync.export_snapshot(user, path)


def apply(user, desired, sources, path, peer):
    desired = copy.deepcopy(desired)
    desired['sync'].setdefault('revision', uuid.uuid4().hex)
    sync.write_snapshot(desired, sources, path)
    return sync.apply_snapshot(user, path, sync.raw_fingerprint(user), peer=peer, checkpoint=desired)


def test_canonical_roundtrip_preserves_ids_and_does_not_duplicate(dataset, tmp_path):
    alice_path, bob_path = tmp_path / 'alice.zip', tmp_path / 'bob.zip'
    alice = snapshot('alice', alice_path)
    bob = snapshot('bob', bob_path)
    merged = sync.merge_snapshots(None, alice, bob)
    existing_bob = dataset['db'].db_get_document('private-b')
    result = apply('bob', merged, [alice_path, bob_path], tmp_path / 'merged.zip', alice['sync']['account'])
    assert result['documents'] == 3
    assert dataset['db'].db_get_document('private-b') == existing_bob
    with dataset['db'].get_db() as conn:
        comparison = conn.execute('SELECT * FROM compare_sessions WHERE username=?', ('bob',)).fetchone()
        reopened_id = 'cmp_' + hashlib.sha256(':'.join(sorted(json.loads(comparison['doc_ids']))).encode()).hexdigest()[:20]
        assert comparison['id'] == reopened_id
        assert conn.execute('SELECT content FROM chats WHERE doc_id=?', (reopened_id,)).fetchone()[0] == 'compare?'
    after = snapshot('bob', tmp_path / 'after.zip')
    assert sync.fingerprint(after) == sync.fingerprint(merged)
    apply('bob', after, [tmp_path / 'after.zip'], tmp_path / 'again.zip', alice['sync']['account'])
    assert len(dataset['db'].db_list_documents('bob', include_deleted=True)) == 3
    assert sync.fingerprint(snapshot('bob', tmp_path / 'last.zip')) == sync.fingerprint(after)


def test_three_way_merge_additions_changes_and_deletions(dataset, tmp_path):
    base = snapshot('alice', tmp_path / 'base.zip')
    local, remote = copy.deepcopy(base), copy.deepcopy(base)
    local['tables']['documents'][0]['filename'] = 'local title.pdf'
    remote['tables']['documents'][1]['filename'] = 'server title.pdf'
    merged = sync.merge_snapshots(base, local, remote)
    assert {r['filename'] for r in merged['tables']['documents']} == {'local title.pdf', 'server title.pdf'}
    remote = copy.deepcopy(base)
    remote['tables']['documents'][0]['filename'] = 'conflicting title.pdf'
    with pytest.raises(sync.SyncConflict):
        sync.merge_snapshots(base, local, remote)
    local = copy.deepcopy(base)
    local['tables']['translations'] = []
    assert sync.merge_snapshots(base, local, base)['tables']['translations'] == []


def test_exchange_retries_return_same_snapshot(dataset, tmp_path):
    incoming = snapshot('bob', tmp_path / 'bob.zip')
    incoming['sync'].update(request_id='request-one', policy='merge', baseline='')
    request = tmp_path / 'request.zip'
    sync.write_snapshot(incoming, [tmp_path / 'bob.zip'], request)
    response = sync.exchange('alice', request, tmp_path / 'responses')
    first = response.read_bytes()
    assert sync.exchange('alice', request, tmp_path / 'responses').read_bytes() == first
    assert len(dataset['db'].db_list_documents('alice', include_deleted=True)) == 3
    response_manifest = sync.read_snapshot(response)
    apply('bob', response_manifest, [response], tmp_path / 'received.zip', response_manifest['sync']['account'])
    assert sync.fingerprint(snapshot('alice', tmp_path / 'a2.zip')) == sync.fingerprint(snapshot('bob', tmp_path / 'b2.zip'))


def test_replace_remote_checks_preview_and_preserves_other_accounts(dataset, tmp_path):
    remote = snapshot('alice', tmp_path / 'alice.zip')
    local = snapshot('bob', tmp_path / 'bob.zip')
    local['sync'].update(request_id='replace-one', policy='replace_remote', expected_remote='stale')
    request = tmp_path / 'request.zip'
    sync.write_snapshot(local, [tmp_path / 'bob.zip'], request)
    with pytest.raises(sync.SyncConflict):
        sync.exchange('alice', request, tmp_path / 'responses')
    assert len(dataset['db'].db_list_documents('alice', include_deleted=True)) == 2
    local['sync']['expected_remote'] = sync.fingerprint(remote)
    sync.write_snapshot(local, [tmp_path / 'bob.zip'], request)
    sync.exchange('alice', request, tmp_path / 'responses')
    assert len(dataset['db'].db_list_documents('alice', include_deleted=True)) == 1
    assert dataset['db'].db_get_document('private-b')['username'] == 'bob'
    assert not (dataset['library_dir'] / 'paper-a').exists()


def test_transaction_failure_restores_files_and_database(dataset, tmp_path, monkeypatch):
    local = snapshot('alice', tmp_path / 'alice.zip')
    original = (dataset['library_dir'] / 'paper-a' / 'document.pdf').read_bytes()
    from services.sync_transaction import SyncTransaction
    def fail(*args):
        raise OSError('disk full')
    monkeypatch.setattr(SyncTransaction, 'checkpoint', fail)
    with pytest.raises(OSError, match='disk full'):
        apply('alice', local, [tmp_path / 'alice.zip'], tmp_path / 'merged.zip', 'peer')
    assert (dataset['library_dir'] / 'paper-a' / 'document.pdf').read_bytes() == original
    assert dataset['db'].db_get_document('paper-a')['username'] == 'alice'


def test_local_changes_since_snapshot_are_not_overwritten(dataset, tmp_path):
    local = snapshot('alice', tmp_path / 'alice.zip')
    local['sync']['revision'] = 'revision'
    expected = sync.raw_fingerprint('alice')
    with dataset['db'].get_db() as conn:
        conn.execute("UPDATE documents SET filename='changed.pdf' WHERE id='paper-a'")
    with pytest.raises(transfer.InvalidArchive, match='changed during'):
        sync.apply_snapshot('alice', tmp_path / 'alice.zip', expected, peer='peer', checkpoint=local)
    assert dataset['db'].db_get_document('paper-a')['filename'] == 'changed.pdf'


def test_second_exchange_merges_both_sides_and_propagates_deletion(dataset, tmp_path):
    def roundtrip(number):
        source = tmp_path / f'client-{number}.zip'
        local = snapshot('bob', source)
        server_id = sync.account_id('alice')
        previous = sync.peer_state('bob', server_id)
        local['sync'].update(request_id=f'request-{number}', policy='merge', expected_account=server_id,
                             baseline=previous['revision'] if previous else '')
        request = tmp_path / f'request-{number}.zip'
        sync.write_snapshot(local, [source], request)
        response = sync.exchange('alice', request, tmp_path / 'responses')
        manifest = sync.read_snapshot(response)
        apply('bob', manifest, [response], tmp_path / f'applied-{number}.zip', server_id)
    roundtrip(1)
    with dataset['db'].get_db() as conn:
        conn.execute("UPDATE documents SET filename='server edit.pdf' WHERE id='paper-a'")
        conn.execute("UPDATE documents SET filename='local edit.pdf' WHERE id='private-b'")
    from services.library import permanently_delete_document
    permanently_delete_document('paper-b')
    roundtrip(2)
    a, b = snapshot('alice', tmp_path / 'a.zip'), snapshot('bob', tmp_path / 'b.zip')
    assert sync.fingerprint(a) == sync.fingerprint(b)
    assert {r['filename'] for r in a['tables']['documents']} == {'server edit.pdf', 'local edit.pdf'}
    roundtrip(3)
    assert len(dataset['db'].db_list_documents('alice', include_deleted=True)) == 2
    assert len(dataset['db'].db_list_documents('bob', include_deleted=True)) == 2


def test_recover_uncommitted_file_swap_after_restart(dataset, tmp_path):
    from services.sync_transaction import SyncTransaction, recover_transactions
    local = snapshot('alice', tmp_path / 'alice.zip')
    original = (dataset['library_dir'] / 'paper-a' / 'document.pdf').read_bytes()
    context = SyncTransaction('alice', sync.raw_fingerprint('alice'), 'peer', local, '', '', '')
    conn = dataset['db'].get_db()
    conn.execute('BEGIN IMMEDIATE')
    context.begin(conn, {}, [])
    context.move_old_files()
    assert not (dataset['library_dir'] / 'paper-a').exists()
    conn.close()  # SQLite rolls back; the on-disk journal survives the process.
    recover_transactions()
    assert (dataset['library_dir'] / 'paper-a' / 'document.pdf').read_bytes() == original
    assert dataset['db'].db_get_document('paper-a')['username'] == 'alice'


def test_pending_commit_cleanup_never_rolls_back_committed_data(dataset, tmp_path, monkeypatch):
    from services.sync_transaction import SyncTransaction, recover_transactions
    local = snapshot('alice', tmp_path / 'alice.zip')
    local['tables']['documents'][0]['filename'] = 'committed.pdf'
    monkeypatch.setattr(SyncTransaction, 'finish', lambda self: None)
    apply('alice', local, [tmp_path / 'alice.zip'], tmp_path / 'merged.zip', 'peer')
    recover_transactions()
    assert 'committed.pdf' in {r['filename'] for r in dataset['db'].db_list_documents('alice', include_deleted=True)}
    assert (dataset['library_dir'] / 'paper-a' / 'document.pdf').exists()


def test_account_rename_keeps_shared_ids_and_checkpoints(dataset, tmp_path):
    db = dataset['db']
    db.create_user('alice', 'hash')
    initial = snapshot('alice', tmp_path / 'alice.zip')
    initial['sync']['revision'] = 'first-revision'
    with db.get_db() as conn:
        sync.save_checkpoint(conn, 'alice', 'peer', initial)
    assert db.update_user_credentials('alice', 'renamed', 'new-hash')
    renamed = snapshot('renamed', tmp_path / 'renamed.zip')
    assert renamed['sync']['account'] == initial['sync']['account']
    assert sync.fingerprint(renamed) == sync.fingerprint(initial)
    assert sync.peer_state('renamed', 'peer')['revision'] == 'first-revision'


def test_shared_concept_display_names_do_not_conflict(dataset, tmp_path):
    base = snapshot('alice', tmp_path / 'alice.zip')
    other = copy.deepcopy(base)
    other['tables']['concepts'][0]['name'] = 'SCIENCE'
    other['tables']['concepts'][0]['created_at'] = 'later'
    assert sync.fingerprint(sync.merge_snapshots(None, base, other)) == sync.fingerprint(base)


def test_request_cannot_replace_a_different_server_account(dataset, tmp_path):
    incoming = snapshot('bob', tmp_path / 'bob.zip')
    incoming['sync'].update(request_id='wrong-account', policy='replace_remote', expected_account='some-other-account')
    sync.write_snapshot(incoming, [tmp_path / 'bob.zip'], tmp_path / 'request.zip')
    with pytest.raises(transfer.InvalidArchive, match='account changed'):
        sync.exchange('alice', tmp_path / 'request.zip', tmp_path / 'responses')
    assert len(dataset['db'].db_list_documents('alice', include_deleted=True)) == 2
