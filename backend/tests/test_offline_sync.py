import io
import pytest
import httpx
from fastapi.testclient import TestClient
from services import library_sync as sync
from services.desktop_connection import remote_cookie_name
from test_user_data_transfer import dataset
from test_desktop_sync import setup_manager, HEADERS, TARGET


@pytest.mark.parametrize('resolution', ['replace_local', 'replace_remote'])
def test_offline_download_edit_reconnect_and_delta(dataset, tmp_path, monkeypatch, resolution):
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

        def exchange(action='merge', expected='completed'):
            preview = client.post('/desktop/sync/preview', headers=HEADERS, json={'action': action})
            assert preview.status_code == 200, preview.text
            response = client.post('/desktop/sync', headers=HEADERS,
                json={'plan_id': preview.json()['plan_id'], 'confirmed': True, 'automatic': True})
            assert response.status_code == 202, response.text
            client.portal.call(lambda: manager.download_task)
            assert manager.job['status'] == expected, manager.job

        exchange()
        user = manager.local_user(TARGET)
        assert manager.sync.options(TARGET)['offline_ready']
        assert len(dataset['db'].db_list_documents(user, include_deleted=True)) == 2
        assert len(dataset['db'].db_list_documents('bob', include_deleted=True)) == 1
        with dataset['db'].get_db() as conn:
            local_doc = conn.execute('SELECT id FROM documents WHERE username=? AND is_deleted=0', (user,)).fetchone()[0]
            conn.execute("UPDATE memos SET data='{}',updated_at='later' WHERE doc_id=?", (local_doc,))
        unavailable = True
        assert client.post('/desktop/sync/preview', headers=HEADERS, json={'action': 'merge'}).status_code == 400
        unavailable = False
        exchange()
        with dataset['db'].get_db() as conn:
            assert conn.execute("SELECT data FROM memos WHERE doc_id='paper-a'").fetchone()[0] == '{}'
        assert all('/chat_images/' in name for name in requests[-1]['files'])
        assert not responses[-1]['files']
        assert responses[-1]['sync']['cached_files']
        assert len(dataset['db'].db_list_documents('alice', include_deleted=True)) == 2
        with dataset['db'].get_db() as conn:
            conn.execute("UPDATE memos SET data='local edit',updated_at='conflict' WHERE doc_id=?", (local_doc,))
            conn.execute("UPDATE memos SET data='server edit',updated_at='conflict' WHERE doc_id='paper-a'")
        exchange(expected='conflict')
        exchange(resolution)
        with dataset['db'].get_db() as conn:
            desired = 'server edit' if resolution == 'replace_local' else 'local edit'
            assert conn.execute("SELECT data FROM memos WHERE doc_id='paper-a'").fetchone()[0] == desired
            assert conn.execute("SELECT data FROM memos WHERE doc_id=?", (local_doc,)).fetchone()[0] == desired
        exchange()



def test_offline_gateway_routes_locally_and_guards_documents(tmp_path):
    from fastapi import Depends
    from services.auth import get_current_user
    from services.desktop_connection import RemoteGateway
    manager = setup_manager(tmp_path)
    manager.config['access_modes'] = {TARGET: 'offline'}
    manager.config['sync_options'][TARGET].update(account='test-account', offline_ready=True)

    @manager.app.get('/api/test')
    async def who(user=Depends(get_current_user)):
        return {'user': user}

    with TestClient(RemoteGateway(manager, TARGET), base_url='http://127.0.0.1:9000') as client:
        assert client.get('/api/test').json()['user'] == manager.local_user(TARGET)
        assert client.get('/api/test', headers={'Origin': 'https://evil.example'}).status_code == 403
        assert client.post('/api/upload').status_code == 409
        assert client.delete('/api/library/paper-a').status_code == 409
        assert client.put('/api/library/paper-a/title').status_code == 409
