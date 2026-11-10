"""Stable inference identities; credentials live outside the library database."""
from contextlib import closing
import json
import sqlite3
import uuid

from fastapi import HTTPException
from pydantic import BaseModel, Field, model_validator
from services import db
from services.ssh_connections import SSHSettings, Credentials, secrets, manager


class ServerSettings(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    engine: str = Field(pattern='^(ollama|vllm)$')
    url: str = Field(max_length=2048)
    transport: str = Field(default='https', pattern='^(https|ssh)$')
    ssh: SSHSettings | None = None
    credentials: Credentials = Field(default_factory=Credentials)
    save_credentials: bool = False
    models: list[str] = Field(default_factory=list, max_length=100)
    model: str = Field(default='', max_length=200)
    max_concurrent: int = Field(default=2, ge=1, le=64)
    per_user: int = Field(default=1, ge=1, le=16)

    @model_validator(mode='after')
    def validate_server(self):
        from services.desktop_connection import normalize_server_url
        self.url = normalize_server_url(self.url)
        if self.transport == 'ssh' and self.ssh is None:
            raise ValueError('SSH settings are required.')
        if self.models and (self.model not in self.models or any(not m.strip() for m in self.models)):
            raise ValueError('Choose a default model from the allowed model list.')
        if self.per_user > self.max_concurrent:
            raise ValueError('Per-user limit exceeds server limit.')
        return self


def state():
    try:
        with closing(db.get_db()) as conn:
            row = conn.execute("SELECT value FROM lab_configuration WHERE key='inference_servers'").fetchone()
            legacy = conn.execute("SELECT value FROM lab_configuration WHERE key='inference'").fetchone()
    except sqlite3.OperationalError as exc:
        if 'no such table' not in str(exc):
            raise
        return {'default_id': None, 'servers': []}
    if row:
        result = json.loads(row[0])
        migrate_preferences(result)
        return result
    if not legacy:
        return {'default_id': None, 'servers': []}
    old = json.loads(legacy[0])
    # Preserve pre-existing credentials until the owner explicitly chooses secure storage.
    # New connection records never contain credentials.
    old.pop('api_key', None)
    server = dict(old, id='default', name='Default', transport='https', save_credentials=False, legacy_credentials=True)
    result = {'default_id': 'default', 'servers': [server]}
    write(result)
    migrate_preferences(result)
    return result


def migrate_preferences(value):
    if value.get('preferences_migrated'):
        return
    legacy = next((s for s in value['servers'] if s.get('legacy_credentials')), None)
    with closing(db.get_db()) as conn, conn:
        if legacy:
            for account_id, raw in conn.execute('SELECT account_id,value FROM lab_preferences').fetchall():
                preference = json.loads(raw)
                if preference.get('provider') in ('ollama', 'vllm') and not preference.get('server_id'):
                    preference['server_id'] = legacy['id']
                    conn.execute('UPDATE lab_preferences SET value=? WHERE account_id=?', (json.dumps(preference), account_id))
        value['preferences_migrated'] = True
        conn.execute('INSERT OR REPLACE INTO lab_configuration VALUES (?,?)', ('inference_servers', json.dumps(value)))


def write(value):
    with closing(db.get_db()) as conn, conn:
        conn.execute('INSERT OR REPLACE INTO lab_configuration VALUES (?,?)', ('inference_servers', json.dumps(value)))


def get(identifier=None, with_secrets=True):
    data = state()
    identifier = identifier or data['default_id']
    server = next((dict(s) for s in data['servers'] if s['id'] == identifier), None)
    if not server:
        raise HTTPException(404, 'Choose an available inference server.')
    if with_secrets:
        server['api_key'] = secrets.get('inference:' + identifier).get('api_key', '')
        if not server['api_key'] and server.get('legacy_credentials'):
            with closing(db.get_db()) as conn:
                legacy = conn.execute("SELECT value FROM lab_configuration WHERE key='inference'").fetchone()
            server['api_key'] = json.loads(legacy[0]).get('api_key', '') if legacy else ''
    return server


def public(server, admin):
    if not admin:
        return {k: server[k] for k in ('id', 'name', 'engine', 'models', 'model')}
    return {**server, 'credentials_saved': server.get('save_credentials', False)}


async def save(data, identifier=None):
    current = state()
    if identifier and not any(s['id'] == identifier for s in current['servers']):
        raise HTTPException(404, 'Inference server not found.')
    identifier = identifier or uuid.uuid4().hex
    key = 'inference:' + identifier
    previous = next((s for s in current['servers'] if s['id'] == identifier), {})
    manager.guard(key)
    from services import shared_models
    shared_models.guard(identifier)
    managed = shared_models.records(identifier) if previous else []
    if managed and data.engine != previous['engine']:
        raise HTTPException(409, 'Remove shared models before changing engines.')
    try:
        credentials = secrets.get(key)
        if previous.get('legacy_credentials'):
            credentials.setdefault('api_key', get(identifier).get('api_key', ''))
    except HTTPException:
        if not any(data.credentials.model_dump().values()):
            raise
        credentials = {}
    credentials.update({k: v for k, v in data.credentials.model_dump().items() if v})
    secrets.put(key, credentials, data.save_credentials)
    server = dict(data.model_dump(exclude={'credentials'}), id=identifier)
    if managed:
        server['models'] = previous['models']
        if server['model'] not in server['models']:
            server['model'] = previous['model']
    current['servers'] = [server if s['id'] == identifier else s for s in current['servers']]
    if not any(s['id'] == identifier for s in current['servers']):
        current['servers'].append(server)
    current['default_id'] = current['default_id'] or identifier
    if managed and shared_models.destination(previous) != shared_models.destination(server):
        # Atomically remove stale permissions and invalidate installation evidence.
        server['models'], server['model'] = [], ''
        with closing(db.get_db()) as conn, conn:
            for record in managed:
                record = shared_models.invalidated(record)
                conn.execute('UPDATE shared_models SET value=? WHERE id=?', (json.dumps(record), record['id']))
            conn.execute('INSERT OR REPLACE INTO lab_configuration VALUES (?,?)', ('inference_servers', json.dumps(current)))
    else:
        write(current)
    if previous.get('legacy_credentials'):
        with closing(db.get_db()) as conn, conn:
            conn.execute("DELETE FROM lab_configuration WHERE key='inference'")
    await manager.close(key)
    return public(server, True)


async def delete(identifier):
    data = state()
    server = get(identifier, False)
    if data['default_id'] == identifier:
        raise HTTPException(409, 'Choose another default server before deleting this server.')
    key = 'inference:' + identifier
    manager.guard(key)
    from services import shared_models
    shared_models.guard(identifier)
    secrets.delete(key)
    data['servers'] = [s for s in data['servers'] if s['id'] != identifier]
    with closing(db.get_db()) as conn, conn:
        conn.execute('INSERT OR REPLACE INTO lab_configuration VALUES (?,?)', ('inference_servers', json.dumps(data)))
        conn.execute('DELETE FROM shared_models WHERE server_id=?', (identifier,))
        if server.get('legacy_credentials'):
            conn.execute("DELETE FROM lab_configuration WHERE key='inference'")
    await manager.close(key)


async def check(identifier):
    import httpx
    from services.ssh_connections import client
    value = get(identifier)
    key = 'inference:' + value['id']
    headers = {'Authorization': 'Bearer ' + value['api_key']} if value.get('api_key') else {}
    path = '/models' if value['engine'] == 'vllm' else '/api/tags'
    try:
        async with manager.lease(key), client(key, value, timeout=15, trust_env=False, follow_redirects=False) as connection:
            response = await connection.get(value['url'].rstrip('/') + path, headers=headers)
            response.raise_for_status()
            data = response.json()
        models = [m['id'] for m in data.get('data', [])] if value['engine'] == 'vllm' else [m['name'] for m in data.get('models', [])]
        verified = {}
        if value['model']:
            if value['model'] not in models:
                raise HTTPException(502, 'The default model is not installed on the inference server.')
            from services.lab_inference import probe
            async with manager.lease(key):
                verified = await probe(value)
        return {'connected': True, 'models': models, 'default_available': value['model'] in models, **verified}
    except (httpx.HTTPError, ValueError, KeyError, RuntimeError):
        raise HTTPException(502, 'Could not reach the inference service through the configured connection.')
