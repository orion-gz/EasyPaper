"""Exercise current desktop offline and inference contracts through real SSH."""
import asyncio
import json

import asyncssh
import httpx
import pytest
from fastapi import FastAPI, Request

from services import lab_inference
from services.desktop_connection import DesktopConnections, RemoteGateway, remote_cookie_name
from services.ssh_connections import manager, secrets
from test_ssh_connections import SSHServer


async def services(respond):
    async def handle(reader, writer):
        try:
            raw = await reader.readuntil(b'\r\n\r\n')
            lines = raw.decode().split('\r\n')
            method, path, _ = lines[0].split()
            headers = {key.lower(): value for key, value in (line.split(': ', 1) for line in lines[1:] if ': ' in line)}
            body = await reader.readexactly(int(headers.get('content-length', 0)))
            payload, extra = respond(method, path, headers, body)
            data = json.dumps(payload).encode()
            writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n'
                         + f'Content-Length: {len(data)}\r\n'.encode() + extra + b'\r\n' + data)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()
    service = await asyncio.start_server(handle, '127.0.0.1', 0)
    host_key = asyncssh.generate_private_key('ssh-ed25519')
    ssh = await asyncssh.create_server(SSHServer, '127.0.0.1', 0, server_host_keys=[host_key])
    profile = {'url': f'http://127.0.0.1:{service.sockets[0].getsockname()[1]}', 'transport': 'ssh',
               'ssh': {'host': '127.0.0.1', 'port': ssh.get_port(), 'username': 'test',
                       'host_key': host_key.export_public_key().decode()}}
    return service, ssh, profile


@pytest.mark.asyncio
async def test_offline_login_account_binding_and_remote_settings_use_ssh(tmp_path, monkeypatch):
    calls = []
    def respond(method, path, headers, body):
        calls.append((path, headers))
        if path.endswith('/auth/login'):
            return {'message': 'signed in'}, b'Set-Cookie: session_token=remote; HttpOnly; Path=/\r\n'
        if path.endswith('/sync/info'):
            assert headers.get('cookie') == 'session_token=remote'
            return {'account': 'account-id'}, b''
        return {'remote': True}, b''
    service, ssh, profile = await services(respond)
    target = 'http://stable.ssh.easypaper.invalid'
    profile.update(url=profile['url'] + '/paper', logical_url=target)
    monkeypatch.setitem(secrets.memory, 'desktop:' + target, {'password': 'secret'})
    app = FastAPI()
    @app.get('/api/library')
    async def library(request: Request):
        return {'owner': request.scope['desktop_offline_user']}
    desktop = DesktopConnections(app, tmp_path / 'connection.json', 8000)
    desktop.config.update(enabled=True, server_url=target, connections={target: profile},
        access_modes={target: 'offline'}, sync_options={target: {'action': 'merge', 'offline_ready': True, 'offline_locked': True}})
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=RemoteGateway(desktop, target)), base_url='http://127.0.0.1:9000') as connection:
            connection.cookies.set('session_token', 'local-secret')
            assert (await connection.get('/api/library')).status_code == 401
            login = await connection.post('/api/auth/login')
            assert login.status_code == 200
            assert connection.cookies.get(remote_cookie_name(target)) == 'remote'
            assert not desktop.sync.options(target)['offline_locked']
            assert desktop.sync.options(target)['account'] == 'account-id'
            for path in ('/api/inference/servers', '/api/me/model-settings', '/api/lab/inference'):
                assert (await connection.get(path)).json()['remote']
            assert (await connection.get('/api/library')).json()['owner'] == desktop.local_user(target)
            assert all(path.startswith('/paper/api/') for path, _ in calls)
            assert all('local-secret' not in headers.get('cookie', '') for _, headers in calls)
            assert (await connection.post('/api/auth/logout')).status_code == 200
            assert (await connection.get('/api/library')).status_code == 401
    finally:
        await manager.close('desktop:' + target)
        service.close(); await service.wait_closed()
        ssh.close(); await ssh.wait_closed()


@pytest.mark.asyncio
async def test_vllm_openapi_and_real_probe_use_selected_ssh_server(monkeypatch):
    calls = []
    def respond(method, path, headers, body):
        calls.append(path)
        assert headers.get('authorization') == 'Bearer api-secret'
        if path == '/openapi.json':
            schema = {'properties': {'cache_salt': {'type': 'string'}}}
            return {'paths': {'/v1/chat/completions': {'post': {'requestBody': {'content': {'application/json': {'schema': schema}}}}}}}, b''
        assert path == '/v1/chat/completions'
        payload = json.loads(body)
        assert payload['cache_salt'] and payload['model'] == 'test-model'
        return {'choices': [{'message': {'content': 'OK'}}]}, b''
    service, ssh, profile = await services(respond)
    profile.update(id='integration', engine='vllm', model='test-model', url=profile['url'] + '/v1', api_key='api-secret')
    key = 'inference:integration'
    monkeypatch.setitem(secrets.memory, key, {'password': 'secret'})
    lab_inference._verified.clear()
    try:
        assert (await lab_inference.probe(profile))['inference_verified']
        assert calls == ['/openapi.json', '/v1/chat/completions']
    finally:
        await manager.close(key)
        service.close(); await service.wait_closed()
        ssh.close(); await ssh.wait_closed()
