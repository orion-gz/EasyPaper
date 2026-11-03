"""Lab management is identical for browser and Tauri remote clients."""
from contextlib import closing
from datetime import datetime, timezone
import secrets
import sqlite3
import uuid

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
    provider: str = Field(pattern=r'^(ollama|vllm|claude_code|codex|antigravity)$')
    model: str = Field(min_length=1, max_length=200)


@router.get('/lab/inference')
async def inference_settings(username: str = Depends(get_current_user)):
    result = lab.configuration()
    result.pop('api_key', None)
    if (lab.account(username) or {}).get('role') != 'master':
        result.pop('url', None)
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
    value = data.model_dump()
    value['max_concurrent'] = value['max_concurrent'] or (8 if data.engine == 'vllm' else 2)
    if value['per_user'] > value['max_concurrent']:
        raise HTTPException(400, 'The per-user limit cannot exceed the server limit.')
    if not value['api_key']:
        value['api_key'] = lab.configuration().get('api_key', '')
    with closing(db.get_db()) as conn, conn:
        conn.execute("INSERT OR REPLACE INTO lab_configuration VALUES ('inference',?)", (json.dumps(value),))
    return {'saved': True}


@router.get('/me/model-settings')
async def model_preferences(username: str = Depends(get_current_user)):
    return lab.preference(username)


@router.put('/me/model-settings')
async def save_preferences(data: ModelPreference, username: str = Depends(get_current_user)):
    import json
    common = lab.configuration()
    if data.provider in ('ollama', 'vllm') and (data.provider != common['engine'] or data.model not in common['models']):
        raise HTTPException(400, 'Choose an allowed lab model.')
    profile = lab.require_access(username)
    with closing(db.get_db()) as conn, conn:
        conn.execute('INSERT OR REPLACE INTO lab_preferences VALUES (?,?)', (profile['id'], json.dumps(data.model_dump())))
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
        async with httpx.AsyncClient(timeout=15, follow_redirects=False, trust_env=False) as connection:
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
