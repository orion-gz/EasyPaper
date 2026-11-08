"""Private Unix-socket runner. Run separately from the EasyPaper application.

All images/root filesystems, executable arguments and UID assignments come from
an operator-owned configuration. HTTP callers cannot supply commands or paths.
"""
import asyncio
import json
import os
import pwd
import sqlite3
import stat
from pathlib import Path
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
CONFIG = Path(os.environ.get('LAB_RUNNER_CONFIG', '/etc/easypaper/lab-runner.json'))
logins = {}
locks = {}
active = {}


class Operation(BaseModel):
    account: str = Field(pattern=r'^[a-f0-9]{32}$')
    provider: str = Field(pattern=r'^(claude_code|codex|antigravity)$')
    action: str = Field(default='status', pattern=r'^(status|login|logout)$')


class Inference(Operation):
    prompt: str = Field(max_length=4_000_000)
    model: str | None = Field(default=None, max_length=200)
    session: str | None = Field(default=None, max_length=200)


def provision_account(config, identifier):
    """Allocate only from an operator-reserved UID range, in a private registry."""
    policy = config.get('provisioning')
    if not policy or not policy.get('enabled'):
        return None
    root = Path(policy['directory'])
    if not root.is_absolute() or root.resolve() != root:
        raise HTTPException(503, 'Provisioning requires an absolute private directory.')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = root.stat()
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise HTTPException(503, 'Provisioning directory must belong to the runner with mode 0700.')
    first, last = int(policy['uid_start']), int(policy['uid_end'])
    if first < 10000 or last < first or last > 2**31 - 1:
        raise HTTPException(503, 'Invalid reserved UID range.')
    registry = root / 'accounts.sqlite3'
    if registry.is_symlink():
        raise HTTPException(503, 'Invalid account registry.')
    conn = sqlite3.connect(registry, timeout=30)
    try:
        os.chmod(registry, 0o600)
        conn.execute('CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, uid INTEGER UNIQUE NOT NULL)')
        conn.execute('BEGIN IMMEDIATE')
        row = conn.execute('SELECT uid FROM accounts WHERE id=?', (identifier,)).fetchone()
        if row:
            uid = row[0]
        else:
            used = {row[0] for row in conn.execute('SELECT uid FROM accounts')}
            used.update(int(value['uid']) for value in config.get('accounts', {}).values())
            used.update(entry.pw_uid for entry in pwd.getpwall())
            uid = next((value for value in range(first, last + 1) if value not in used), None)
            if uid is None:
                raise HTTPException(503, 'The reserved CLI account UID range is exhausted.')
            conn.execute('INSERT INTO accounts VALUES (?,?)', (identifier, uid))
        # Persist the assignment first: a restart retries the same home/UID.
        conn.commit()
        home = root / identifier
        try:
            home.mkdir(mode=0o700)
        except FileExistsError:
            info = home.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (os.geteuid(), uid):
                raise HTTPException(503, 'Unsafe personal CLI home.')
        os.chown(home, uid, uid)
        os.chmod(home, 0o700)
        return {'uid': uid, 'home': str(home)}
    finally:
        conn.close()


def settings(data):
    config = json.loads(CONFIG.read_text())
    provider = config.get('providers', {}).get(data.provider)
    if not provider:
        raise HTTPException(503, 'This provider has not been provisioned.')
    account = config.get('accounts', {}).get(data.account) or provision_account(config, data.account)
    if not account or not provider:
        raise HTTPException(503, 'This isolated account/provider has not been provisioned.')
    if int(account['uid']) <= 0:
        raise HTTPException(503, 'Runner accounts must be unprivileged.')
    return config, account, provider


def command(data, action, name):
    config, account, provider = settings(data)
    argv = provider.get(action)
    if not argv or not isinstance(argv, list):
        raise HTTPException(503, 'This provider operation is not configured.')
    model = getattr(data, 'model', None) or provider.get('default_model', '')
    argv = [part.replace('{model}', model) for part in argv]
    home = Path(account['home']).resolve()
    if not home.is_dir():
        raise HTTPException(503, 'The isolated home directory is missing.')
    runtime = config['runtime']
    if runtime == 'docker':
        args = ['docker', 'run', '--rm', '--name', name, '--init', '-i',
                '--user', f"{account['uid']}:{account['uid']}", '--read-only', '--cap-drop=ALL',
                '--security-opt=no-new-privileges', '--pids-limit=128',
                '--memory', config.get('memory', '4g'), '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
                '--mount', f'type=bind,src={home},dst=/home/user',
                '--env', 'HOME=/home/user', '--workdir', '/home/user', provider['image']]
        return args + argv, ['docker', 'rm', '-f', name]
    if runtime == 'systemd':
        args = ['systemd-run', '--quiet', '--wait', '--pipe', '--collect', '--unit', name,
                '--uid', str(account['uid']), '--gid', str(account['uid']), '--property', f'RootDirectory={provider["rootfs"]}',
                '--property', f'BindPaths={home}:/home/user',
                '--property', 'BindReadOnlyPaths=/etc/resolv.conf',
                '--property', 'WorkingDirectory=/home/user', '--setenv', 'HOME=/home/user',
                '--property', 'ProtectSystem=strict', '--property', 'ReadWritePaths=/home/user',
                '--property', 'PrivateTmp=yes', '--property', 'PrivateDevices=yes',
                '--property', 'ProtectProc=invisible',
                '--property', 'NoNewPrivileges=yes', '--property', 'CapabilityBoundingSet=',
                '--property', 'ProtectKernelTunables=yes', '--property', 'ProtectControlGroups=yes',
                '--property', 'TasksMax=128', '--property', f'MemoryMax={config.get("memory", "4G")}',
                '--property', 'RuntimeMaxSec=600']
        return args + argv, ['systemctl', 'stop', name]
    raise HTTPException(503, 'Unsupported runner runtime.')


async def execute(data, action, on_chunk):
    name = 'easypaper-cli-' + uuid.uuid4().hex
    args, cleanup = command(data, action, name)
    process = None
    task = asyncio.current_task()
    active.setdefault(data.account, set()).add(task)
    try:
        process = await asyncio.create_subprocess_exec(*args, stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT if action == 'login' else asyncio.subprocess.DEVNULL,
                    env={'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'})
        prompt = getattr(data, 'prompt', '') if action == 'run' else ''
        async def feed():
            try:
                process.stdin.write(prompt.encode())
                await process.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                process.stdin.close()
        login_state = logins.get((data.account, data.provider)) if action == 'login' else None
        if login_state is not None:
            login_state['stdin'] = process.stdin
        writer = None if action == 'login' else asyncio.create_task(feed())
        try:
            async with asyncio.timeout(600):
                while chunk := await process.stdout.read(4096):
                    await on_chunk(chunk.decode('utf-8', errors='replace'))
                if writer:
                    await writer
                return await process.wait()
        finally:
            if writer:
                writer.cancel()
            if login_state is not None:
                login_state.pop('stdin', None)
                process.stdin.close()
    finally:
        active.get(data.account, set()).discard(task)
        stopper = await asyncio.create_subprocess_exec(*cleanup, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        await stopper.wait()
        if process and process.returncode is None:
            process.kill()
            await process.wait()


def lock(data):
    return locks.setdefault((data.account, data.provider), asyncio.Lock())


@app.post('/run')
async def run(data: Inference):
    settings(data)
    if lock(data).locked():
        raise HTTPException(409, 'This account/provider is busy.')
    async def generate():
        async with lock(data):
            queue = asyncio.Queue(maxsize=16)
            async def emit(text):
                await queue.put({'text': text})
            async def work():
                try:
                    if await execute(data, 'run', emit):
                        await queue.put({'error': 'CLI execution failed. Check your personal login.'})
                except Exception:
                    await queue.put({'error': 'Isolated CLI execution failed.'})
                finally:
                    if not asyncio.current_task().cancelling():
                        await queue.put(None)
            task = asyncio.create_task(work())
            try:
                while (item := await queue.get()) is not None:
                    yield json.dumps(item) + '\n'
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    return StreamingResponse(generate(), media_type='application/x-ndjson')


@app.post('/provider')
async def provider(data: Operation):
    _, _, profile = settings(data)
    if not profile.get(data.action):
        return {'status': 'unsupported', 'instructions': 'This installed provider has no configured authentication-only command. Ask the administrator to provision a compatible CLI version.'}
    key = (data.account, data.provider)
    if data.action == 'status' and key in logins:
        state = logins[key]
        if state['status'] != 'connected':
            return {'status': state['status'], 'instructions': state['output']}
        logins.pop(key, None)
    if data.action == 'logout' and key in logins:
        logins[key]['task'].cancel()
        await asyncio.gather(logins[key]['task'], return_exceptions=True)
        logins.pop(key, None)
    if lock(data).locked():
        raise HTTPException(409, 'This account/provider is busy.')
    if data.action == 'login':
        if key in logins and logins[key]['status'] == 'pending':
            raise HTTPException(409, 'A login is already pending for this account/provider.')
        state = {'status': 'pending', 'output': ''}
        async def login():
            async with lock(data):
                async def emit(text):
                    state['output'] = (state['output'] + text)[-8192:]
                try:
                    code = await execute(data, 'login', emit)
                    state['status'] = 'connected' if code == 0 else 'failed'
                    if code == 0:
                        state['output'] = ''
                except Exception:
                    state.update(status='failed', output='Login expired or failed. Retry or use the isolated server terminal.')
        state['task'] = asyncio.create_task(login())
        logins[key] = state
        return {'status': 'pending'}
    async with lock(data):
        async def discard(text):
            pass
        code = await execute(data, data.action, discard)
        return {'status': ('connected' if code == 0 else 'disconnected') if data.action == 'status' else ('disconnected' if code == 0 else 'failed')}


class AccountCancellation(BaseModel):
    account: str = Field(pattern=r'^[a-f0-9]{32}$')


@app.post('/cancel-account')
async def cancel_account(data: AccountCancellation):
    tasks = tuple(active.get(data.account, ()))
    for task in tasks:
        task.cancel()
    for key, state in tuple(logins.items()):
        if key[0] == data.account:
            state['task'].cancel()
            logins.pop(key, None)
    await asyncio.gather(*tasks, return_exceptions=True)
    return {'cancelled': True}


class LoginInput(Operation):
    text: str = Field(min_length=1, max_length=4096)


@app.post('/provider/input')
async def provider_input(data: LoginInput):
    state = logins.get((data.account, data.provider))
    if not state or state['status'] != 'pending' or not state.get('stdin'):
        raise HTTPException(409, 'No active login is accepting input.')
    try:
        state['stdin'].write(data.text.encode())
        await state['stdin'].drain()
    except (BrokenPipeError, ConnectionResetError):
        raise HTTPException(409, 'Login has finished.')
    return {'accepted': True}
