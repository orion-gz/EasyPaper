import json
from contextlib import closing
import pytest
from test_lab_mode import environment
from services import lab, db, inference_servers as servers
from services.lab_context import identity
from services.ssh_connections import secrets

@pytest.fixture(autouse=True)
def isolated_secret_store(tmp_path, monkeypatch):
    monkeypatch.setattr('config._get_config_dir', lambda: str(tmp_path))
    monkeypatch.setattr(secrets, 'memory', {})


def spec(name='new'):
    return dict(name=name, engine='ollama', url='http://localhost:11434', models=['model'], model='model')


def legacy():
    with closing(db.get_db()) as conn, conn:
        conn.execute("INSERT OR REPLACE INTO lab_configuration VALUES ('inference', ?)",
                     (json.dumps(dict(engine='ollama', url='http://old:11434', models=['model'], model='model', api_key='old-secret')),))


def test_legacy_key_survives_default_switch_and_other_server_save(environment):
    client, _ = environment
    legacy()
    assert servers.get()['api_key'] == 'old-secret'
    new = client.post('/api/inference/servers', json=spec()).json()
    assert client.post('/api/inference/servers/'+new['id']+'/default').status_code == 200
    assert client.put('/api/inference/servers/'+new['id'], json=spec()).status_code == 200
    assert servers.get('default')['api_key'] == 'old-secret'


def test_existing_preference_keeps_original_server_after_migration(environment):
    client, master = environment
    legacy()
    account = lab.account(master)
    with closing(db.get_db()) as conn, conn:
        conn.execute('INSERT OR REPLACE INTO lab_preferences VALUES (?,?)', (account['id'], json.dumps({'provider':'ollama','model':'model'})))
    client.put('/api/lab/settings', json={'enabled': True, 'password': 'master-secret'})
    new = client.post('/api/inference/servers', json=spec()).json()
    client.post('/api/inference/servers/'+new['id']+'/default')
    token = identity.set(master)
    try:
        assert lab.selection()['id'] == 'default'
    finally:
        identity.reset(token)


def test_register_unconfigured_server_does_not_break_existing_personal_model(environment, monkeypatch):
    import config
    client, master = environment
    monkeypatch.setattr(config, 'CHAT_PROVIDER', 'openai')
    monkeypatch.setattr(config, 'CHAT_MODEL', 'existing-model')
    assert not lab.settings()['enabled']
    assert config.get_chat_provider() == 'openai'
    response = client.post('/api/inference/servers', json={'name':'draft', 'engine':'ollama', 'url':'http://localhost:11434'})
    assert response.status_code == 201
    assert config.get_chat_provider() == 'openai'


def test_disabled_lab_restores_personal_provider(environment, monkeypatch):
    import config
    client, master = environment
    monkeypatch.setattr(config, 'CHAT_PROVIDER', 'openai')
    client.post('/api/inference/servers', json=spec())
    client.put('/api/lab/settings', json={'enabled':True, 'password':'master-secret'})
    client.put('/api/lab/settings', json={'enabled':False, 'password':'master-secret'})
    assert not lab.settings()['enabled']
    assert config.get_chat_provider() == 'openai'


@pytest.mark.parametrize('failure', ['authentication', 'configuration', 'storage'])
def test_failed_desktop_edit_preserves_saved_credentials(tmp_path, monkeypatch, failure):
    from cryptography.fernet import Fernet
    from fastapi import FastAPI, HTTPException
    from fastapi.testclient import TestClient
    from services.desktop_connection import DesktopConnections
    from services.ssh_connections import manager, SecretStore
    monkeypatch.delenv('EASYPAPER_DESKTOP', raising=False)
    monkeypatch.setenv('EASYPAPER_CONNECTION_KEY', Fernet.generate_key().decode())
    app = FastAPI()
    desktop = DesktopConnections(app, tmp_path/'desktop.json', 8000)
    app.include_router(desktop.router)
    async def port(key, profile):
        if secrets.get(key).get('password') != 'correct':
            raise HTTPException(401, 'SSH authentication failed.')
        return 18000
    async def gateway(target):
        desktop.config['ports'][target] = 19000
        return 19000
    monkeypatch.setattr(manager, 'port', port)
    monkeypatch.setattr(desktop, 'ensure_gateway', gateway)
    body = {'enabled':True, 'server_url':'http://remote:8000', 'transport':'ssh',
            'ssh':{'host':'gpu', 'username':'user', 'host_key':'pinned'},
            'save_credentials':True, 'credentials':{'password':'correct'}}
    with TestClient(app, base_url='http://127.0.0.1:8000') as client:
        headers = {'X-EasyPaper-Desktop':'1'}
        assert client.put('/desktop/connection', json=body, headers=headers).status_code == 200
        key = 'desktop:' + desktop.config['server_url']
        previous = json.loads(desktop.config_path.read_text())
        expected = 401
        if failure == 'authentication':
            body['credentials']['password'] = 'wrong'
        elif failure == 'configuration':
            def fail_save():
                raise OSError('Disk unavailable')
            monkeypatch.setattr(desktop, 'save', fail_save)
            expected = 500
        else:
            def fail_store(*args):
                raise HTTPException(409, 'Secure storage unavailable')
            monkeypatch.setattr(secrets, 'put', fail_store)
            expected = 409
        assert client.put('/desktop/connection', json=body, headers=headers).status_code == expected
        assert desktop.config == previous
        assert json.loads(desktop.config_path.read_text()) == previous
        assert not any(key.startswith('candidate:') for key in secrets.memory)
        assert SecretStore().get(key)['password'] == 'correct'


def test_personal_selection_is_independent_and_can_be_reset(environment, monkeypatch):
    import config
    client, _ = environment
    monkeypatch.setattr(config, 'CHAT_PROVIDER', 'openai')
    first = client.post('/api/inference/servers', json=spec('personal')).json()
    second = client.post('/api/inference/servers', json=spec('lab')).json()
    client.put('/api/me/model-settings', json={'provider': 'ollama', 'model': 'model', 'server_id': first['id']})
    assert lab.selection()['id'] == first['id']
    client.put('/api/lab/settings', json={'enabled': True, 'password': 'master-secret'})
    client.put('/api/me/model-settings', json={'provider': 'ollama', 'model': 'model', 'server_id': second['id']})
    assert client.delete('/api/me/model-settings').status_code == 409
    client.put('/api/lab/settings', json={'enabled': False, 'password': 'master-secret'})
    assert lab.selection()['id'] == first['id']
    assert client.delete('/api/me/model-settings').status_code == 200
    assert config.get_chat_provider() == 'openai'


def test_saving_legacy_server_after_default_switch_moves_its_key(environment):
    client, _ = environment
    legacy()
    servers.state()
    new = client.post('/api/inference/servers', json=spec()).json()
    client.post('/api/inference/servers/' + new['id'] + '/default')
    assert client.put('/api/inference/servers/default', json=spec('old')).status_code == 200
    assert servers.get('default')['api_key'] == 'old-secret'
    assert servers.get(new['id'])['api_key'] == ''
