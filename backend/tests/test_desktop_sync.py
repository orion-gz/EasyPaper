import io

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services import library_sync as sync
from services.desktop_connection import DesktopConnections, remote_cookie_name
from test_user_data_transfer import dataset

HEADERS = {'X-EasyPaper-Desktop': '1'}
TARGET = 'https://papers.example.com'


def setup_manager(tmp_path):
    app = FastAPI()
    manager = DesktopConnections(app, tmp_path / 'connection.json', 8000)
    manager.config.update(enabled=True, server_url=TARGET, sync_options={TARGET: {'action': 'merge', 'automatic': False}})
    app.include_router(manager.router)
    return manager


def mock_server(monkeypatch, tmp_path, *, lose_response=False):
    requests = []
    async def handler(request):
        requests.append(request)
        assert request.headers['cookie'] == 'session_token=server-session'
        if request.url.path.endswith('/info'):
            manifest = sync.export_snapshot('alice', tmp_path / 'server-info.zip')
            return httpx.Response(200, json={'account': sync.account_id('alice'), 'protocol': 1,
                                            'revision': sync.fingerprint(manifest), 'documents': len(manifest['tables']['documents'])})
        response = sync.exchange('alice', io.BytesIO(await request.aread()), tmp_path / 'responses')
        assert request.headers['x-easypaper-sync'] == '1'
        if lose_response and len([r for r in requests if r.url.path.endswith('/exchange')]) == 1:
            raise httpx.ReadError('response lost after server commit')
        return httpx.Response(200, stream=httpx.ByteStream(response.read_bytes()))
    real = httpx.AsyncClient
    monkeypatch.setattr('httpx.AsyncClient', lambda **kwargs: real(transport=httpx.MockTransport(handler), **kwargs))
    monkeypatch.setattr('config.get_app_username', lambda: 'bob')
    return requests


def test_preview_cancel_confirm_and_resumable_two_way_sync(dataset, tmp_path, monkeypatch):
    manager = setup_manager(tmp_path)
    calls = mock_server(monkeypatch, tmp_path)
    with TestClient(manager.app, base_url='http://127.0.0.1:8000') as client:
        client.cookies.set('session_token', 'local-secret')
        client.cookies.set(remote_cookie_name(TARGET), 'server-session')
        preview = client.post('/desktop/sync/preview', headers=HEADERS, json={'action': 'merge'})
        assert preview.status_code == 200, preview.text
        plan = preview.json()
        assert (plan['local_documents'], plan['remote_documents']) == (1, 2)
        assert len(dataset['db'].db_list_documents('alice', include_deleted=True)) == 2
        assert len(dataset['db'].db_list_documents('bob', include_deleted=True)) == 1
        assert client.post('/desktop/sync', headers=HEADERS, json={'plan_id': plan['plan_id']}).status_code == 409
        result = client.post('/desktop/sync', headers=HEADERS, json={'plan_id': plan['plan_id'], 'confirmed': True})
        assert result.status_code == 202, result.text
        client.portal.call(lambda: manager.download_task)
        assert manager.job['status'] == 'completed', manager.job
        assert manager.job['documents'] == 3
        # A fresh exchange is a no-op, rather than another copy of every paper.
        preview = client.post('/desktop/sync/preview', headers=HEADERS, json={'action': 'merge'}).json()
        client.post('/desktop/sync', headers=HEADERS, json={'plan_id': preview['plan_id'], 'confirmed': True})
        client.portal.call(lambda: manager.download_task)
        assert manager.job['status'] == 'completed', manager.job
    assert len(dataset['db'].db_list_documents('alice', include_deleted=True)) == 3
    assert len(dataset['db'].db_list_documents('bob', include_deleted=True)) == 3
    assert len([r for r in calls if r.url.path.endswith('/exchange')]) == 2


def test_deferred_sync_does_not_contact_server(dataset, tmp_path, monkeypatch):
    manager = setup_manager(tmp_path)
    calls = mock_server(monkeypatch, tmp_path)
    with TestClient(manager.app, base_url='http://127.0.0.1:8000') as client:
        response = client.post('/desktop/sync/preview', headers=HEADERS, json={'action': 'defer'})
        assert response.json() == {'action': 'defer'}
    assert not calls


def test_lost_response_resumes_without_appending_duplicates(dataset, tmp_path, monkeypatch):
    manager = setup_manager(tmp_path)
    mock_server(monkeypatch, tmp_path, lose_response=True)
    with TestClient(manager.app, base_url='http://127.0.0.1:8000') as client:
        client.cookies.set(remote_cookie_name(TARGET), 'server-session')
        first = client.post('/desktop/sync/preview', headers=HEADERS, json={'action': 'merge'}).json()
        client.post('/desktop/sync', headers=HEADERS, json={'plan_id': first['plan_id'], 'confirmed': True})
        client.portal.call(lambda: manager.download_task)
        assert manager.job['status'] == 'failed'
        assert len(dataset['db'].db_list_documents('alice', include_deleted=True)) == 3
        assert len(dataset['db'].db_list_documents('bob', include_deleted=True)) == 1
        resumed = client.post('/desktop/sync/preview', headers=HEADERS, json={'action': 'merge'}).json()
        assert resumed['resume'] and resumed['plan_id'] == first['plan_id']
        client.post('/desktop/sync', headers=HEADERS, json={'plan_id': resumed['plan_id'], 'confirmed': True})
        client.portal.call(lambda: manager.download_task)
        assert manager.job['status'] == 'completed', manager.job
    assert len(dataset['db'].db_list_documents('alice', include_deleted=True)) == 3
    assert len(dataset['db'].db_list_documents('bob', include_deleted=True)) == 3


def test_replace_local_deletes_only_local_library_after_confirmation(dataset, tmp_path, monkeypatch):
    manager = setup_manager(tmp_path)
    mock_server(monkeypatch, tmp_path)
    with TestClient(manager.app, base_url='http://127.0.0.1:8000') as client:
        client.cookies.set(remote_cookie_name(TARGET), 'server-session')
        preview = client.post('/desktop/sync/preview', headers=HEADERS, json={'action': 'replace_local'}).json()
        assert dataset['db'].db_get_document('private-b')
        client.post('/desktop/sync', headers=HEADERS, json={'plan_id': preview['plan_id'], 'confirmed': True, 'automatic': True})
        client.portal.call(lambda: manager.download_task)
        assert manager.job['status'] == 'completed', manager.job
        assert not manager.sync.options(TARGET)['automatic']
        assert manager.sync.options(TARGET)['action'] == 'merge'
    assert dataset['db'].db_get_document('private-b') is None
    assert len(dataset['db'].db_list_documents('bob', include_deleted=True)) == 2
    assert len(dataset['db'].db_list_documents('alice', include_deleted=True)) == 2


def test_server_exchange_rejects_browser_cross_origin_requests(dataset):
    from routers.data_transfer import router
    from services.auth import get_current_user
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_user] = lambda: 'alice'
    with TestClient(app) as client:
        assert client.post('/user-data/sync/exchange', content=b'not a zip').status_code == 403
        response = client.post('/user-data/sync/exchange', content=b'not a zip',
                               headers={'X-EasyPaper-Sync': '1', 'Origin': 'https://evil.example'})
        assert response.status_code == 403
