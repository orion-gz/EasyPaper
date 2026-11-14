"""Desktop-only connection gateway. Each server has its own loopback origin.

The UI and native capabilities always stay local. Remote API requests never fall
back to the local database, and local authentication is never forwarded upstream.
"""
import asyncio
from contextlib import nullcontext
import hashlib
from http.cookies import CookieError, SimpleCookie
import json
import logging
import re
from pathlib import Path
import socket
import tempfile
from urllib.parse import urlsplit, urlunsplit

import httpx
import anyio
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool
import uvicorn

from services.atomic_io import atomic_write_text

logger = logging.getLogger(__name__)
REQUEST_HEADERS = ('accept', 'content-type', 'range', 'if-range', 'if-none-match', 'if-modified-since')
RESPONSE_HEADERS = ('content-type', 'content-length', 'content-encoding', 'content-disposition',
                    'content-range', 'accept-ranges', 'etag', 'last-modified', 'retry-after')


def normalize_server_url(value):
    try:
        url = urlsplit(value.strip())
        if (url.scheme not in ('http', 'https') or not url.hostname or url.username is not None
                or url.password is not None or url.query or url.fragment or url.port == 0
                or any(c.isspace() or ord(c) < 32 for c in value)
                or '\\' in value or '%' in url.netloc
                or any(part in ('.', '..') for part in url.path.split('/'))):
            raise ValueError()
        # URL paths are kept to support servers deployed below a reverse-proxy prefix.
        return urlunsplit((url.scheme, url.netloc.lower(), url.path.rstrip('/'), '', ''))
    except (ValueError, AttributeError):
        raise HTTPException(400, 'Enter an HTTP(S) server URL without credentials, query or fragment.')


def remote_cookie_name(url):
    return 'easypaper_remote_' + hashlib.sha256(url.encode()).hexdigest()[:24]


def upstream_headers(request, target):
    headers = {key: request.headers[key] for key in REQUEST_HEADERS if key in request.headers}
    headers['accept-encoding'] = 'identity'
    token = request.cookies.get(remote_cookie_name(target))
    if token:
        cookie = SimpleCookie()
        cookie['session_token'] = token
        headers['cookie'] = cookie.output(header='', sep='').strip()
    return headers


class GatewayServer(uvicorn.Server):
    def capture_signals(self):
        # The primary server owns process signals and shuts down this listener.
        return nullcontext()


class RemoteGateway:
    def __init__(self, manager, target):
        self.manager = manager
        self.target = target

    async def __call__(self, scope, receive, send):
        if scope['type'] == 'lifespan':
            while True:
                message = await receive()
                if message['type'] == 'lifespan.startup':
                    await send({'type': 'lifespan.startup.complete'})
                elif message['type'] == 'lifespan.shutdown':
                    await send({'type': 'lifespan.shutdown.complete'})
                    return
        if scope['type'] == 'websocket':
            await send({'type': 'websocket.close', 'code': 1008})
            return
        if scope['type'] != 'http':
            return
        scope = dict(scope, desktop_remote_target=self.target)
        request = Request(scope, receive)
        if scope['path'] == '/api' or scope['path'].startswith('/api/'):
            options = self.manager.sync.options(self.target)
            if (request.url.hostname != '127.0.0.1' or request.headers.get('sec-fetch-site') == 'cross-site'
                    or (request.headers.get('origin') and request.headers['origin'] != str(request.base_url).rstrip('/'))):
                await JSONResponse({'detail': 'Invalid desktop host.'}, status_code=403)(scope, receive, send)
                return
            if self.manager.offline(self.target) and scope['path'] in ('/api/auth/logout', '/api/auth/login') and request.method == 'POST':
                options['offline_locked'] = True
                options['automatic'] = False
                self.manager.save()
                if scope['path'] == '/api/auth/logout':
                    response = JSONResponse({'message': 'Offline library locked.'})
                    response.delete_cookie(remote_cookie_name(self.target), path='/')
                    await response(scope, receive, send)
                    return
            if (self.manager.offline(self.target) and options.get('offline_locked')
                    and scope['path'] not in ('/api/auth/login', '/api/auth/logout')):
                await JSONResponse({'detail': 'Sign in to unlock the offline library.'}, status_code=401)(scope, receive, send)
                return
            if (self.manager.offline(self.target) and options.get('offline_ready')
                    and (not scope['path'].startswith('/api/auth/') or scope['path'] == '/api/auth/check')
                    and not scope['path'].startswith(('/api/lab/', '/api/inference/', '/api/me/'))):
                origin = request.headers.get('origin')
                if (request.url.hostname != '127.0.0.1'
                        or (origin and origin != str(request.base_url).rstrip('/'))
                        or request.headers.get('sec-fetch-site') == 'cross-site'):
                    await JSONResponse({'detail': 'Invalid desktop host.'}, status_code=403)(scope, receive, send)
                    return
                path = scope['path']
                document_change = (
                    path in ('/api/upload', '/api/import-url', '/api/library/trash/empty')
                    or bool(re.fullmatch(r'/api/session/[^/]+', path))
                    or bool(re.fullmatch(r'/api/library/[^/]+(?:/(?:permanent|restore|title|tags|languages|processing-policy|reparse-preview)(?:/.*)?)?', path))
                    or path.startswith('/api/user-data/import')
                    or path.startswith('/api/user-data/sync/')
                )
                if request.method not in ('GET', 'HEAD', 'OPTIONS') and document_change:
                    await JSONResponse({'detail': 'Manage documents in server access mode. Offline mode synchronizes user data only.'}, status_code=409)(scope, receive, send)
                    return
                scope['desktop_offline_user'] = self.manager.local_user(self.target)
                await self.manager.app(scope, receive, send)
                return
            response = await self.proxy(request)
            await response(scope, receive, send)
        else:
            # Static UI and desktop controls are always served by this installation.
            await self.manager.app(scope, receive, send)

    async def proxy(self, request):
        origin = request.headers.get('origin')
        if (request.url.hostname != '127.0.0.1'
                or (origin and origin != str(request.base_url).rstrip('/'))
                or request.headers.get('sec-fetch-site') == 'cross-site'):
            return JSONResponse({'detail': 'Invalid desktop host.'}, status_code=403)
        target = self.target + request.url.path
        if request.url.query:
            target += '?' + request.url.query
        client = self.manager.connection_client(self.target, timeout=httpx.Timeout(600, connect=10), follow_redirects=False, trust_env=False)
        try:
            upstream = client.build_request(request.method, target,
                                            headers=upstream_headers(request, self.target),
                                            content=request.stream())
            response = await client.send(upstream, stream=True)
            if 300 <= response.status_code < 400 and response.status_code != 304:
                await response.aclose()
                await client.aclose()
                return JSONResponse({'detail': 'Server redirected the request. Use its final URL in connection settings.'}, status_code=502)
        except HTTPException as exc:
            await client.aclose()
            return JSONResponse({'detail': exc.detail}, status_code=exc.status_code)
        except httpx.HTTPError:
            await client.aclose()
            return JSONResponse({'detail': 'Cannot reach the remote server. Check connection settings or switch to local mode.'}, status_code=502)

        async def body():
            try:
                async for chunk in response.aiter_raw():
                    yield chunk
            finally:
                with anyio.CancelScope(shield=True):
                    await response.aclose()
                    await client.aclose()

        outgoing = StreamingResponse(body(), status_code=response.status_code,
                                     headers={k: response.headers[k] for k in RESPONSE_HEADERS if k in response.headers})
        outgoing.headers['cache-control'] = 'no-store'
        # Ports do not isolate cookies. Give each remote server a separate cookie
        # name; never expose its session as the local server's session_token.
        for value in response.headers.get_list('set-cookie'):
            cookies = SimpleCookie()
            try:
                cookies.load(value)
                cookie = cookies.get('session_token')
                if cookie:
                    max_age = int(cookie['max-age']) if cookie['max-age'] else None
                    if request.url.path == '/api/auth/login' and response.status_code == 200 and self.manager.offline(self.target):
                        try:
                            async with self.manager.connection_client(self.target, timeout=15, trust_env=False) as identity_client:
                                identity = await identity_client.get(self.target + '/api/user-data/sync/info',
                                    headers={'cookie': 'session_token=' + cookie.value, 'x-easypaper-sync-binding': '1'})
                        except (httpx.HTTPError, HTTPException):
                            await response.aclose()
                            await client.aclose()
                            return JSONResponse({'detail': 'Could not verify the offline account. Sign in again when the server is reachable.'}, status_code=502)
                        options = self.manager.sync.options(self.target)
                        if identity.status_code == 200 and identity.json().get('account') and options.get('account') in (None, identity.json().get('account')):
                            options['account'] = identity.json()['account']
                            options['offline_locked'] = False
                            options['automatic'] = True
                            self.manager.save()
                        else:
                            await response.aclose()
                            await client.aclose()
                            return JSONResponse({'detail': 'This offline library belongs to another account. Sign in with its account or switch to server access mode.'}, status_code=409)
                    outgoing.set_cookie(remote_cookie_name(self.target), cookie.value,
                                        max_age=max_age, expires=cookie['expires'] or None,
                                        httponly=True, samesite='strict', path='/')
            except (CookieError, ValueError, TypeError):
                logger.warning('Ignored an invalid remote session cookie')
        return outgoing


class DesktopConnections:
    def __init__(self, app, config_path, local_port):
        self.app = app
        self.config_path = Path(config_path)
        self.local_port = local_port
        self.config = {'enabled': False, 'server_url': '', 'onboarded': False, 'ports': {}, 'sync_options': {}, 'access_modes': {}, 'connections': {}}
        self.config_error = None
        try:
            saved = json.loads(self.config_path.read_text())
            if (not isinstance(saved, dict) or not isinstance(saved.get('ports', {}), dict)
                    or not isinstance(saved.get('enabled', False), bool)
                    or not isinstance(saved.get('onboarded', False), bool)
                    or not isinstance(saved.get('sync_options', {}), dict)
                    or not isinstance(saved.get('access_modes', {}), dict)
                    or not isinstance(saved.get('connections', {}), dict)
                    or any(not isinstance(value, dict) for value in saved.get('connections', {}).values())
                    or any(v not in ('server', 'offline') for v in saved.get('access_modes', {}).values())):
                raise ValueError('Invalid connection settings')
            if saved.get('server_url'):
                saved['server_url'] = normalize_server_url(saved['server_url'])
            if saved.get('enabled') and not saved.get('server_url'):
                raise ValueError('Missing remote server URL')
            ports = saved.get('ports', {})
            if (any(not isinstance(port, int) or not 1024 <= port <= 65535 for port in ports.values())
                    or len(set(ports.values())) != len(ports)):
                raise ValueError('Invalid or overlapping server origins')
            from services.desktop_sync import POLICIES
            if any(not isinstance(options, dict) or options.get('action') not in POLICIES
                   or not isinstance(options.get('automatic', False), bool)
                   for options in saved.get('sync_options', {}).values()):
                raise ValueError('Invalid synchronization preferences')
            self.config.update({key: saved[key] for key in self.config if key in saved})
        except FileNotFoundError:
            pass
        except (ValueError, HTTPException):
            self.config_error = 'Connection settings could not be read. Choose a connection again.'
            logger.warning('Invalid desktop connection settings; leaving the original file intact')
        self.listeners = {}
        self.lock = asyncio.Lock()
        self.job = {'status': 'idle', 'bytes': 0}
        self.download_task = None
        self.router = APIRouter(prefix='/desktop')
        self.router.add_api_route('/ssh/host-key', self.host_key, methods=['POST'])
        self.router.add_api_route('/connection', self.read, methods=['GET'])
        self.router.add_api_route('/connection', self.update, methods=['PUT'])
        self.router.add_api_route('/download', self.download, methods=['POST'])
        self.router.add_api_route('/download', self.download_status, methods=['GET'])
        from services.desktop_sync import DesktopSync
        self.sync = DesktopSync(self)

    def offline(self, target):
        return self.config.get('access_modes', {}).get(target) == 'offline'

    def local_user(self, target):
        account = self.sync.options(target).get('account')
        if not account:
            raise HTTPException(409, 'Download the offline library first.')
        return 'offline-' + hashlib.sha256((target + '\n' + account).encode()).hexdigest()

    def connection_client(self, target, **kwargs):
        from services.ssh_connections import client
        return client('desktop:' + target, self.config['connections'].get(target, {'url': target}), **kwargs)

    async def host_key(self, request: Request):
        self.guard(request)
        from services.ssh_connections import SSHSettings, discover_host_key
        from pydantic import ValidationError
        try:
            data = SSHSettings(**await request.json())
        except (ValueError, TypeError, ValidationError):
            raise HTTPException(400, 'Invalid SSH settings.')
        return await discover_host_key(data)

    def save(self):
        atomic_write_text(str(self.config_path), json.dumps(self.config, indent=2))

    async def start(self):
        if self.config['enabled'] and self.config['server_url']:
            try:
                await self.ensure_gateway(self.config['server_url'])
                self.save()
            except (OSError, RuntimeError, HTTPException):
                self.config_error = 'Could not start the remote connection. Choose a connection again.'
                self.config['enabled'] = False

    async def close(self):
        if self.download_task and not self.download_task.done():
            if self.job['status'] != 'importing':
                self.download_task.cancel()
            await asyncio.gather(self.download_task, return_exceptions=True)
        from services.ssh_connections import manager
        for target in self.config['connections']:
            await manager.close('desktop:' + target)
        for server, task, sock in self.listeners.values():
            server.should_exit = True
        for server, task, sock in self.listeners.values():
            await task
            sock.close()

    async def ensure_gateway(self, target):
        if target in self.listeners:
            return self.listeners[target][2].getsockname()[1]
        preferred = self.config['ports'].get(target, 0)
        if preferred == self.local_port:
            raise HTTPException(409, 'The saved connection port is in use by this app. Restart EasyPaper and retry.')
        if not isinstance(preferred, int) or not 1024 <= preferred <= 65535:
            preferred = 0
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.bind(('127.0.0.1', preferred))
            if not preferred:
                reserved = set(self.config['ports'].values()) | {self.local_port}
                for _ in range(100):
                    if sock.getsockname()[1] not in reserved:
                        break
                    sock.close()
                    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    sock.bind(('127.0.0.1', 0))
                else:
                    raise OSError('No unused connection origin available')
        except OSError:
            # Never silently reuse another origin: it may contain another
            # server's browser data. Let the user free the saved port and retry.
            sock.close()
            raise HTTPException(409, f'Connection port {preferred} is in use. Close the other application and retry.')
        sock.listen(128)
        sock.setblocking(False)
        port = sock.getsockname()[1]
        server = GatewayServer(uvicorn.Config(RemoteGateway(self, target), host='127.0.0.1', port=port,
                                             lifespan='off', access_log=False, log_config=None))
        task = asyncio.create_task(server.serve(sockets=[sock]))
        for _ in range(100):
            if server.started:
                break
            if task.done():
                sock.close()
                raise RuntimeError('Gateway startup failed')
            await asyncio.sleep(.01)
        if not server.started:
            server.should_exit = True
            await task
            sock.close()
            raise RuntimeError('Gateway startup timed out')
        self.listeners[target] = (server, task, sock)
        self.config['ports'][target] = port
        return port

    def guard(self, request):
        if (request.url.hostname != '127.0.0.1'
                or not request.client or request.client.host not in ('127.0.0.1', 'testclient')
                or request.headers.get('x-easypaper-desktop') != '1'):
            raise HTTPException(403, 'Desktop controls require a local application request.')
        origin = request.headers.get('origin')
        if origin and origin != str(request.base_url).rstrip('/'):
            raise HTTPException(403, 'Cross-origin desktop controls are not allowed.')
        if request.headers.get('sec-fetch-site') == 'cross-site':
            raise HTTPException(403, 'Cross-site desktop controls are not allowed.')

    def snapshot(self, request):
        from services.ssh_connections import secrets
        port = self.local_port
        if self.config['enabled']:
            port = self.config['ports'].get(self.config['server_url'], port)
        return {'credential_storage': secrets.availability(), 'enabled': self.config['enabled'], 'server_url': self.config['connections'].get(self.config['server_url'], {}).get('url', self.config['server_url']),
                'connection': self.config['connections'].get(self.config['server_url'], {}),
                'onboarded': self.config['onboarded'], 'error': self.config_error,
                'remote': bool(request.scope.get('desktop_remote_target')),
                'current_server': request.scope.get('desktop_remote_target', ''),
                'sync': self.sync.options(self.config['server_url']),
                'access_mode': self.config.get('access_modes', {}).get(self.config['server_url'], 'server'),
                'destination': f'http://127.0.0.1:{port}/',
                'local_url': f'http://127.0.0.1:{self.local_port}/'}

    async def read(self, request: Request):
        self.guard(request)
        return JSONResponse(self.snapshot(request), headers={'Cache-Control': 'no-store'})

    async def update(self, request: Request):
        self.guard(request)
        try:
            raw = bytearray()
            async for chunk in request.stream():
                raw.extend(chunk)
                if len(raw) > 65536:
                    raise ValueError()
            body = json.loads(raw)
            if not isinstance(body, dict) or not isinstance(body.get('enabled'), bool):
                raise ValueError()
            if body.get('access_mode', 'server') not in ('server', 'offline'):
                raise ValueError()
            if 'sync' in body:
                from services.desktop_sync import POLICIES
                options = body['sync']
                if (not isinstance(options, dict) or options.get('action') not in POLICIES
                        or not isinstance(options.get('automatic', False), bool)):
                    raise ValueError()
        except (ValueError, TypeError):
            raise HTTPException(400, 'Invalid connection settings.')
        async with self.lock:
            if self.download_task and not self.download_task.done():
                raise HTTPException(409, 'Wait for the local download to finish before changing connections.')
            target = normalize_server_url(body.get('server_url', '')) if body['enabled'] else self.config['server_url']
            import copy
            previous = copy.deepcopy(self.config)
            profile = None
            current_profile = self.config['connections'].get(self.config['server_url'], {})
            if 'transport' not in body and target == current_profile.get('url'):
                target = self.config['server_url']
            if body['enabled'] and 'transport' in body:
                from services.inference_servers import ServerSettings
                from services.ssh_connections import secrets, manager
                from pydantic import ValidationError
                try:
                    profile = ServerSettings(name='Desktop', engine='ollama', url=target,
                        transport=body['transport'], ssh=body.get('ssh'),
                        credentials=body.get('credentials') or {}, save_credentials=body.get('save_credentials', False))
                except ValidationError:
                    raise HTTPException(400, 'Invalid SSH connection settings.')
                if profile.transport == 'ssh':
                    fingerprint = hashlib.sha256(json.dumps([profile.ssh.host, profile.ssh.port, profile.ssh.username, target]).encode()).hexdigest()[:32]
                    target = 'http://' + fingerprint + '.ssh.easypaper.invalid'
                key = 'desktop:' + target
                manager.guard(key)
                try:
                    credentials = secrets.get(key)
                except HTTPException:
                    if not any(profile.credentials.model_dump().values()):
                        raise
                    credentials = {}
                credentials.update({k: v for k, v in profile.credentials.model_dump().items() if v})
                profile = profile.model_dump(exclude={'credentials'})
                profile['logical_url'] = target
                if profile['transport'] == 'ssh':
                    import uuid
                    candidate = 'candidate:' + uuid.uuid4().hex
                    secrets.memory[candidate] = credentials
                    try:
                        await manager.port(candidate, profile)
                    finally:
                        await manager.close(candidate)
                        secrets.memory.pop(candidate, None)
                        manager.locks.pop(candidate, None)
                manager.guard(key)
            if body['enabled']:
                parsed = urlsplit(target)
                own_ports = {self.local_port, *self.config['ports'].values()}
                if parsed.hostname in ('127.0.0.1', 'localhost', '::1') and (parsed.port or 80) in own_ports:
                    raise HTTPException(400, 'Choose an EasyPaper server, not this desktop application.')
                await self.ensure_gateway(target)
            if profile is not None:
                manager.guard(key)
                self.config['connections'][target] = profile
            self.config.update(enabled=body['enabled'], server_url=target, onboarded=True)
            if 'access_mode' in body:
                self.config.setdefault('access_modes', {})[target] = body['access_mode']
            if 'sync' in body:
                self.config['sync_options'][target] = {**self.config['sync_options'].get(target, {}), 'action': body['sync']['action'],
                    'automatic': body['sync'].get('automatic', False) and body['sync']['action'] == 'merge'}
            try:
                self.save()
                if profile is not None:
                    secrets.put(key, credentials, profile['save_credentials'])
            except OSError:
                self.config = previous
                raise HTTPException(500, 'Could not save connection settings.')
            except HTTPException:
                self.config = previous
                self.save()
                raise
            if profile is not None:
                await manager.close(key)
            self.config_error = None
            return self.snapshot(request)

    async def download_status(self, request: Request):
        self.guard(request)
        return JSONResponse(self.job, headers={'Cache-Control': 'no-store'})

    async def download(self, request: Request):
        self.guard(request)
        if self.offline(self.config['server_url']):
            raise HTTPException(409, 'Use synchronization to update the offline library.')
        async with self.lock:
            if not self.config['enabled']:
                raise HTTPException(409, 'Connect to a remote server first.')
            if self.download_task and not self.download_task.done():
                raise HTTPException(409, 'A local download is already running.')
            target = self.config['server_url']
            self.job = {'status': 'downloading', 'bytes': 0}
            self.download_task = asyncio.create_task(self.copy_to_local(target, upstream_headers(request, target)))
            return JSONResponse(self.job, status_code=202)

    async def copy_to_local(self, target, headers):
        from config import get_app_username
        from services import data_transfer
        try:
            # Only remote authentication is forwarded; local credentials and
            # settings never leave this machine. Large archives stay on disk.
            headers = {k: v for k, v in headers.items() if k in ('cookie', 'accept-encoding')}
            async with self.connection_client(target, timeout=httpx.Timeout(600, connect=10), follow_redirects=False, trust_env=False) as client:
                with tempfile.TemporaryFile() as archive:
                    async with client.stream('POST', target + '/api/user-data/export', json={}, headers=headers) as response:
                        if response.status_code in (401, 403):
                            raise ValueError('Sign in to the remote server before downloading.')
                        if response.status_code == 404:
                            raise ValueError('This server does not support data export. Update EasyPaper on the server.')
                        if response.status_code != 200:
                            raise ValueError(f'Server export failed (HTTP {response.status_code}).')
                        async for chunk in response.aiter_bytes():
                            self.job['bytes'] += len(chunk)
                            if self.job['bytes'] > data_transfer.MAX_ARCHIVE_BYTES:
                                raise ValueError('The server backup exceeds the 4 GiB limit.')
                            await run_in_threadpool(archive.write, chunk)
                    archive.seek(0)
                    self.job['status'] = 'importing'
                    result = await run_in_threadpool(data_transfer.import_archive, get_app_username(), archive,
                                                    preserve_user_settings=True)
            self.job.update(status='completed', documents=result['documents'])
        except (httpx.HTTPError, ValueError, OSError) as exc:
            self.job.update(status='failed', error=str(exc) or 'Could not download the server data.')
        except Exception:
            logger.exception('Desktop server download failed')
            self.job.update(status='failed', error='Could not import the server backup. Existing local data was preserved.')


def install_desktop_connections(app, config_path, local_port):
    manager = DesktopConnections(app, config_path, local_port)
    app.include_router(manager.router)
    return manager
