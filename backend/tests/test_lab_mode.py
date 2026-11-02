from contextlib import closing

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from services import db, lab
from services.auth import hash_password, create_session_token, verify_session_token
from services.lab_context import identity
from routers.lab import router


@pytest.fixture
def environment(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DB_PATH', str(tmp_path / 'lab.db'))
    db.init_db()
    from config import get_app_username
    master = get_app_username()
    with closing(db.get_db()) as conn, conn:
        conn.execute('UPDATE users SET password_hash=? WHERE username=?', (hash_password('master-secret'), master))
    app = FastAPI()
    app.include_router(router, prefix='/api')
    client = TestClient(app)
    client.cookies.set('session_token', create_session_token(master))
    return client, master


def test_member_creation_and_session_revocation(environment):
    client, master = environment
    response = client.post('/api/lab/users', json={'username': 'alice'})
    assert response.status_code == 201
    alice = response.json()
    assert lab.account('alice')['must_change_password']
    assert client.post('/api/lab/users', json={'username': 'alice'}).status_code == 409
    token = create_session_token('alice')
    assert verify_session_token(token)
    assert client.post(f"/api/lab/users/{alice['id']}/reset-password").status_code == 200
    assert not verify_session_token(token)
    assert client.patch(f"/api/lab/users/{lab.account(master)['id']}", json={'active': False}).status_code == 404


def test_disabled_mode_and_member_admin_denial(environment):
    client, _ = environment
    alice = client.post('/api/lab/users', json={'username': 'alice'}).json()
    with closing(db.get_db()) as conn, conn:
        conn.execute('UPDATE lab_accounts SET must_change_password=0 WHERE username=?', ('alice',))
    assert client.put('/api/lab/settings', json={'enabled': True, 'password': 'wrong'}).status_code == 403
    assert client.put('/api/lab/settings', json={'enabled': True, 'password': 'master-secret'}).status_code == 200
    client.cookies.set('session_token', create_session_token('alice'))
    assert client.get('/api/auth/me').json()['role'] == 'member'
    assert client.get('/api/lab/users').status_code == 403
    with closing(db.get_db()) as conn, conn:
        conn.execute('UPDATE lab_settings SET enabled=0')
    assert client.get('/api/auth/me').status_code == 403


def test_cache_salt_scope_and_personal_configuration(environment):
    client, master = environment
    client.post('/api/lab/users', json={'username': 'alice'})
    assert client.put('/api/lab/settings', json={'enabled': True, 'password': 'master-secret'}).status_code == 200
    assert lab.cache_salt(master, 'doc', 1) != lab.cache_salt('alice', 'doc', 1)
    assert lab.cache_salt(master, 'doc', 1) != lab.cache_salt(master, 'doc', 2)
    assert client.put('/api/lab/inference', json={'engine': 'vllm', 'url': 'http://localhost:8001/v1', 'models': ['test'], 'model': 'test', 'api_key': 'secret'}).status_code == 200
    assert 'api_key' not in client.get('/api/lab/inference').json()
    token = identity.set(master)
    try:
        assert lab.selection()['provider'] == 'vllm'
        from config import get_chat_provider, get_chat_model
        assert get_chat_provider() == 'openai'
        assert get_chat_model() == 'test'
    finally:
        identity.reset(token)


@pytest.mark.asyncio
async def test_snapshot_gate_does_not_block_other_users(environment):
    from services.sync_gate import SyncGate
    gate = SyncGate()
    gate.requests['alice'] = 1
    async with gate.exclusive('bob'):
        assert gate.busy
        with pytest.raises(HTTPException):
            async with gate.exclusive('alice'):
                pass
    assert not gate.busy


def test_result_namespace_changes_with_model_and_owner(environment):
    client, master = environment
    client.post('/api/lab/users', json={'username': 'alice'})
    client.put('/api/lab/inference', json={'engine': 'ollama', 'url': 'http://localhost:11434', 'models': ['a', 'b'], 'model': 'a'})
    client.put('/api/lab/settings', json={'enabled': True, 'password': 'master-secret'})
    from services.document_policy import insight_cache_suffix
    token = identity.set(master)
    try:
        original = insight_cache_suffix('research', 'research_paper', 'ko')
        client.put('/api/me/model-settings', json={'provider': 'ollama', 'model': 'b'})
        assert insight_cache_suffix('research', 'research_paper', 'ko') != original
        identity.set('alice')
        assert insight_cache_suffix('research', 'research_paper', 'ko') != original
    finally:
        identity.reset(token)


def test_recovery_owner_rejects_disabled_member_and_restores_context(environment):
    client, master = environment
    member = client.post('/api/lab/users', json={'username': 'alice'}).json()
    from services.lab_context import recovery_owner
    token = identity.set(master)
    try:
        with recovery_owner('not-yet-parsed', 'alice') as permitted:
            assert not permitted  # Lab Mode is off.
        assert identity.get() == master
        client.put('/api/lab/settings', json={'enabled': True, 'password': 'master-secret'})
        with recovery_owner('not-yet-parsed', 'alice') as permitted:
            assert permitted and identity.get() == 'alice'
        assert identity.get() == master
        client.patch(f"/api/lab/users/{member['id']}", json={'active': False})
        with recovery_owner('not-yet-parsed', 'alice') as permitted:
            assert not permitted
    finally:
        identity.reset(token)


def test_lab_sync_requires_account_binding_capability(environment):
    client, _ = environment
    client.put('/api/lab/settings', json={'enabled': True, 'password': 'master-secret'})
    from routers.data_transfer import require_sync_binding
    from starlette.requests import Request
    request = Request({'type': 'http', 'headers': []})
    with pytest.raises(HTTPException) as error:
        require_sync_binding(request)
    assert error.value.status_code == 426
    require_sync_binding(Request({'type': 'http', 'headers': [(b'x-easypaper-sync-binding', b'1')]}))


@pytest.mark.asyncio
async def test_vllm_health_uses_lab_endpoint_without_openai_key(environment, monkeypatch):
    client, master = environment
    client.put('/api/lab/inference', json={'engine': 'vllm', 'url': 'http://inference:8000/v1', 'models': ['test'], 'model': 'test'})
    client.put('/api/lab/settings', json={'enabled': True, 'password': 'master-secret'})
    class Response:
        def raise_for_status(self):
            pass
        def json(self):
            return {'data': [{'id': 'test'}]}
    class Connection:
        def __init__(self, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def get(self, url, **kwargs):
            assert url == 'http://inference:8000/v1/models'
            return Response()
    monkeypatch.setattr('httpx.AsyncClient', Connection)
    token = identity.set(master)
    try:
        assert (await lab.inference_health())['model_available'] is True
    finally:
        identity.reset(token)
