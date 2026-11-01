"""Exercise real HTTP streaming, signed cookies and persisted transfer recovery."""
from contextlib import contextmanager
import socket
import threading
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
import uvicorn

from services import auth, library_sync as sync
from services.desktop_connection import DesktopConnections, remote_cookie_name
from services.sync_gate import SyncGateMiddleware
from routers.data_transfer import router
from test_user_data_transfer import dataset

HEADERS = {'X-EasyPaper-Desktop': '1'}


@contextmanager
def server(app):
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
    instance = uvicorn.Server(uvicorn.Config(app, log_level='critical', lifespan='off'))
    thread = threading.Thread(target=instance.run, kwargs={'sockets': [listener]}, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 10
        while not instance.started and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(.01)
        assert instance.started, 'HTTP server failed to start'
        yield f'http://127.0.0.1:{port}'
    finally:
        instance.should_exit = True
        thread.join(timeout=10)
        listener.close()
        assert not thread.is_alive()


def manager_at(path, target):
    app = FastAPI()
    manager = DesktopConnections(app, path, 8000)
    manager.config.update(enabled=True, server_url=target,
                          sync_options={target: {'action': 'merge', 'automatic': False}})
    manager.save()
    app.include_router(manager.router)
    return manager


def run_sync(client, manager, action='merge'):
    response = client.post('/desktop/sync/preview', headers=HEADERS, json={'action': action})
    assert response.status_code == 200, response.text
    plan = response.json()
    response = client.post('/desktop/sync', headers=HEADERS,
                           json={'plan_id': plan['plan_id'], 'confirmed': True})
    assert response.status_code == 202, response.text
    client.portal.call(lambda: manager.download_task)
    return plan


def test_real_http_cookie_isolation_restart_and_two_way_edits(dataset, tmp_path, monkeypatch):
    monkeypatch.setattr(auth, 'get_skip_login', lambda: False)
    monkeypatch.setattr('config.get_app_username', lambda: 'bob')
    monkeypatch.setattr('config._get_config_dir', lambda: str(tmp_path / 'config'))
    remote = FastAPI()
    remote.include_router(router, prefix='/api')
    remote.add_middleware(SyncGateMiddleware)
    original_apply = sync.apply_snapshot
    fail_local = True

    def fail_after_remote_commit(username, *args, **kwargs):
        nonlocal fail_local
        if username == 'bob' and fail_local:
            fail_local = False
            raise OSError('simulated local disk failure after server commit')
        return original_apply(username, *args, **kwargs)

    monkeypatch.setattr(sync, 'apply_snapshot', fail_after_remote_commit)
    with server(remote) as target:
        path = tmp_path / 'desktop.json'
        manager = manager_at(path, target)
        cookie = auth.create_session_token('alice')
        with TestClient(manager.app, base_url='http://127.0.0.1:8000') as client:
            # A valid local session must never authenticate the remote request.
            client.cookies.set('session_token', auth.create_session_token('bob'))
            denied = client.post('/desktop/sync/preview', headers=HEADERS, json={'action': 'merge'})
            assert denied.status_code == 400
            assert 'Sign in' in denied.json()['detail']
            client.cookies.set(remote_cookie_name(target), cookie)
            first = run_sync(client, manager)
            assert manager.job['status'] == 'failed'
            assert len(dataset['db'].db_list_documents('alice', include_deleted=True)) == 3
            assert len(dataset['db'].db_list_documents('bob', include_deleted=True)) == 1

        # Recreate the desktop manager, as on an application restart. Recover
        # from the persisted response; do not upload an altered request.
        manager = manager_at(path, target)
        with TestClient(manager.app, base_url='http://127.0.0.1:8000') as client:
            client.cookies.set(remote_cookie_name(target), cookie)
            resumed = run_sync(client, manager)
            assert resumed['resume'] and resumed['plan_id'] == first['plan_id']
            assert manager.job['status'] == 'completed', manager.job
            with dataset['db'].get_db() as conn:
                conn.execute("UPDATE documents SET filename='server-edit.pdf' WHERE id='paper-a'")
                conn.execute("UPDATE documents SET filename='local-edit.pdf' WHERE id='private-b'")
            run_sync(client, manager)
            assert manager.job['status'] == 'completed', manager.job
            for username in ('alice', 'bob'):
                names = {row['filename'] for row in dataset['db'].db_list_documents(username, include_deleted=True)}
                assert {'server-edit.pdf', 'local-edit.pdf'} <= names
            a = sync.export_snapshot('alice', tmp_path / 'final-a.zip')
            b = sync.export_snapshot('bob', tmp_path / 'final-b.zip')
            assert sync.fingerprint(a) == sync.fingerprint(b)


def test_http_sync_refuses_stale_replacement_preview(dataset, tmp_path, monkeypatch):
    monkeypatch.setattr(auth, 'get_skip_login', lambda: False)
    monkeypatch.setattr('config.get_app_username', lambda: 'bob')
    monkeypatch.setattr('config._get_config_dir', lambda: str(tmp_path / 'config'))
    remote = FastAPI()
    remote.include_router(router, prefix='/api')
    remote.add_middleware(SyncGateMiddleware)
    with server(remote) as target:
        manager = manager_at(tmp_path / 'desktop.json', target)
        with TestClient(manager.app, base_url='http://127.0.0.1:8000') as client:
            client.cookies.set(remote_cookie_name(target), auth.create_session_token('alice'))
            preview = client.post('/desktop/sync/preview', headers=HEADERS, json={'action': 'replace_remote'}).json()
            with dataset['db'].get_db() as conn:
                conn.execute("UPDATE documents SET filename='changed-after-preview.pdf' WHERE id='paper-a'")
            client.post('/desktop/sync', headers=HEADERS, json={'plan_id': preview['plan_id'], 'confirmed': True})
            client.portal.call(lambda: manager.download_task)
            assert manager.job['status'] == 'conflict', manager.job
            assert dataset['db'].db_get_document('paper-a')['filename'] == 'changed-after-preview.pdf'
            assert len(dataset['db'].db_list_documents('alice', include_deleted=True)) == 2
            assert len(dataset['db'].db_list_documents('bob', include_deleted=True)) == 1


def test_snapshot_excludes_active_requests_and_restores_access(dataset):
    import asyncio
    import httpx
    from fastapi import HTTPException
    from services.sync_gate import gate

    async def scenario():
        app = FastAPI()
        app.add_middleware(SyncGateMiddleware)
        entered, release = asyncio.Event(), asyncio.Event()

        @app.get('/api/stream')
        async def stream():
            entered.set()
            await release.wait()
            return {'done': True}

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            task = asyncio.create_task(client.get('/api/stream'))
            await entered.wait()
            try:
                with pytest.raises(HTTPException) as error:
                    async with gate.exclusive('alice'):
                        pytest.fail('active API request must block snapshot')
                assert error.value.status_code == 409
            finally:
                release.set()
                assert (await task).status_code == 200
            async with gate.exclusive('alice'):
                assert (await client.get('/api/stream')).status_code == 423
                with pytest.raises(HTTPException):
                    async with gate.exclusive('bob'):
                        pytest.fail('overlapping snapshots must not start')
            assert (await client.get('/api/stream')).status_code == 200
            assert not gate.busy and gate.active == 0

    asyncio.run(scenario())
