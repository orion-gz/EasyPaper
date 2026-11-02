"""Private Unix-socket runner. Run separately from the EasyPaper application.

All images/root filesystems, executable arguments and UID assignments come from
an operator-owned configuration. HTTP callers cannot supply commands or paths.
"""
import asyncio
import json
import os
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


def settings(data):
    config = json.loads(CONFIG.read_text())
    account = config.get('accounts', {}).get(data.account)
    provider = config.get('providers', {}).get(data.provider)
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
                '--user', str(account['uid']), '--read-only', '--cap-drop=ALL',
                '--security-opt=no-new-privileges', '--pids-limit=128',
                '--memory', config.get('memory', '4g'), '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
                '--mount', f'type=bind,src={home},dst=/home/user',
                '--env', 'HOME=/home/user', '--workdir', '/home/user', provider['image']]
        return args + argv, ['docker', 'rm', '-f', name]
    if runtime == 'systemd':
        args = ['systemd-run', '--quiet', '--wait', '--pipe', '--collect', '--unit', name,
                '--uid', str(account['uid']), '--property', f'RootDirectory={provider["rootfs"]}',
                '--property', f'BindPaths={home}:/home/user',
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
        writer = asyncio.create_task(feed())
        try:
            async with asyncio.timeout(600):
                while chunk := await process.stdout.read(4096):
                    await on_chunk(chunk.decode('utf-8', errors='replace'))
                await writer
                return await process.wait()
        finally:
            writer.cancel()
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
        return {'status': 'terminal_required', 'instructions': 'Ask the operator to perform this authentication operation inside your personal isolated CLI environment.'}
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
        return {'status': ('connected' if code == 0 else 'disconnected') if data.action == 'status' else 'disconnected'}


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
