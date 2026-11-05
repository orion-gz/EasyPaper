from contextlib import closing
import json

import pytest
from fastapi import HTTPException
from test_lab_mode import environment
from services import db, lab, inference_servers as servers
from services.lab_context import identity
from services.ssh_connections import secrets, manager


def payload(name='GPU', engine='ollama'):
    return {'name': name, 'engine': engine, 'url': 'http://localhost:11434', 'models': ['same-model'], 'model': 'same-model'}


def test_multiple_servers_selection_and_default(environment):
    client, master = environment
    first = client.post('/api/inference/servers', json=payload()).json()
    second = client.post('/api/inference/servers', json=payload('GPU2', 'vllm')).json()
    assert first['id'] != second['id']
    assert client.put('/api/me/model-settings', json={'provider': 'vllm', 'model': 'same-model', 'server_id': second['id']}).status_code == 200
    token = identity.set(master)
    try:
        assert lab.selection()['id'] == second['id']
        assert lab.selection()['provider'] == 'vllm'
    finally:
        identity.reset(token)
    assert client.delete('/api/inference/servers/' + first['id']).status_code == 409
    assert client.post('/api/inference/servers/' + second['id'] + '/default').status_code == 200
    assert client.delete('/api/inference/servers/' + first['id']).status_code == 200


def test_member_redaction_and_admin_only_changes(environment):
    from services.auth import create_session_token
    client, _ = environment
    value = payload()
    value.update(transport='ssh', ssh={'host': 'private-host', 'username': 'private-user'}, credentials={'password': 'private-password', 'api_key': 'api-secret'})
    server = client.post('/api/inference/servers', json=value).json()
    client.post('/api/lab/users', json={'username': 'member'})
    client.put('/api/lab/settings', json={'enabled': True, 'password': 'master-secret'})
    with closing(db.get_db()) as conn, conn:
        conn.execute("UPDATE lab_accounts SET must_change_password=0 WHERE username='member'")
    client.cookies.set('session_token', create_session_token('member'))
    response = client.get('/api/inference/servers')
    assert response.status_code == 200
    for hidden in ('private-host', 'private-user', 'private-password', 'api-secret', 'localhost'):
        assert hidden not in response.text
        assert hidden not in client.get('/api/lab/inference').text
    assert client.put('/api/inference/servers/' + server['id'], json=payload()).status_code == 403
    assert client.post('/api/inference/ssh/host-key', json=value['ssh']).status_code == 403


def test_migration_preserves_legacy_key_and_model(environment):
    client, _ = environment
    old = dict(engine='vllm', url='http://localhost:8000/v1', models=['same-model'], model='same-model', api_key='old-key')
    with closing(db.get_db()) as conn, conn:
        conn.execute("INSERT OR REPLACE INTO lab_configuration VALUES ('inference', ?)", (json.dumps(old),))
    listing = client.get('/api/inference/servers').json()
    assert listing['default_id'] == 'default'
    assert len(listing['servers']) == 1
    assert servers.get()['api_key'] == 'old-key'
    assert client.get('/api/inference/servers').json() == listing
    assert client.put('/api/lab/inference', json={**old, 'api_key': ''}).status_code == 200
    assert servers.get()['api_key'] == 'old-key'
    with closing(db.get_db()) as conn:
        assert conn.execute("SELECT value FROM lab_configuration WHERE key='inference'").fetchone() is None


def test_active_server_cannot_be_changed(environment, monkeypatch):
    client, _ = environment
    server = client.post('/api/inference/servers', json=payload()).json()
    monkeypatch.setitem(manager.active, 'inference:' + server['id'], 1)
    assert client.put('/api/inference/servers/' + server['id'], json=payload('Changed')).status_code == 409


def test_selected_ollama_host_is_not_default(environment):
    from config import get_ollama_host
    client, master = environment
    client.post('/api/inference/servers', json=payload())
    server = client.post('/api/inference/servers', json={**payload('other'), 'url': 'http://other:11434'}).json()
    client.put('/api/me/model-settings', json={'provider': 'ollama', 'model': 'same-model', 'server_id': server['id']})
    token = identity.set(master)
    try:
        assert get_ollama_host() == 'http://other:11434'
    finally:
        identity.reset(token)


def test_selected_server_does_not_require_default_server_credentials(environment, monkeypatch):
    client, master = environment
    first = client.post('/api/inference/servers', json=payload()).json()
    second = client.post('/api/inference/servers', json=payload('Other')).json()
    client.put('/api/me/model-settings', json={'provider': 'ollama', 'model': 'same-model', 'server_id': second['id']})
    original = secrets.get
    def credentials(identifier):
        if identifier == 'inference:' + first['id']:
            raise HTTPException(409, 'Default server credentials unavailable')
        return original(identifier)
    monkeypatch.setattr(secrets, 'get', credentials)
    token = identity.set(master)
    try:
        assert lab.selection()['id'] == second['id']
    finally:
        identity.reset(token)


def test_legacy_limit_validation_remains_a_client_error(environment):
    client, _ = environment
    response = client.put('/api/lab/inference', json={
        'engine': 'ollama', 'url': 'http://localhost:11434', 'models': ['model'],
        'model': 'model', 'max_concurrent': 1, 'per_user': 2})
    assert response.status_code == 400


def test_model_preference_changes_do_not_decrypt_credentials(environment, monkeypatch):
    client, _ = environment
    server = client.post('/api/inference/servers', json=payload()).json()
    def unavailable(identifier):
        raise HTTPException(409, 'Stored credentials unavailable')
    monkeypatch.setattr(secrets, 'get', unavailable)
    response = client.put('/api/me/model-settings', json={
        'provider': 'ollama', 'model': 'same-model', 'server_id': server['id']})
    assert response.status_code == 200
    assert client.put('/api/me/model-settings', json={'provider': 'codex', 'model': 'model'}).status_code == 200
