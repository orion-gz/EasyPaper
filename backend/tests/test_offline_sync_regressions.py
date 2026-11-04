import io
import httpx
from fastapi.testclient import TestClient
from services import library_sync as sync
from services.desktop_connection import remote_cookie_name
from test_user_data_transfer import dataset
from test_desktop_sync import setup_manager, HEADERS, TARGET


def test_remote_memo_update_preserves_local_cache_and_session(dataset, tmp_path, monkeypatch):
    manager = setup_manager(tmp_path)
    manager.config['access_modes'] = {TARGET: 'offline'}
    requests = []
    responses = []
    unavailable = False

    async def handler(request):
        if unavailable:
            raise httpx.ConnectError('offline')
        if request.url.path.endswith('/info'):
            manifest = sync.export_snapshot('alice', tmp_path / 'info.zip', offline=True)
            return httpx.Response(200, json={'capabilities': ['offline-user-data', 'offline-user-data-v2'], 'protocol': 1,
                'account': sync.account_id('alice'), 'revision': sync.fingerprint(manifest), 'documents': 2})
        payload = await request.aread()
        requests.append(sync.read_snapshot(io.BytesIO(payload)))
        result = sync.exchange('alice', io.BytesIO(payload), tmp_path / 'responses')
        responses.append(sync.read_snapshot(result))
        return httpx.Response(200, content=result.read_bytes())

    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setattr('config.get_app_username', lambda: 'bob')
    with TestClient(manager.app, base_url='http://127.0.0.1:8000') as client:
        client.cookies.set(remote_cookie_name(TARGET), 'session')

        def exchange():
            preview = client.post('/desktop/sync/preview', headers=HEADERS, json={'action': 'merge'})
            assert preview.status_code == 200, preview.text
            response = client.post('/desktop/sync', headers=HEADERS,
                json={'plan_id': preview.json()['plan_id'], 'confirmed': True, 'automatic': True})
            assert response.status_code == 202, response.text
            client.portal.call(lambda: manager.download_task)
            assert manager.job['status'] == 'completed', manager.job

        exchange()
        user = manager.local_user(TARGET)
        assert manager.sync.options(TARGET)['offline_ready']
        assert len(dataset['db'].db_list_documents(user, include_deleted=True)) == 2
        assert len(dataset['db'].db_list_documents('bob', include_deleted=True)) == 1
        with dataset['db'].get_db() as conn:
            local_doc = conn.execute('SELECT id FROM documents WHERE username=? AND is_deleted=0', (user,)).fetchone()[0]
        cache_file = dataset['cache_dir'] / (local_doc + '_pages.json')
        cache_file.write_text('{"cached": true}')
        from routers.upload import sessions
        sessions[local_doc] = {'username': user, 'pages': []}
        with dataset['db'].get_db() as conn:
            conn.execute("UPDATE memos SET data='{}',updated_at='later' WHERE doc_id='paper-a'")
        unavailable = True
        assert client.post('/desktop/sync/preview', headers=HEADERS, json={'action': 'merge'}).status_code == 400
        unavailable = False
        exchange()
        with dataset['db'].get_db() as conn:
            assert conn.execute("SELECT data FROM memos WHERE doc_id='paper-a'").fetchone()[0] == '{}'
        assert cache_file.exists(), 'User-data sync deleted unchanged document cache'
        assert local_doc in sessions, 'User-data sync evicted open document session'
        assert all('/chat_images/' in name for name in requests[-1]['files'])
        assert not responses[-1]['files']
        assert responses[-1]['sync']['cached_files']
        assert len(dataset['db'].db_list_documents('alice', include_deleted=True)) == 2



def test_gateway_allows_reading_metadata_endpoint(tmp_path):
    from fastapi.testclient import TestClient
    from services.desktop_connection import RemoteGateway
    manager = setup_manager(tmp_path)
    manager.config['access_modes'] = {TARGET: 'offline'}
    manager.config['sync_options'][TARGET].update(account='account-a', offline_ready=True)
    @manager.app.put('/api/library/paper-a/metadata')
    async def metadata():
        return {'ok': True}
    with TestClient(RemoteGateway(manager, TARGET), base_url='http://127.0.0.1:9000') as client:
        response = client.put('/api/library/paper-a/metadata', json={'last_page': 5})
        assert response.status_code == 200, response.text


def test_offline_logout_locks_library(tmp_path, monkeypatch):
    from fastapi import Depends
    from fastapi.responses import JSONResponse
    from services.auth import get_current_user
    from services.desktop_connection import RemoteGateway
    manager = setup_manager(tmp_path)
    manager.config['access_modes'] = {TARGET: 'offline'}
    manager.config['sync_options'][TARGET].update(account='account-a', offline_ready=True)
    @manager.app.get('/api/private')
    async def private(user=Depends(get_current_user)):
        return {'user': user}
    async def successful_logout(self, request):
        return JSONResponse({'message': 'logged out'})
    monkeypatch.setattr(RemoteGateway, 'proxy', successful_logout)
    with TestClient(RemoteGateway(manager, TARGET), base_url='http://127.0.0.1:9000') as client:
        assert client.post('/api/auth/logout').status_code == 200
        response = client.get('/api/private')
        assert response.status_code == 401, response.text


def test_reading_metadata_merge_preserves_server_document(dataset, tmp_path):
    import copy
    import json
    base = sync.export_snapshot('alice', tmp_path / 'base.zip')
    local, remote = copy.deepcopy(base), copy.deepcopy(base)
    local['tables']['documents'][0]['metadata'] = json.dumps({'last_page': 7, 'title': 'unauthorized'})
    merged = sync.offline_merge(base, local, remote)
    result = json.loads(merged['tables']['documents'][0]['metadata'])
    assert result['last_page'] == 7
    assert result['title'] != 'unauthorized'


def test_portable_parse_opens_without_client_parser(dataset, tmp_path, monkeypatch):
    from services import cache
    from test_library_sync import apply
    from routers import upload
    with dataset['db'].get_db() as conn:
        conn.execute("UPDATE documents SET parser_engine='marker',parser_version='server-version' WHERE id='paper-a'")
    doc = dataset['db'].db_get_document('paper-a')
    pages = [{'page_num': 1, 'text': 'Portable text', 'parser_engine': 'marker', 'width': 600, 'height': 800}]
    cache.save_pages_cache('paper-a', doc['pdf_path'], pages, 'marker', 'server-version', strict=True)
    cache.save_images_cache('paper-a', doc['pdf_path'], [], 'marker', 'server-version', strict=True)
    sync.prepare_offline_documents('alice')
    source = tmp_path / 'portable.zip'
    manifest = sync.export_snapshot('alice', source, offline=True)
    assert any(name.endswith('_pages_extract.json') for name in manifest['files'])
    apply('offline-reader', manifest, [source], tmp_path / 'import.zip', manifest['sync']['account'])
    local = next(d for d in dataset['db'].db_list_documents('offline-reader') if d['filename'] == 'paper-a.pdf')
    def forbidden(*args, **kwargs):
        raise AssertionError('Client parser must not run')
    monkeypatch.setattr('services.reparse.load_document_parse', forbidden)
    monkeypatch.setattr('services.context_retrieval.index_document_chunks', lambda *a: None)
    assert upload._restore_session(local['id'])
    assert upload.sessions[local['id']]['pages'] == pages


def test_real_reading_metadata_endpoint(dataset, tmp_path):
    from routers.library import router
    from services.desktop_connection import RemoteGateway
    manager = setup_manager(tmp_path)
    manager.config['access_modes'] = {TARGET: 'offline'}
    manager.config['sync_options'][TARGET].update(account='account-a', offline_ready=True)
    user = manager.local_user(TARGET)
    with dataset['db'].get_db() as conn:
        conn.execute("UPDATE documents SET username=? WHERE id='paper-a'", (user,))
    manager.app.include_router(router, prefix='/api')
    with TestClient(RemoteGateway(manager, TARGET), base_url='http://127.0.0.1:9000') as client:
        response = client.put('/api/library/paper-a/metadata', json={'last_page': 7})
        assert response.status_code == 200, response.text
        assert response.json()['metadata']['last_page'] == 7
        assert client.put('/api/library/paper-a/metadata', json={'title': 'forbidden'}).status_code == 409


def test_logout_restart_and_account_bound_unlock(tmp_path, monkeypatch):
    from fastapi import Depends, FastAPI
    from services.auth import get_current_user
    from services.desktop_connection import DesktopConnections, RemoteGateway
    manager = setup_manager(tmp_path)
    manager.config['access_modes'] = {TARGET: 'offline'}
    manager.config['sync_options'][TARGET].update(account='account-a', offline_ready=True)
    @manager.app.get('/api/private')
    async def private(user=Depends(get_current_user)):
        return {'user': user}
    account = 'account-b'
    async def handler(request):
        if request.url.path.endswith('/info'):
            return httpx.Response(200, json={'account': account})
        if request.url.path.endswith('/login'):
            return httpx.Response(200, stream=httpx.ByteStream(b'{}'), headers={'set-cookie': 'session_token=new-token; Path=/'})
        return httpx.Response(200, stream=httpx.ByteStream(b'{}'))
    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    with TestClient(RemoteGateway(manager, TARGET), base_url='http://127.0.0.1:9000') as client:
        assert client.post('/api/auth/logout').status_code == 200
        assert client.get('/api/private').status_code == 401
        restored = DesktopConnections(FastAPI(), manager.config_path, 8000)
        assert restored.sync.options(TARGET)['offline_locked']
        assert client.post('/api/auth/login', json={}).status_code == 409
        assert client.get('/api/private').status_code == 401
        account = 'account-a'
        assert client.post('/api/auth/login', json={}).status_code == 200
        assert client.get('/api/private').status_code == 200


def test_offline_requests_share_the_sync_gate_identity(tmp_path):
    from services.sync_gate import gate, SyncGateMiddleware
    from services.desktop_connection import RemoteGateway
    manager = setup_manager(tmp_path)
    manager.config['access_modes'] = {TARGET: 'offline'}
    manager.config['sync_options'][TARGET].update(account='account-a', offline_ready=True)
    user = manager.local_user(TARGET)
    manager.app.add_middleware(SyncGateMiddleware)
    @manager.app.get('/api/gate-test')
    async def probe():
        return {'tracked': gate.requests.get(user, 0)}
    with TestClient(RemoteGateway(manager, TARGET), base_url='http://127.0.0.1:9000') as client:
        assert client.get('/api/gate-test').json()['tracked'] == 1
        gate.commits.add(user)
        try:
            assert client.get('/api/gate-test').status_code == 423
        finally:
            gate.commits.discard(user)


def test_model_result_update_invalidates_only_derived_cache(dataset, tmp_path):
    import copy
    from test_library_sync import apply
    baseline = sync.export_snapshot('alice', tmp_path / 'baseline.zip')
    desired = copy.deepcopy(baseline)
    desired['tables']['translations'][0]['translation'] = 'Updated translation'
    parse_cache = dataset['cache_dir'] / 'paper-a_pages_extract.json'
    parse_cache.write_text('retained extraction')
    derived_cache = dataset['cache_dir'] / 'paper-a_page_1_ko.json'
    assert derived_cache.exists()
    apply('alice', desired, [tmp_path / 'baseline.zip'], tmp_path / 'updated.zip', 'peer')
    assert parse_cache.read_text() == 'retained extraction'
    assert not derived_cache.exists()
    assert dataset['db'].db_get_document('paper-a')
