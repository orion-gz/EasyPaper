import asyncio
from contextlib import closing
import json
import socket

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse
from fastapi.testclient import TestClient

from services import data_transfer
from services.desktop_connection import (
    DesktopConnections, RemoteGateway, normalize_server_url, remote_cookie_name,
)

HEADERS = {'X-EasyPaper-Desktop': '1'}
ORIGIN = 'http://127.0.0.1:8000'
TARGET = 'https://papers.example.com/easypaper'


@pytest.mark.parametrize('value', [
    'file:///tmp/test', 'http://user:password@host', 'https://host/?key=secret',
    'https://host/#fragment', 'http://host:0', 'http://host:bad', 'http://host/a/../b',
    'https://host\\@other', 'https://host\n/path', '', None,
])
def test_invalid_server_urls(value):
    with pytest.raises(HTTPException):
        normalize_server_url(value)


def test_server_url_preserves_proxy_prefix():
    assert normalize_server_url('https://PAPERS.example.com/easypaper/') == TARGET
    assert normalize_server_url('http://192.168.1.10:8000') == 'http://192.168.1.10:8000'


@pytest.fixture()
def manager(tmp_path):
    app = FastAPI()
    instance = DesktopConnections(app, tmp_path / 'connection.json', 8000)
    app.include_router(instance.router)

    @app.get('/')
    def frontend():
        return PlainTextResponse('local frontend')

    @app.get('/api/library')
    def library():
        return {'source': 'local'}

    return instance


@pytest.mark.parametrize('headers,base', [
    ({}, ORIGIN),
    ({**HEADERS, 'Origin': 'https://evil.example'}, ORIGIN),
    ({**HEADERS, 'Sec-Fetch-Site': 'cross-site'}, ORIGIN),
    (HEADERS, 'http://evil.example:8000'),
])
def test_controls_reject_nonlocal_and_cross_origin(manager, headers, base):
    with TestClient(manager.app, base_url=base) as client:
        assert client.get('/desktop/connection', headers=headers).status_code == 403
        assert client.put('/desktop/connection', headers=headers, json={'enabled': False}).status_code == 403


def test_local_selection_persists_without_touching_data(manager):
    with TestClient(manager.app, base_url=ORIGIN) as client:
        assert not client.get('/desktop/connection', headers=HEADERS).json()['onboarded']
        result = client.put('/desktop/connection', headers=HEADERS, json={'enabled': False})
        assert result.status_code == 200
        assert result.json()['destination'] == ORIGIN + '/'
    saved = json.loads(manager.config_path.read_text())
    assert saved['onboarded'] and not saved['enabled']
    assert not saved['ports']


def mock_upstream(monkeypatch, handler):
    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr('services.desktop_connection.httpx.AsyncClient',
                        lambda **kwargs: real_client(transport=transport, **kwargs))


def test_proxy_isolates_sessions_and_preserves_streams_and_ranges(manager, monkeypatch):
    calls = []

    async def upstream(request):
        calls.append((request, await request.aread()))
        return httpx.Response(206, headers={
            'content-type': 'application/pdf', 'content-range': 'bytes 0-3/10',
            'set-cookie': 'session_token=new-remote-session; HttpOnly; Max-Age=3600; Path=/',
        }, stream=httpx.ByteStream(b'%PDF'))

    mock_upstream(monkeypatch, upstream)
    gateway = RemoteGateway(manager, TARGET)
    cookie = remote_cookie_name(TARGET)
    with TestClient(gateway, base_url='http://127.0.0.1:9000') as client:
        client.cookies.set('session_token', 'local-secret')
        client.cookies.set(cookie, 'remote-secret')
        client.cookies.set(remote_cookie_name('https://other.example'), 'other-secret')
        result = client.post('/api/pdf-file/document?lang=ko', content=b'upload', headers={'Range': 'bytes=0-3'})
        assert result.status_code == 206
        assert result.content == b'%PDF'
        assert result.headers['content-range'] == 'bytes 0-3/10'
        assert cookie + '=new-remote-session' in result.headers['set-cookie']
        assert client.cookies.get('session_token') == 'local-secret'
        assert client.get('/').text == 'local frontend'
    request, body = calls[0]
    assert str(request.url) == TARGET + '/api/pdf-file/document?lang=ko'
    assert request.headers['cookie'] == 'session_token=remote-secret'
    assert request.headers['range'] == 'bytes=0-3'
    assert body == b'upload'
    assert len(calls) == 1


def test_remote_logout_only_clears_remote_cookie(manager, monkeypatch):
    mock_upstream(monkeypatch, lambda request: httpx.Response(200,
        headers={'set-cookie': 'session_token=""; Max-Age=0; Path=/'}, stream=httpx.ByteStream(b'{}')))
    with TestClient(RemoteGateway(manager, TARGET), base_url=ORIGIN) as client:
        client.cookies.set('session_token', 'local-secret')
        result = client.post('/api/auth/logout')
        assert 'Max-Age=0' in result.headers['set-cookie']
        assert remote_cookie_name(TARGET) in result.headers['set-cookie']
        assert client.cookies.get('session_token') == 'local-secret'


def test_remote_failure_never_reads_local_library(manager, monkeypatch):
    def upstream(request):
        raise httpx.ConnectError('offline', request=request)
    mock_upstream(monkeypatch, upstream)
    with TestClient(RemoteGateway(manager, TARGET), base_url=ORIGIN) as client:
        result = client.get('/api/library')
        assert result.status_code == 502
        assert 'source' not in result.json()
        # Settings remain available even when the remote server is offline.
        assert client.get('/desktop/connection', headers=HEADERS).status_code == 200


def test_redirects_and_cross_origin_requests_are_not_forwarded(manager, monkeypatch):
    calls = []
    def upstream(request):
        calls.append(request)
        return httpx.Response(302, headers={'location': 'https://other.example'}, stream=httpx.ByteStream(b''))
    mock_upstream(monkeypatch, upstream)
    with TestClient(RemoteGateway(manager, TARGET), base_url=ORIGIN) as client:
        assert client.get('/api/library').status_code == 502
        assert client.post('/api/upload', headers={'Origin': 'https://evil.example'}).status_code == 403
    assert len(calls) == 1


def test_gateway_origins_are_persistent_and_separate(manager):
    async def scenario():
        try:
            first = await manager.ensure_gateway(TARGET)
            second = await manager.ensure_gateway('https://other.example')
            assert first != second != manager.local_port
            assert first == await manager.ensure_gateway(TARGET)
            manager.config.update(enabled=True, server_url=TARGET, onboarded=True)
            manager.save()
        finally:
            await manager.close()
        restored = DesktopConnections(manager.app, manager.config_path, 8000)
        try:
            await restored.start()
            assert restored.config['ports'][TARGET] == first
            assert restored.config['enabled']
        finally:
            await restored.close()
    asyncio.run(scenario())


def test_occupied_saved_port_does_not_switch_storage_origin(manager):
    with closing(socket.socket()) as blocker:
        blocker.bind(('127.0.0.1', 0))
        port = blocker.getsockname()[1]
        manager.config.update(enabled=True, server_url=TARGET)
        manager.config['ports'][TARGET] = port
        asyncio.run(manager.start())
        assert manager.config_error
        assert manager.config['ports'][TARGET] == port
        assert not manager.config['enabled']


def test_download_appends_real_archive_and_preserves_local_settings(manager, isolated_dirs, monkeypatch, tmp_path):
    db = isolated_dirs['db']
    root = isolated_dirs['library_dir']
    for user, doc in [('server-user', 'remote-doc'), ('local-user', 'local-doc')]:
        directory = root / doc
        directory.mkdir()
        original = directory / 'document.pdf'
        original.write_bytes(b'%PDF-' + doc.encode())
        db.db_save_document(doc, user, doc + '.pdf', str(original), 1, {})
    with db.get_db() as conn:
        conn.execute("INSERT INTO translations(doc_id,page_num,suffix,translation,saved_at) VALUES('remote-doc',1,'ko','translated','now')")
        conn.execute("INSERT INTO memos(doc_id,data,updated_at) VALUES('remote-doc','{}','now')")
    # Existing user preferences are not replaced by the remote archive.
    db.db_upsert_workspace_settings('local-user', 1, 'general', {})
    db.db_upsert_workspace_settings('server-user', 1, 'research', {})
    destination = tmp_path / 'server.zip'
    data_transfer.export_archive('server-user', {}, destination)
    archive = destination.read_bytes()
    calls = []
    def upstream(request):
        calls.append(request)
        return httpx.Response(200, stream=httpx.ByteStream(archive))
    mock_upstream(monkeypatch, upstream)
    monkeypatch.setattr('config.get_app_username', lambda: 'local-user')
    asyncio.run(manager.copy_to_local(TARGET, {'cookie': 'session_token=remote-secret', 'authorization': 'local-secret'}))
    assert manager.job['status'] == 'completed'
    assert manager.job['documents'] == 1
    assert calls[0].headers['cookie'] == 'session_token=remote-secret'
    assert 'authorization' not in calls[0].headers
    assert str(calls[0].url) == TARGET + '/api/user-data/export'
    with db.get_db() as conn:
        docs = list(conn.execute("SELECT * FROM documents WHERE username='local-user'"))
        assert len(docs) == 2
        copied = next(doc for doc in docs if doc['id'] != 'local-doc')
        assert conn.execute('SELECT translation FROM translations WHERE doc_id=?', (copied['id'],)).fetchone()[0] == 'translated'
        assert conn.execute('SELECT data FROM memos WHERE doc_id=?', (copied['id'],)).fetchone()[0] == '{}'
        assert conn.execute("SELECT preferred_workspace_mode FROM user_workspace_settings WHERE username='local-user'").fetchone()[0] == 'general'
    assert (root / 'local-doc' / 'document.pdf').read_bytes() == b'%PDF-local-doc'
    assert (root / copied['id'] / 'document.pdf').read_bytes() == b'%PDF-remote-doc'


@pytest.mark.parametrize('status,content', [(401, b'{}'), (404, b'{}'), (200, b'not a zip')])
def test_failed_download_does_not_modify_local_data(manager, isolated_dirs, monkeypatch, status, content):
    mock_upstream(monkeypatch, lambda request: httpx.Response(status, stream=httpx.ByteStream(content)))
    asyncio.run(manager.copy_to_local(TARGET, {}))
    assert manager.job['status'] == 'failed'
    with isolated_dirs['db'].get_db() as conn:
        assert conn.execute('SELECT COUNT(*) FROM documents').fetchone()[0] == 0


def test_switching_and_duplicate_download_are_blocked_while_busy(manager):
    class PendingTask:
        def done(self):
            return False
    manager.download_task = PendingTask()
    manager.config.update(enabled=True, server_url=TARGET)
    with TestClient(manager.app, base_url=ORIGIN) as client:
        assert client.put('/desktop/connection', headers=HEADERS, json={'enabled': False}).status_code == 409
        assert client.post('/desktop/download', headers=HEADERS).status_code == 409


def test_web_server_does_not_install_desktop_controls(monkeypatch):
    # Importing the service alone must not register any desktop-only endpoints.
    monkeypatch.delenv('EASYPAPER_DESKTOP', raising=False)
    import main
    assert main.desktop_connections is None


@pytest.mark.parametrize('saved', [
    {'enabled': True, 'onboarded': True, 'server_url': ''},
    {'ports': {TARGET: 9000, 'https://other.example': 9000}},
    {'ports': {TARGET: 'invalid'}},
])
def test_invalid_saved_config_requires_selection_without_overwriting_file(tmp_path, saved):
    path = tmp_path / 'connection.json'
    original = json.dumps(saved)
    path.write_text(original)
    manager = DesktopConnections(FastAPI(), path, 8000)
    assert manager.config_error
    assert not manager.config['onboarded']
    assert not manager.config['enabled']
    assert path.read_text() == original
