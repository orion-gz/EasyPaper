"""Persistent lab identities. Never included in portable library snapshots."""
from contextlib import closing
import hashlib
import hmac
import json
import sqlite3
import uuid

from fastapi import HTTPException
from services import db


def migrate():
    from config import get_app_username
    with closing(db.get_db()) as conn, conn:
        conn.execute('''CREATE TABLE IF NOT EXISTS lab_accounts (
            username TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
            must_change_password INTEGER NOT NULL DEFAULT 0,
            session_version INTEGER NOT NULL DEFAULT 0)''')
        conn.execute('''CREATE TABLE IF NOT EXISTS lab_settings (
            id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0)''')
        conn.execute('INSERT OR IGNORE INTO lab_settings(id) VALUES (1)')
        conn.execute('CREATE TABLE IF NOT EXISTS lab_configuration (key TEXT PRIMARY KEY,value TEXT NOT NULL)')
        conn.execute('CREATE TABLE IF NOT EXISTS lab_preferences (account_id TEXT PRIMARY KEY,value TEXT NOT NULL)')
        conn.execute('CREATE TABLE IF NOT EXISTS inference_preferences (account_id TEXT PRIMARY KEY,value TEXT NOT NULL)')
        for row in conn.execute('SELECT username FROM users').fetchall():
            conn.execute('INSERT OR IGNORE INTO lab_accounts(username,id,role) VALUES (?,?,?)',
                         (row[0], uuid.uuid4().hex, 'master' if row[0] == get_app_username() else 'member'))
        conn.execute("UPDATE lab_accounts SET role=CASE WHEN username=? THEN 'master' ELSE 'member' END", (get_app_username(),))


def settings():
    try:
        with closing(db.get_db()) as conn:
            row = conn.execute('SELECT enabled FROM lab_settings WHERE id=1').fetchone()
            return {'enabled': bool(row and row[0])}
    except sqlite3.OperationalError as exc:
        if 'no such table' not in str(exc):
            raise
        return {'enabled': False}


def account(username):
    try:
        with closing(db.get_db()) as conn:
            row = conn.execute('SELECT * FROM lab_accounts WHERE username=?', (username,)).fetchone()
            return dict(row) if row else None
    except sqlite3.OperationalError as exc:
        if 'no such table' not in str(exc):
            raise
        return None


def require_access(username):
    user = account(username)
    if not user and settings()['enabled']:
        raise HTTPException(403, 'Unknown lab account.')
    if user and (not user['active'] or (user['role'] != 'master' and not settings()['enabled'])):
        raise HTTPException(403, 'This lab account is not available.')
    return user


def signature_key(username):
    user = account(username)
    if not user:
        return None
    with closing(db.get_db()) as conn:
        row = conn.execute('SELECT password_hash FROM users WHERE username=?', (username,)).fetchone()
    return f"{user['id']}:{user['session_version']}:{row[0]}" if row else None


def cache_salt(username, document_id, revision):
    from config import SECRET_KEY
    user = require_access(username)
    if not user:
        raise HTTPException(403, 'Unknown lab account.')
    payload = json.dumps([user['id'], document_id, revision], separators=(',', ':'))
    return hmac.new(SECRET_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()


def configuration(with_secrets=True):
    from services import inference_servers
    if inference_servers.state()['servers']:
        return inference_servers.get(with_secrets=with_secrets)
    return {'engine': 'ollama', 'url': 'http://localhost:11434', 'models': [], 'model': '', 'api_key': ''}


def preference_table():
    return 'lab_preferences' if settings()['enabled'] else 'inference_preferences'


def preference(username):
    user = account(username)
    if not user:
        return {}
    with closing(db.get_db()) as conn:
        row = conn.execute(f'SELECT value FROM {preference_table()} WHERE account_id=?', (user['id'],)).fetchone()
    return json.loads(row[0]) if row else {}


def selection():
    from services.lab_context import selected_server
    if selected_server.get() is not None:
        return selected_server.get()
    from services import inference_servers
    enabled = settings()['enabled']
    if not enabled and not inference_servers.state()['servers']:
        return None
    from services.lab_context import identity
    username = identity.get()
    if not username:
        if enabled:
            raise RuntimeError('Lab inference requires an explicit user identity.')
        from config import get_app_username
        username = get_app_username()
    require_access(username)
    personal = preference(username)
    if not enabled and not personal:
        return None
    if personal.get('server_id') and personal.get('provider') in ('ollama', 'vllm'):
        common = inference_servers.get(personal['server_id'])
    else:
        common = configuration(with_secrets=personal.get('provider') not in ('claude_code', 'codex', 'antigravity'))
    provider = personal.get('provider', common['engine'])
    model = personal.get('model', common['model'])
    if provider in ('ollama', 'vllm'):
        provider = common['engine']
        if model not in common['models']:
            model = common['model']
        if not model or model not in common['models']:
            raise RuntimeError('Ask the lab administrator to configure an allowed model.')
    return {**common, 'provider': provider, 'model': model}


def result_namespace(function):
    """Invalidate model-derived results when owner/model/prompt settings change."""
    import functools
    @functools.wraps(function)
    def wrapped(*args, **kwargs):
        suffix = function(*args, **kwargs)
        if not selection():
            return suffix
        from services.lab_context import identity
        from config import get_translation_prompt_template
        user = require_access(identity.get())
        if not user:
            raise RuntimeError('Lab cache access requires a user identity.')
        selected = selection()
        transport = selected.get('transport', 'https')
        ssh = selected.get('ssh') or {}
        destination = {field: ssh.get(field) for field in ('host', 'port', 'username', 'host_key')} if transport == 'ssh' else None
        payload = [user['id'], selected['provider'], selected['model'], selected.get('id'), selected['url'],
                   transport, destination, get_translation_prompt_template(), 'lab-results-v2']
        key = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:24]
        return suffix + '_lab_' + key
    return wrapped


async def inference_health():
    import httpx
    from services.lab_context import identity
    try:
        selected = selection()
        if not selected:
            return None
        provider = selected['provider']
        if provider in ('claude_code', 'codex', 'antigravity'):
            from services.lab_runner import operation
            result = await operation(identity.get(), provider, 'status')
            available = result.get('status') == 'connected'
            return {'status': 'ok' if available else 'error', 'provider': provider,
                    'model_available': available, 'authentication': result.get('status')}
        path = '/models' if provider == 'vllm' else '/api/tags'
        headers = {'Authorization': 'Bearer ' + selected['api_key']} if selected.get('api_key') else {}
        from services.ssh_connections import client
        async with client(timeout=15, follow_redirects=False, trust_env=False) as connection:
            response = await connection.get(selected['url'].rstrip('/') + path, headers=headers)
            response.raise_for_status()
            data = response.json()
        models = [item['id'] for item in data.get('data', [])] if provider == 'vllm' else [item['name'] for item in data.get('models', [])]
        available = selected['model'] in models
        return {'status': 'ok' if available else 'error', 'provider': provider,
                'model_available': available, 'available_models': models}
    except (httpx.HTTPError, HTTPException, ValueError, RuntimeError, KeyError):
        return {'status': 'error', 'model_available': False, 'detail': 'Check your Lab Mode provider configuration or personal login.'}
