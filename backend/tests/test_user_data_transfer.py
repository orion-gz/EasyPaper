import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services import data_transfer as transfer


@pytest.fixture()
def dataset(isolated_dirs):
    db = isolated_dirs['db']
    root = isolated_dirs['library_dir']
    for user, doc in [('alice', 'paper-a'), ('alice', 'paper-b'), ('bob', 'private-b')]:
        folder = root / doc
        folder.mkdir()
        (folder / 'document.pdf').write_bytes(b'%PDF-test ' + doc.encode())
        db.db_save_document(doc, user, doc + '.pdf', str(folder / 'document.pdf'), 2, {'title': doc})
    (root / 'paper-a' / 'chat_images').mkdir()
    (root / 'paper-a' / 'chat_images' / 'qimg_1.png').write_bytes(b'image')
    (isolated_dirs['cache_dir'] / 'paper-a_page_1_ko.json').write_text('{"translation":"translated"}')
    with db.get_db() as conn:
        conn.execute("UPDATE documents SET is_deleted=1 WHERE id='paper-b'")
        conn.execute("INSERT INTO translations(doc_id,page_num,suffix,translation,saved_at) VALUES('paper-a',1,'ko','번역','now')")
        question = conn.execute("INSERT INTO chats(doc_id,role,content,created_at) VALUES('paper-a','user','why?','now')").lastrowid
        answer = conn.execute("INSERT INTO chats(doc_id,role,content,created_at) VALUES('paper-a','assistant','because','now')").lastrowid
        conn.execute("INSERT INTO chats(doc_id,role,content,created_at) VALUES('private-b','user','private','now')")
        conn.execute("INSERT INTO chat_evidence(answer_message_id,doc_id,evidence_id,content_revision,page_num,quote,created_at) VALUES(?,'paper-a','e1',1,1,'quote','now')", (answer,))
        conn.execute("INSERT INTO compare_sessions VALUES('cmp_old','alice',?, 'now','now')", (json.dumps(['paper-a', 'paper-b']),))
        conn.execute("INSERT INTO chats(doc_id,role,content,created_at) VALUES('cmp_old','user','compare?','now')")
        concept = conn.execute("INSERT INTO concepts(name,normalized_name,created_at) VALUES('Science','science','now')").lastrowid
        conn.execute("INSERT INTO paper_concepts(doc_id,concept_id,created_at) VALUES('paper-a',?,'now')", (concept,))
        conn.execute("INSERT INTO question_papers(chat_id,doc_id,created_at) VALUES(?,'paper-a','now')", (question,))
        conn.execute("INSERT INTO question_concepts(chat_id,concept_id,created_at) VALUES(?,?,'now')", (question, concept))
        conn.execute("INSERT INTO folders VALUES('folder-a','alice',NULL,'Folder','#123456',0,'now','now')")
        conn.execute("INSERT INTO document_folders VALUES('paper-a','folder-a')")
        conn.execute("INSERT INTO annotations(doc_id,data,updated_at) VALUES('paper-a','{" + '"1":[]' + "}','now')")
        conn.execute("INSERT INTO memos(doc_id,data,updated_at) VALUES('paper-a','{" + '"1":[{"text":"memo"}]' + "}','now')")
        conn.execute("INSERT INTO reading_time(doc_id,username,day,category,seconds,updated_at) VALUES('paper-a','alice','2026-01-01','reading',120,'now')")
        conn.execute("INSERT INTO reading_sessions(id,username,paper_id,started_at,created_at,updated_at) VALUES('read-a','alice','paper-a','now','now','now')")
        conn.execute("INSERT INTO reading_page_evidence VALUES('alice','paper-a',1,1,120,1,'read-a','now')")
        conn.execute("INSERT INTO user_language_settings VALUES('alice','en','auto','ko','now')")
    return isolated_dirs


def backup(dataset, browser=None):
    target = io.BytesIO()
    transfer.export_archive('alice', browser or {}, target)
    target.seek(0)
    return target


def rewrite(source, mutate):
    with zipfile.ZipFile(source) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    manifest = json.loads(entries['manifest.json'])
    mutate(manifest, entries)
    entries['manifest.json'] = json.dumps(manifest).encode()
    target = io.BytesIO()
    with zipfile.ZipFile(target, 'w') as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    target.seek(0)
    return target


def test_roundtrip_preserves_data_and_isolates_users(dataset):
    archive = backup(dataset, {'easypaper_annotations_paper-a': '{}', 'easypaper_annotations_private-b': 'private', 'easypaper_api_key': 'secret', 'easypaper_ui_locale': 'en'})
    with zipfile.ZipFile(archive) as handle:
        data = json.loads(handle.read('manifest.json'))
        assert 'users' not in data['tables']
        assert 'private-b' not in str(data)
        assert 'secret' not in str(data)
        assert data['browser_data'] == {'easypaper_annotations_paper-a': '{}', 'easypaper_ui_locale': 'en'}
    archive.seek(0)
    result = transfer.import_archive('bob', archive)
    doc = result['id_map']['paper-a']
    assert result['documents'] == 2
    assert (dataset['library_dir'] / doc / 'document.pdf').read_bytes() == b'%PDF-test paper-a'
    assert (dataset['library_dir'] / doc / 'chat_images/qimg_1.png').read_bytes() == b'image'
    assert (dataset['cache_dir'] / f'{doc}_page_1_ko.json').exists()
    with dataset['db'].get_db() as conn:
        assert conn.execute('SELECT COUNT(*) FROM documents').fetchone()[0] == 5
        assert conn.execute('SELECT username FROM documents WHERE id=?', (doc,)).fetchone()[0] == 'bob'
        assert conn.execute('SELECT translation FROM translations WHERE doc_id=?', (doc,)).fetchone()[0] == '번역'
        assert conn.execute('SELECT is_deleted FROM documents WHERE id=?', (result['id_map']['paper-b'],)).fetchone()[0] == 1
        assert conn.execute('SELECT COUNT(*) FROM concepts').fetchone()[0] == 1
        assert conn.execute('SELECT seconds FROM reading_time WHERE doc_id=?', (doc,)).fetchone()[0] == 120
        evidence = conn.execute('SELECT * FROM reading_page_evidence WHERE paper_id=?', (doc,)).fetchone()
        assert conn.execute('SELECT paper_id FROM reading_sessions WHERE id=?', (evidence['source_session_id'],)).fetchone()[0] == doc
        assert conn.execute('SELECT COUNT(*) FROM chat_evidence e JOIN chats c ON c.id=e.answer_message_id WHERE e.doc_id=? AND c.doc_id=?', (doc, doc)).fetchone()[0] == 1
        assert conn.execute('SELECT COUNT(*) FROM question_papers q JOIN chats c ON c.id=q.chat_id WHERE q.doc_id=? AND c.doc_id=?', (doc, doc)).fetchone()[0] == 1
        compare = conn.execute('SELECT * FROM compare_sessions WHERE username="bob"').fetchone()
        assert compare['id'] == result['id_map']['cmp_old']
        assert conn.execute('SELECT content FROM chats WHERE doc_id=?', (compare['id'],)).fetchone()[0] == 'compare?'
    # Repeated imports deliberately append without ID collisions.
    archive.seek(0)
    again = transfer.import_archive('bob', archive)
    assert again['id_map']['paper-a'] != doc


@pytest.mark.parametrize('damage', ['checksum', 'traversal', 'version', 'reference', 'table', 'original'])
def test_invalid_import_leaves_database_and_files_unchanged(dataset, damage):
    def mutate(manifest, entries):
        if damage == 'checksum':
            entries['library/paper-a/document.pdf'] = b'corrupt'
        elif damage == 'traversal':
            entries['../outside'] = b'bad'
        elif damage == 'version':
            manifest['version'] = 999
        elif damage == 'reference':
            manifest['tables']['chat_evidence'][0]['answer_message_id'] = 99999
        elif damage == 'table':
            manifest['tables']['users'] = []
        else:
            del entries['library/paper-a/document.pdf']
            del manifest['files']['library/paper-a/document.pdf']
    archive = rewrite(backup(dataset), mutate)
    before = sorted(str(p) for p in dataset['library_dir'].rglob('*'))
    with pytest.raises(transfer.InvalidArchive):
        transfer.import_archive('bob', archive)
    assert sorted(str(p) for p in dataset['library_dir'].rglob('*')) == before
    with dataset['db'].get_db() as conn:
        assert conn.execute('SELECT COUNT(*) FROM documents').fetchone()[0] == 3
        assert conn.execute('SELECT COUNT(*) FROM chats').fetchone()[0] == 4


def test_file_publish_failure_rolls_back_database(dataset, monkeypatch):
    archive = backup(dataset)
    def fail(*args, **kwargs):
        raise OSError('disk full')
    monkeypatch.setattr(transfer.shutil, 'copyfileobj', fail)
    with pytest.raises(OSError, match='disk full'):
        transfer.import_archive('bob', archive)
    assert sorted(p.name for p in dataset['library_dir'].iterdir()) == ['paper-a', 'paper-b', 'private-b']
    with dataset['db'].get_db() as conn:
        assert conn.execute('SELECT COUNT(*) FROM documents').fetchone()[0] == 3


def test_html_original_roundtrip(dataset):
    root = dataset['library_dir'] / 'paper-a'
    (root / 'article').mkdir()
    (root / 'article/article.json').write_text('{"units":[]}')
    with dataset['db'].get_db() as conn:
        conn.execute("UPDATE documents SET content_kind='html_article' WHERE id='paper-a'")
    result = transfer.import_archive('bob', backup(dataset))
    doc = dataset['db'].db_get_document(result['id_map']['paper-a'])
    assert Path(doc['pdf_path']).read_text() == '{"units":[]}'


def test_endpoint_auth_and_roundtrip(dataset):
    from routers.data_transfer import router
    from services.auth import get_current_user
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_user] = lambda: 'alice'
    with TestClient(app) as client:
        response = client.post('/user-data/export', json={'easypaper_ui_locale': 'ko'})
        assert response.status_code == 200
        assert response.headers['content-type'] == 'application/zip'
        imported = client.post('/user-data/import', content=response.content, headers={'Content-Type': 'application/zip'})
        assert imported.status_code == 200, imported.text
        assert imported.json()['documents'] == 2
        assert client.post('/user-data/import', content=b'bad').status_code == 400
    app.dependency_overrides.clear()
    # Assert both operations always depend on the authentication boundary.
    for route in app.routes:
        if route.path.startswith('/user-data/'):
            assert any(dep.call is get_current_user for dep in route.dependant.dependencies)


def test_historical_reading_and_receipts_roundtrip(dataset):
    with dataset['db'].get_db() as conn:
        conn.execute("INSERT INTO reading_time_receipts VALUES('alice','request-a')")
        conn.execute("INSERT INTO reading_time(doc_id,username,day,category,seconds,updated_at) VALUES('deleted','alice','2026-01-01','reading',60,'now')")
        conn.execute("INSERT INTO reading_sessions(id,username,paper_id,started_at,created_at,updated_at) VALUES('read-deleted','alice','deleted','now','now','now')")
        conn.execute("INSERT INTO document_tasks(id,doc_id,kind,status,created_at,updated_at) VALUES('task-a','paper-a','translation','running','now','now')")
        conn.execute("INSERT INTO document_task_pages(task_id,page_num,status,updated_at) VALUES('task-a',1,'running','now')")
    result = transfer.import_archive('bob', backup(dataset))
    assert result['documents'] == 2
    with dataset['db'].get_db() as conn:
        assert conn.execute('SELECT doc_id FROM reading_time WHERE username="bob" AND seconds=60').fetchone()[0] == result['id_map']['deleted']
        assert conn.execute('SELECT paper_id FROM reading_sessions WHERE id=?', (result['id_map']['read-deleted'],)).fetchone()[0] == result['id_map']['deleted']
        assert conn.execute('SELECT request_id FROM reading_time_receipts WHERE username="bob"').fetchone()[0] == result['id_map']['request-a']
        assert conn.execute('SELECT status FROM document_tasks WHERE doc_id=?', (result['id_map']['paper-a'],)).fetchone()[0] == 'cancelled'


def test_expanded_archive_limit(dataset, monkeypatch):
    archive = backup(dataset)
    monkeypatch.setattr(transfer, 'MAX_EXPANDED_BYTES', 1)
    with pytest.raises(transfer.InvalidArchive, match='size limit'):
        transfer.import_archive('bob', archive)


def test_stream_upload_limit(dataset, monkeypatch):
    from routers.data_transfer import router
    from services.auth import get_current_user
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_user] = lambda: 'alice'
    monkeypatch.setattr(transfer, 'MAX_ARCHIVE_BYTES', 3)
    with TestClient(app) as client:
        assert client.post('/user-data/import', content=b'1234').status_code == 413


@pytest.mark.parametrize('deleted', [('paper-b',), ('paper-a', 'paper-b')])
def test_comparison_history_survives_deleted_sources(dataset, deleted):
    db = dataset['db']
    with db.get_db() as conn:
        conn.execute("INSERT INTO chats(doc_id,role,content,created_at) VALUES('cmp_old','assistant','comparison answer','now')")
        conn.execute("INSERT INTO compare_sessions VALUES('cmp_private','bob','[\"private-b\"]','now','now')")
        conn.execute("INSERT INTO chats(doc_id,role,content,created_at) VALUES('cmp_private','user','private comparison','now')")
    for doc_id in deleted:
        db.db_delete_document(doc_id)
    archive = backup(dataset)
    with zipfile.ZipFile(archive) as handle:
        manifest = json.loads(handle.read('manifest.json'))
        assert [row['id'] for row in manifest['tables']['compare_sessions']] == ['cmp_old']
        assert 'private comparison' not in str(manifest)
        for doc_id in deleted:
            assert not any(name.startswith(f'library/{doc_id}/') for name in handle.namelist())
    archive.seek(0)
    result = transfer.import_archive('bob', archive)
    assert result['documents'] == 2 - len(deleted)
    with db.get_db() as conn:
        comparison = conn.execute('SELECT doc_ids FROM compare_sessions WHERE id=?', (result['id_map']['cmp_old'],)).fetchone()
        assert json.loads(comparison['doc_ids']) == [result['id_map']['paper-a'], result['id_map']['paper-b']]
        history = conn.execute('SELECT content FROM chats WHERE doc_id=? ORDER BY id', (result['id_map']['cmp_old'],)).fetchall()
        assert [row['content'] for row in history] == ['compare?', 'comparison answer']
        for doc_id in deleted:
            assert not conn.execute('SELECT 1 FROM documents WHERE id=?', (result['id_map'][doc_id],)).fetchone()
        if 'paper-a' in deleted:
            reading = conn.execute('SELECT paper_id FROM reading_sessions WHERE id=?', (result['id_map']['read-a'],)).fetchone()
            assert reading['paper_id'] == result['id_map']['paper-a']
    # A restored archive must also preserve deleted-paper comparisons on re-export.
    again = io.BytesIO()
    transfer.export_archive('bob', {}, again)
    again.seek(0)
    with zipfile.ZipFile(again) as handle:
        manifest = json.loads(handle.read('manifest.json'))
        assert any(row['id'] == result['id_map']['cmp_old'] for row in manifest['tables']['compare_sessions'])
