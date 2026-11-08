"""Lab management is identical for browser and Tauri remote clients."""
from contextlib import closing
from datetime import datetime, timezone
import secrets
import sqlite3
import uuid

from services.inference_servers import ServerSettings
from services.ssh_connections import SSHSettings

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from services import db, lab
from services.auth import get_current_user, require_admin_user, hash_password, verify_password

router = APIRouter()


class ModeUpdate(BaseModel):
    enabled: bool
    password: str


class NewMember(BaseModel):
    password: str | None = Field(default=None, min_length=8, max_length=128)
    username: str = Field(min_length=1, max_length=80, pattern=r'^[a-zA-Z0-9_.-]+$')


class MemberUpdate(BaseModel):
    active: bool


@router.get('/auth/me')
async def me(username: str = Depends(get_current_user)):
    profile = lab.account(username)
    return {'username': username, **(profile or {}), 'lab_mode': lab.settings()['enabled'],
            'capabilities': {'lab_accounts': True, 'sync_account_binding': 1}}


@router.get('/lab/settings')
async def settings(username: str = Depends(get_current_user)):
    return lab.settings()


@router.put('/lab/settings')
async def update_settings(data: ModeUpdate, username: str = Depends(require_admin_user)):
    user = db.get_user(username)
    if not user or not verify_password(user['password_hash'], data.password, allow_legacy=True):
        raise HTTPException(403, 'Confirm your current password.')
    if lab.settings()['enabled'] == data.enabled:
        return lab.settings()
    # Refuse a transition while a snapshot commit is active. A retry is safe.
    from services.sync_gate import gate
    if gate.busy:
        raise HTTPException(409, 'Finish synchronization before changing Lab Mode.')
    from config import set_skip_login
    if data.enabled:
        set_skip_login(False)
    with closing(db.get_db()) as conn, conn:
        conn.execute('UPDATE lab_settings SET enabled=? WHERE id=1', (data.enabled,))
        conn.execute("UPDATE lab_accounts SET session_version=session_version+1 WHERE role='member'")
    if not data.enabled:
        from services.lab_tasks import cancel_account_work
        with closing(db.get_db()) as conn:
            targets = list(conn.execute("SELECT username,id FROM lab_accounts WHERE role='member'"))
        from services.lab_runner import cancel_account
        for row in targets:
            await cancel_account_work(row['username'])
            await cancel_account(row['id'])
    return lab.settings()


@router.get('/lab/users')
async def users(username: str = Depends(require_admin_user)):
    with closing(db.get_db()) as conn:
        return [dict(row) for row in conn.execute('SELECT id,username,role,active,must_change_password FROM lab_accounts ORDER BY username')]


@router.post('/lab/users', status_code=201)
async def create_member(data: NewMember, username: str = Depends(require_admin_user)):
    password = data.password or secrets.token_urlsafe(18)
    identifier = uuid.uuid4().hex
    try:
        with closing(db.get_db()) as conn, conn:
            conn.execute('INSERT INTO users VALUES (?,?,?)', (data.username, hash_password(password), datetime.now(timezone.utc).isoformat()))
            conn.execute("INSERT INTO lab_accounts(username,id,role,must_change_password) VALUES (?,?,'member',1)", (data.username, identifier))
    except sqlite3.IntegrityError:
        raise HTTPException(409, 'Username already exists.')
    return {'id': identifier, 'username': data.username, 'temporary_password': password}


def member(conn, identifier):
    row = conn.execute("SELECT * FROM lab_accounts WHERE id=? AND role='member'", (identifier,)).fetchone()
    if not row:
        raise HTTPException(404, 'Member not found.')
    return row


@router.patch('/lab/users/{identifier}')
async def update_member(identifier: str, data: MemberUpdate, username: str = Depends(require_admin_user)):
    from services.sync_gate import gate
    if gate.busy:
        raise HTTPException(409, 'Finish synchronization before changing account status.')
    with closing(db.get_db()) as conn, conn:
        target = member(conn, identifier)
        conn.execute('UPDATE lab_accounts SET active=?,session_version=session_version+1 WHERE id=?', (data.active, identifier))
    if not data.active:
        from services.lab_tasks import cancel_account_work
        await cancel_account_work(target['username'])
        from services.lab_runner import cancel_account
        await cancel_account(identifier)
    return {'active': data.active}


@router.delete('/lab/users/{identifier}')
async def delete_member(identifier: str, username: str = Depends(require_admin_user)):
    await update_member(identifier, MemberUpdate(active=False), username)
    with closing(db.get_db()) as conn, conn:
        target = member(conn, identifier)
        conn.execute('DELETE FROM lab_preferences WHERE account_id=?', (identifier,))
        conn.execute('DELETE FROM inference_preferences WHERE account_id=?', (identifier,))
        conn.execute('DELETE FROM users WHERE username=?', (target['username'],))
        conn.execute('DELETE FROM lab_accounts WHERE id=?', (identifier,))
    return {'deleted': True}


@router.post('/lab/users/{identifier}/reset-password')
async def reset_password(identifier: str, username: str = Depends(require_admin_user)):
    password = secrets.token_urlsafe(18)
    with closing(db.get_db()) as conn, conn:
        user = member(conn, identifier)
        conn.execute('UPDATE users SET password_hash=? WHERE username=?', (hash_password(password), user['username']))
        conn.execute('UPDATE lab_accounts SET must_change_password=1,session_version=session_version+1 WHERE id=?', (identifier,))
    return {'temporary_password': password}


class InferenceSettings(BaseModel):
    engine: str = Field(pattern=r'^(ollama|vllm)$')
    url: str = Field(max_length=2048)
    models: list[str] = Field(max_length=100)
    model: str = Field(max_length=200)
    api_key: str = Field(default='', max_length=4096)
    max_concurrent: int | None = Field(default=None, ge=1, le=64)
    per_user: int = Field(default=1, ge=1, le=16)


class ModelPreference(BaseModel):
    server_id: str | None = Field(default=None, max_length=100)
    provider: str = Field(pattern=r'^(ollama|vllm|claude_code|codex|antigravity)$')
    model: str = Field(min_length=1, max_length=200)


@router.get('/lab/inference')
async def inference_settings(username: str = Depends(get_current_user)):
    from services import inference_servers as servers
    result = servers.get(with_secrets=False) if servers.state()['servers'] else lab.configuration()
    result.pop('api_key', None)
    if (lab.account(username) or {}).get('role') != 'master':
        if not result.get('enabled', True) or not result.get('lab_shared', True):
            return {'models': [], 'model': '', 'engine': result['engine']}
        result = {k: v for k, v in result.items() if k in ('id', 'name', 'engine', 'models', 'model')}
    return result


@router.put('/lab/inference')
async def save_inference(data: InferenceSettings, username: str = Depends(require_admin_user)):
    import json
    from urllib.parse import urlsplit
    url = urlsplit(data.url)
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise HTTPException(400, 'Use an HTTP(S) inference server URL without credentials or query parameters.')
    if data.model not in data.models or any(not name.strip() for name in data.models):
        raise HTTPException(400, 'The default model must be in the allowed model list.')
    from services import inference_servers as servers
    current = servers.state()
    existing = servers.get(with_secrets=False) if current['servers'] else {}
    value = data.model_dump()
    value['max_concurrent'] = value['max_concurrent'] or (8 if value['engine'] == 'vllm' else 2)
    if value['per_user'] > value['max_concurrent']:
        raise HTTPException(400, 'The per-user limit cannot exceed the server limit.')
    key = value.pop('api_key')
    await servers.save(servers.ServerSettings(**{**existing, **value,
        'name': existing.get('name', 'Default'), 'lab_shared': True, 'credentials': {'api_key': key}}), current['default_id'])
    return {'saved': True}


@router.get('/me/model-settings')
async def model_preferences(username: str = Depends(get_current_user)):
    return lab.preference(username)


@router.delete('/me/model-settings')
async def reset_personal_preferences(username: str = Depends(get_current_user)):
    if lab.settings()['enabled']:
        raise HTTPException(409, 'Personal settings are available when Lab mode is disabled.')
    profile = lab.require_access(username)
    with closing(db.get_db()) as conn, conn:
        conn.execute('DELETE FROM inference_preferences WHERE account_id=?', (profile['id'],))
    return {'saved': True}


@router.put('/me/model-settings')
async def save_preferences(data: ModelPreference, username: str = Depends(get_current_user)):
    import json
    from services import inference_servers as servers
    common = servers.get(data.server_id, with_secrets=False) if data.provider in ('ollama', 'vllm') and servers.state()['servers'] else lab.configuration(with_secrets=False)
    if lab.settings()['enabled'] and data.provider in ('ollama', 'vllm') and (not common.get('enabled', True) or not common.get('lab_shared', True)):
        raise HTTPException(409, 'This shared server is disabled.')
    if data.provider in ('ollama', 'vllm') and (data.provider != common['engine'] or data.model not in common['models']):
        raise HTTPException(400, 'Choose an allowed lab model.')
    if data.provider in ('ollama', 'vllm'):
        data.server_id = common.get('id')
    profile = lab.require_access(username)
    with closing(db.get_db()) as conn, conn:
        conn.execute(f'INSERT OR REPLACE INTO {lab.preference_table()} VALUES (?,?)', (profile['id'], json.dumps(data.model_dump())))
    return data


@router.get('/me/providers/{provider}')
async def provider_status(provider: str, username: str = Depends(get_current_user)):
    from services.lab_runner import operation
    return await operation(username, provider, 'status')


@router.post('/me/providers/{provider}/login')
async def provider_login(provider: str, username: str = Depends(get_current_user)):
    from services.lab_runner import operation
    return await operation(username, provider, 'login')


@router.delete('/me/providers/{provider}')
async def provider_logout(provider: str, username: str = Depends(get_current_user)):
    from services.lab_runner import operation
    return await operation(username, provider, 'logout')


@router.post('/lab/inference/check')
async def check_inference(username: str = Depends(require_admin_user)):
    import httpx
    value = lab.configuration()
    path = '/models' if value['engine'] == 'vllm' else '/api/tags'
    headers = {'Authorization': 'Bearer ' + value['api_key']} if value.get('api_key') else {}
    try:
        from services.ssh_connections import client
        async with client('inference:' + value.get('id', 'default'), value, timeout=15, follow_redirects=False, trust_env=False) as connection:
            response = await connection.get(value['url'].rstrip('/') + path, headers=headers)
            response.raise_for_status()
            data = response.json()
        models = [item['id'] for item in data.get('data', [])] if value['engine'] == 'vllm' else [item['name'] for item in data.get('models', [])]
        if value['model'] not in models:
            raise HTTPException(502, 'The default model is not installed on the inference server.')
        from services.lab_inference import probe
        verified = await probe(value)
        return {'connected': True, 'models': models, 'default_available': True, **verified}
    except (httpx.HTTPError, ValueError, KeyError, RuntimeError):
        raise HTTPException(502, 'Inference verification failed. Check the model, server logs and vLLM cache_salt/OpenAPI support.')


@router.get('/inference/servers')
async def list_servers(username: str = Depends(get_current_user)):
    from services import inference_servers as servers
    admin = (lab.account(username) or {}).get('role') == 'master'
    value = servers.state()
    from services.ssh_connections import secrets
    return {**value, 'servers': [servers.public(s, admin) for s in value['servers'] if admin or (s.get('enabled', True) and s.get('lab_shared', True))],
            'credential_storage': secrets.availability() if admin else {'available': False}}


@router.post('/inference/servers', status_code=201)
async def create_server(data: 'ServerSettings', username: str = Depends(require_admin_user)):
    from services import inference_servers as servers
    return await servers.save(data)


@router.put('/inference/servers/{identifier}')
async def update_server(identifier: str, data: 'ServerSettings', username: str = Depends(require_admin_user)):
    from services import inference_servers as servers
    return await servers.save(data, identifier)


@router.delete('/inference/servers/{identifier}')
async def delete_server(identifier: str, username: str = Depends(require_admin_user)):
    from services import inference_servers as servers
    await servers.delete(identifier)
    return {'deleted': True}


@router.post('/inference/servers/{identifier}/default')
async def default_server(identifier: str, username: str = Depends(require_admin_user)):
    from services import inference_servers as servers
    servers.get(identifier, False)
    value = servers.state()
    value['default_id'] = identifier
    servers.write(value)
    return {'saved': True}


@router.post('/inference/servers/{identifier}/check')
async def test_server(identifier: str, username: str = Depends(require_admin_user)):
    from services import inference_servers as servers
    return await servers.check(identifier)


@router.post('/inference/ssh/host-key')
async def ssh_host_key(data: 'SSHSettings', username: str = Depends(require_admin_user)):
    from services.ssh_connections import discover_host_key
    return await discover_host_key(data)


class LoginInput(BaseModel):
    text: str = Field(min_length=1, max_length=4096)


@router.post('/me/providers/{provider}/input')
async def provider_input(provider: str, data: LoginInput, username: str = Depends(get_current_user)):
    from services.lab_runner import send_input
    return await send_input(username, provider, data.text)


@router.get('/lab/models')
async def model_catalog(username: str = Depends(get_current_user)):
    from services.lab_models import snapshot
    lab.require_access(username)
    return await snapshot()


@router.get('/lab/models/events')
async def model_events(username: str = Depends(get_current_user)):
    import asyncio
    import json
    from fastapi.responses import StreamingResponse
    from services.lab_models import snapshot
    async def events():
        previous = None
        while True:
            lab.require_access(username)
            value = await snapshot()
            encoded = json.dumps(value, sort_keys=True)
            if encoded != previous:
                yield 'data: ' + encoded + '\n\n'
                previous = encoded
            else:
                yield ': heartbeat\n\n'
            await asyncio.sleep(3)
    return StreamingResponse(events(), media_type='text/event-stream',
                             headers={'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'})


@router.get('/lab/resources/{identifier}')
async def resource_plan(identifier: str, username: str = Depends(require_admin_user)):
    from services import inference_servers
    from services.lab_resources import gpu_info, recommendations, MemoryPolicy
    server = inference_servers.get(identifier, with_secrets=False)
    gpu = await gpu_info(server)
    policy = server.get('memory_policy')
    available = max((g['free_bytes'] for g in gpu['gpus']), default=None) if gpu['available'] else None
    plan = recommendations(server, MemoryPolicy(**policy), available) if policy else None
    return {'telemetry': gpu, 'plan': plan}


class ModelUnload(BaseModel):
    model: str = Field(min_length=1, max_length=200)


@router.post('/lab/resources/{identifier}/unload')
async def unload_model(identifier: str, data: ModelUnload, username: str = Depends(require_admin_user)):
    from services import inference_servers
    from services.ssh_connections import manager, client
    server = inference_servers.get(identifier)
    if server['engine'] != 'ollama':
        raise HTTPException(409, 'vLLM memory lifecycle belongs to its serving process; stop it through the server operator.')
    if data.model not in server['models']:
        raise HTTPException(404, 'Model not registered.')
    key = 'inference:' + identifier
    manager.guard(key)
    headers = {'Authorization': 'Bearer ' + server['api_key']} if server.get('api_key') else {}
    from services.lab_resources import maintenance
    maintenance.add(identifier)
    try:
        async with manager.lease(key), client(key, server, timeout=30, follow_redirects=False, trust_env=False) as connection:
            response = await connection.post(server['url'].rstrip('/') + '/api/generate',
                headers=headers, json={'model': data.model, 'keep_alive': 0, 'stream': False})
            if response.status_code != 200:
                raise HTTPException(502, 'Model unload failed.')
    finally:
        maintenance.discard(identifier)
    return {'unloaded': True}
