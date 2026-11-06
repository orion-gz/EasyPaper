"""Backend-owned SSH tunnels and secret storage. HTTP URLs retain their identity."""
import asyncio
from contextlib import asynccontextmanager
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, Field


class SSHSettings(BaseModel):
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(min_length=1, max_length=200)
    auth: str = Field(default='password', pattern='^(password|key)$')
    host_key: str = Field(default='', max_length=16384)


class Credentials(BaseModel):
    password: str = Field(default='', max_length=4096)
    private_key: str = Field(default='', max_length=32768)
    passphrase: str = Field(default='', max_length=4096)
    api_key: str = Field(default='', max_length=4096)


class SecretStore:
    def __init__(self):
        self.memory = {}

    def path(self, identifier):
        from config import _get_config_dir
        name = hashlib.sha256(identifier.encode()).hexdigest()
        return Path(_get_config_dir()) / 'connection-secrets' / name

    def cipher(self):
        from cryptography.fernet import Fernet
        key = os.getenv('EASYPAPER_CONNECTION_KEY')
        if not key:
            raise HTTPException(409, 'Persistent credentials require EASYPAPER_CONNECTION_KEY.')
        try:
            return Fernet(key.encode())
        except ValueError:
            raise HTTPException(409, 'Invalid connection encryption key.')

    def availability(self):
        try:
            if os.getenv('EASYPAPER_DESKTOP') == '1':
                import keyring
                backend = type(keyring.get_keyring()).__module__
                if not backend.startswith(('keyring.backends.macOS', 'keyring.backends.Windows', 'keyring.backends.SecretService')):
                    return {'available': False, 'reason': 'Secure OS credential storage unavailable.'}
            else:
                self.cipher()
            return {'available': True}
        except Exception:
            return {'available': False, 'reason': 'Configure secure credential storage to enable saving.'}

    def get(self, identifier):
        if identifier in self.memory:
            return dict(self.memory[identifier])
        try:
            if os.getenv('EASYPAPER_DESKTOP') == '1':
                import keyring
                try:
                    value = keyring.get_password('EasyPaper connections', identifier)
                except keyring.errors.NoKeyringError:
                    return {}
                return json.loads(value) if value else {}
            path = self.path(identifier)
            return json.loads(self.cipher().decrypt(path.read_bytes())) if path.exists() else {}
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(409, 'Stored credentials are unavailable. Re-enter credentials.')

    def put(self, identifier, value, persist=False):
        if persist:
            try:
                payload = json.dumps(value)
                if os.getenv('EASYPAPER_DESKTOP') == '1':
                    import keyring
                    # Reject plaintext third-party fallback backends.
                    backend = type(keyring.get_keyring()).__module__
                    if not backend.startswith(('keyring.backends.macOS', 'keyring.backends.Windows', 'keyring.backends.SecretService')):
                        raise RuntimeError('Secure OS credential storage unavailable')
                    keyring.set_password('EasyPaper connections', identifier, payload)
                else:
                    from services.atomic_io import atomic_write_text
                    encrypted = self.cipher().encrypt(payload.encode()).decode()
                    path = self.path(identifier)
                    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    atomic_write_text(str(path), encrypted)
                    path.chmod(0o600)
            except HTTPException:
                raise
            except Exception:
                raise HTTPException(409, 'Secure credential storage unavailable. Disable credential saving.')
        else:
            self.delete(identifier)
        self.memory[identifier] = dict(value)

    def delete(self, identifier):
        if os.getenv('EASYPAPER_DESKTOP') == '1':
            import keyring
            try:
                if keyring.get_password('EasyPaper connections', identifier) is not None:
                    keyring.delete_password('EasyPaper connections', identifier)
            except keyring.errors.NoKeyringError:
                pass
        else:
            self.path(identifier).unlink(missing_ok=True)
        self.memory.pop(identifier, None)


secrets = SecretStore()


class TunnelManager:
    def __init__(self):
        self.connections = {}
        self.locks = {}
        self.active = {}

    async def close(self, identifier=None):
        keys = list(self.connections) if identifier is None else [identifier]
        for key in keys:
            entry = self.connections.pop(key, None)
            if entry:
                connection, listener, _ = entry
                listener.close()
                connection.close()
                await connection.wait_closed()

    @asynccontextmanager
    async def lease(self, identifier):
        self.active[identifier] = self.active.get(identifier, 0) + 1
        try:
            yield
        finally:
            self.active[identifier] -= 1

    def guard(self, identifier):
        if self.active.get(identifier):
            raise HTTPException(409, 'Wait for this server’s active requests to finish.')

    async def port(self, identifier, profile):
        import asyncssh
        ssh = SSHSettings(**profile['ssh'])
        url = urlsplit(profile['url'])
        signature = json.dumps([ssh.model_dump(), url.hostname, url.port, url.scheme], sort_keys=True)
        lock = self.locks.setdefault(identifier, asyncio.Lock())
        async with lock:
            entry = self.connections.get(identifier)
            if entry and entry[2] == signature and not entry[0].is_closed():
                return entry[1].get_port()
            await self.close(identifier)
            if not ssh.host_key:
                raise HTTPException(409, 'Confirm the SSH host key before connecting.')
            credentials = secrets.get(identifier)
            try:
                host_key = asyncssh.import_public_key(ssh.host_key)
                options = dict(host=ssh.host, port=ssh.port, username=ssh.username,
                               known_hosts=([host_key], [], []), agent_path=None,
                               config=None, keepalive_interval=30, keepalive_count_max=3)
                if ssh.auth == 'key':
                    if not credentials.get('private_key'):
                        raise HTTPException(409, 'Enter the SSH private key.')
                    options['client_keys'] = [asyncssh.import_private_key(credentials['private_key'], credentials.get('passphrase') or None)]
                else:
                    if not credentials.get('password'):
                        raise HTTPException(409, 'Enter the SSH password.')
                    options.update(password=credentials['password'], client_keys=[])
                connection = await asyncio.wait_for(asyncssh.connect(**options), 15)
                try:
                    listener = await asyncio.wait_for(connection.forward_local_port(
                        '127.0.0.1', 0, url.hostname, url.port or (443 if url.scheme == 'https' else 80)), 10)
                except BaseException:
                    connection.close()
                    await connection.wait_closed()
                    raise
            except asyncssh.HostKeyNotVerifiable:
                raise HTTPException(409, 'SSH host key changed. Verify and confirm the new key.')
            except asyncssh.PermissionDenied:
                raise HTTPException(401, 'SSH authentication failed.')
            except (asyncssh.Error, OSError, ValueError, asyncio.TimeoutError):
                raise HTTPException(502, 'SSH connection failed. Check the host, credentials and service address.')
            self.connections[identifier] = (connection, listener, signature)
            return listener.get_port()


manager = TunnelManager()


async def discover_host_key(ssh):
    import asyncssh
    try:
        key = await asyncio.wait_for(asyncssh.get_server_host_key(ssh.host, port=ssh.port, config=None), 15)
        if key is None:
            raise ValueError()
        return {'host_key': key.export_public_key().decode().strip(), 'fingerprint': key.get_fingerprint('sha256')}
    except (asyncssh.Error, OSError, ValueError, asyncio.TimeoutError):
        raise HTTPException(502, 'Could not read the SSH server host key.')


class LeasedStream(httpx.AsyncByteStream):
    def __init__(self, stream, identifier):
        self.stream, self.identifier, self.closed = stream, identifier, False

    async def __aiter__(self):
        async for chunk in self.stream:
            yield chunk

    async def aclose(self):
        if not self.closed:
            self.closed = True
            try:
                await self.stream.aclose()
            finally:
                manager.active[self.identifier] -= 1


class TunnelTransport(httpx.AsyncBaseTransport):
    def __init__(self, identifier, profile):
        self.identifier, self.profile = identifier, profile
        self.transport = httpx.AsyncHTTPTransport()

    async def handle_async_request(self, request):
        source = httpx.URL(self.profile['url'])
        logical = httpx.URL(self.profile.get('logical_url', self.profile['url']))
        if (request.url.scheme, request.url.host, request.url.port) != (logical.scheme, logical.host, logical.port):
            raise httpx.ConnectError('Connection target does not match its SSH profile.', request=request)
        manager.active[self.identifier] = manager.active.get(self.identifier, 0) + 1
        try:
            response = await self.forward(request, source)
        except BaseException:
            manager.active[self.identifier] -= 1
            raise
        response.stream = LeasedStream(response.stream, self.identifier)
        return response

    async def forward(self, request, source):
        if self.profile.get('api_key') and 'authorization' not in request.headers:
            request.headers['authorization'] = 'Bearer ' + self.profile['api_key']
        if self.profile.get('transport') != 'ssh':
            return await self.transport.handle_async_request(request)
        port = await manager.port(self.identifier, self.profile)
        # Preserve Host and TLS server identity while dialing the loopback tunnel.
        extensions = dict(request.extensions, sni_hostname=source.host)
        headers = httpx.Headers(request.headers)
        headers['host'] = source.netloc.decode()
        path = source.path.rstrip('/') + request.url.path if self.profile.get('logical_url') else request.url.path
        destination = request.url.copy_with(scheme=source.scheme, host='127.0.0.1', port=port, path=path)
        tunneled = httpx.Request(request.method, destination,
                                 headers=headers, stream=request.stream, extensions=extensions)
        return await self.transport.handle_async_request(tunneled)

    async def aclose(self):
        await self.transport.aclose()


def client(identifier=None, profile=None, **kwargs):
    if profile is None:
        from services import lab
        selected = lab.selection()
        if selected and selected.get('provider') in ('ollama', 'vllm'):
            profile = selected
            identifier = 'inference:' + selected.get('id', 'default')
    if profile and (profile.get('transport') == 'ssh' or profile.get('api_key')):
        kwargs['transport'] = TunnelTransport(identifier, profile)
        kwargs['trust_env'] = False
        kwargs['follow_redirects'] = False
    return httpx.AsyncClient(**kwargs)
