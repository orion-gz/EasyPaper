import json
from contextlib import closing

import pytest
from test_lab_mode import environment
from services import db, lab, inference_servers
from services.ssh_connections import secrets
from services.lab_context import identity


@pytest.fixture(autouse=True)
def isolate(tmp_path, monkeypatch):
    monkeypatch.setattr('config._get_config_dir', lambda: str(tmp_path))
    monkeypatch.setattr(secrets, 'memory', {})


def spec(name='server'):
    return dict(name=name, engine='ollama', url='http://localhost:11434', models=['model'], model='model')


def test_delete_legacy_removes_credentials(environment):
    client, _ = environment
    with closing(db.get_db()) as conn, conn:
        conn.execute("INSERT INTO lab_configuration VALUES ('inference', ?)", (json.dumps({**spec(), 'api_key': 'old-secret'}),))
    inference_servers.state()
    new = client.post('/api/inference/servers', json=spec('new')).json()
    client.post('/api/inference/servers/' + new['id'] + '/default')
    assert client.delete('/api/inference/servers/default').status_code == 200
    with closing(db.get_db()) as conn:
        assert conn.execute("SELECT value FROM lab_configuration WHERE key='inference'").fetchone() is None


@pytest.mark.parametrize(('field', 'replacement'), [
    ('host', 'gpu-two'), ('port', 2222), ('username', 'other-user'), ('host_key', 'new-key'),
])
def test_ssh_destination_change_invalidates_results(environment, field, replacement):
    client, master = environment
    value = {**spec(), 'transport': 'ssh', 'ssh': {'host': 'gpu-one', 'username': 'user', 'host_key': 'pinned'}}
    server = client.post('/api/inference/servers', json=value).json()
    client.put('/api/me/model-settings', json={'provider': 'ollama', 'model': 'model', 'server_id': server['id']})
    token = identity.set(master)
    try:
        namespace = lab.result_namespace(lambda: 'translation')
        old = namespace()
        value['ssh'][field] = replacement
        assert client.put('/api/inference/servers/' + server['id'], json=value).status_code == 200
        assert namespace() != old
    finally:
        identity.reset(token)


def test_deleting_other_server_preserves_legacy_credentials(environment):
    client, _ = environment
    with closing(db.get_db()) as conn, conn:
        conn.execute("INSERT INTO lab_configuration VALUES ('inference', ?)", (json.dumps({**spec(), 'api_key': 'old-secret'}),))
    inference_servers.state()
    new = client.post('/api/inference/servers', json=spec('new')).json()
    assert client.delete('/api/inference/servers/' + new['id']).status_code == 200
    assert inference_servers.get('default')['api_key'] == 'old-secret'


def test_cache_ignores_display_name_but_tracks_transport(environment):
    client, master = environment
    value = {**spec(), 'ssh': {'host': 'gpu', 'username': 'user', 'host_key': 'pinned'}}
    server = client.post('/api/inference/servers', json=value).json()
    client.put('/api/me/model-settings', json={'provider': 'ollama', 'model': 'model', 'server_id': server['id']})
    token = identity.set(master)
    try:
        namespace = lab.result_namespace(lambda: 'translation')
        old = namespace()
        value['name'] = 'renamed'
        assert client.put('/api/inference/servers/' + server['id'], json=value).status_code == 200
        assert namespace() == old
        value['transport'] = 'ssh'
        assert client.put('/api/inference/servers/' + server['id'], json=value).status_code == 200
        assert namespace() != old
    finally:
        identity.reset(token)
