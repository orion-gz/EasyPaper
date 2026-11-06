import asyncio
import ssl
from datetime import datetime, timedelta, timezone

import asyncssh
import httpx
import pytest
from fastapi import HTTPException

from services.ssh_connections import TunnelManager, SecretStore, discover_host_key, SSHSettings, client, manager, secrets


class SSHServer(asyncssh.SSHServer):
    def begin_auth(self, username):
        return True

    def password_auth_supported(self):
        return True

    def validate_password(self, username, password):
        return username == 'test' and password == 'secret'

    def public_key_auth_supported(self):
        return True

    def validate_public_key(self, username, key):
        return username == 'test'

    def connection_requested(self, dest_host, dest_port, orig_host, orig_port):
        return True


@pytest.mark.asyncio
@pytest.mark.parametrize('auth', ['password', 'key', 'encrypted_key'])
async def test_real_ssh_forwarding_and_reconnect(auth, monkeypatch):
    host_key = asyncssh.generate_private_key('ssh-ed25519')
    ssh_server = await asyncssh.create_server(SSHServer, '127.0.0.1', 0, server_host_keys=[host_key])
    async def handle(reader, writer):
        await reader.readuntil(b'\r\n\r\n')
        writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK')
        await writer.drain()
        writer.close()
    service = await asyncio.start_server(handle, '127.0.0.1', 0)
    profile = {'url': f'http://127.0.0.1:{service.sockets[0].getsockname()[1]}', 'transport': 'ssh',
               'ssh': {'host': '127.0.0.1', 'port': ssh_server.get_port(), 'username': 'test',
                       'host_key': host_key.export_public_key().decode(), 'auth': 'password' if auth == 'password' else 'key'}}
    credentials = {'password': 'secret'}
    if auth != 'password':
        key = asyncssh.generate_private_key('ssh-ed25519')
        phrase = 'phrase' if auth == 'encrypted_key' else None
        credentials = {'private_key': key.export_private_key(passphrase=phrase).decode(), 'passphrase': phrase}
    monkeypatch.setitem(secrets.memory, 'test', credentials)
    try:
        found = await discover_host_key(SSHSettings(**profile['ssh']))
        assert found['fingerprint'] == host_key.get_fingerprint('sha256')
        async with client('test', profile, timeout=3) as connection:
            assert (await connection.get(profile['url'])).text == 'OK'
        await manager.close('test')
        async with client('test', profile, timeout=3) as connection:
            assert (await connection.get(profile['url'])).text == 'OK'
        await manager.close('test')
        profile['ssh']['host_key'] = asyncssh.generate_private_key('ssh-ed25519').export_public_key().decode()
        with pytest.raises(HTTPException) as error:
            await manager.port('test', profile)
        assert error.value.status_code == 409
    finally:
        await manager.close('test')
        service.close(); await service.wait_closed()
        ssh_server.close(); await ssh_server.wait_closed()


@pytest.mark.asyncio
async def test_tls_identity_preserved(tmp_path, monkeypatch):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'localhost')])
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
            .not_valid_after(datetime.now(timezone.utc) + timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]), critical=False).sign(key, hashes.SHA256()))
    cert_path, key_path = tmp_path / 'cert.pem', tmp_path / 'key.pem'
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_path, key_path)
    seen = []
    context.set_servername_callback(lambda socket, name, ctx: seen.append(name))
    async def handle(reader, writer):
        await reader.readuntil(b'\r\n\r\n')
        writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK')
        await writer.drain(); writer.close()
    service = await asyncio.start_server(handle, '127.0.0.1', 0, ssl=context)
    host_key = asyncssh.generate_private_key('ssh-ed25519')
    ssh_server = await asyncssh.create_server(SSHServer, '127.0.0.1', 0, server_host_keys=[host_key])
    profile = {'url': f'https://localhost:{service.sockets[0].getsockname()[1]}', 'transport': 'ssh',
               'ssh': {'host': '127.0.0.1', 'port': ssh_server.get_port(), 'username': 'test', 'host_key': host_key.export_public_key().decode()}}
    monkeypatch.setitem(secrets.memory, 'tls', {'password': 'secret'})
    from services.ssh_connections import TunnelTransport
    transport = TunnelTransport('tls', profile)
    transport.transport = httpx.AsyncHTTPTransport(verify=ssl.create_default_context(cafile=str(cert_path)))
    try:
        async with httpx.AsyncClient(transport=transport) as connection:
            assert (await connection.get(profile['url'])).text == 'OK'
        assert seen == ['localhost']
        await manager.close('tls')
        profile['url'] = profile['url'].replace('localhost', '127.0.0.1')
        transport = TunnelTransport('tls', profile)
        transport.transport = httpx.AsyncHTTPTransport(verify=ssl.create_default_context(cafile=str(cert_path)))
        async with httpx.AsyncClient(transport=transport) as connection:
            with pytest.raises(httpx.ConnectError):
                await connection.get(profile['url'])
    finally:
        await manager.close('tls')
        service.close(); await service.wait_closed()
        ssh_server.close(); await ssh_server.wait_closed()


def test_secret_encryption_and_memory_only(tmp_path, monkeypatch):
    from cryptography.fernet import Fernet
    monkeypatch.delenv('EASYPAPER_DESKTOP', raising=False)
    monkeypatch.setattr('config._get_config_dir', lambda: str(tmp_path))
    monkeypatch.delenv('EASYPAPER_CONNECTION_KEY', raising=False)
    store = SecretStore()
    with pytest.raises(HTTPException):
        store.put('server', {'password': 'secret'}, True)
    monkeypatch.setenv('EASYPAPER_CONNECTION_KEY', Fernet.generate_key().decode())
    store.put('server', {'password': 'secret'}, True)
    assert b'secret' not in store.path('server').read_bytes()
    assert SecretStore().get('server')['password'] == 'secret'
    store.put('server', {'password': 'temporary'}, False)
    assert not store.path('server').exists()
    assert SecretStore().get('server') == {}


@pytest.mark.asyncio
async def test_active_request_guard():
    instance = TunnelManager()
    async with instance.lease('one'):
        with pytest.raises(HTTPException):
            instance.guard('one')
        instance.guard('two')
    instance.guard('one')


def test_desktop_without_keyring_can_use_memory_credentials(monkeypatch):
    import keyring
    def unavailable(*args):
        raise keyring.errors.NoKeyringError('unavailable')
    monkeypatch.setenv('EASYPAPER_DESKTOP', '1')
    monkeypatch.setattr(keyring, 'get_password', unavailable)
    store = SecretStore()
    assert store.get('temporary') == {}
    store.put('temporary', {'password': 'session-password'}, persist=False)
    assert store.get('temporary') == {'password': 'session-password'}
    assert SecretStore().get('temporary') == {}
