"""Durable Lab model downloads. UI polling never owns a download task."""
import asyncio
from contextlib import closing, suppress
import json
import os
from pathlib import Path
import re
import time
import uuid

from fastapi import HTTPException
import httpx
from services import db, inference_servers as servers
from services.ssh_connections import client, manager
from services.shared_model_catalog import CATALOG

ACTIVE = {'Pending', 'Downloading', 'Verifying'}
_tasks = {}
_slots = {}


def migrate():
    with closing(db.get_db()) as conn, conn:
        conn.execute('CREATE TABLE IF NOT EXISTS shared_models (id TEXT PRIMARY KEY, server_id TEXT NOT NULL, model_id TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(server_id,model_id))')


def write(record):
    record['updated_at'] = time.time()
    with closing(db.get_db()) as conn, conn:
        conn.execute('INSERT OR REPLACE INTO shared_models VALUES (?,?,?,?)',
                     (record['id'], record['server_id'], record['model_id'], json.dumps(record)))


def canonical_id(engine, value):
    """Compare Ollama's implicit latest tag without rewriting saved preferences."""
    value = value.strip()
    return value + ':latest' if engine == 'ollama' and ':' not in value.rsplit('/', 1)[-1] else value


def destination(server):
    ssh = server.get('ssh') or {}
    return (server['engine'], server['url'].rstrip('/'), server.get('transport', 'https'),
            tuple(ssh.get(k) for k in ('host', 'port', 'username', 'host_key')) if server.get('transport') == 'ssh' else None)


def invalidated(record):
    """Preserve the model identity, but require verification on the new host."""
    return {**record, 'status': 'Failed', 'verified': False, 'enabled': False,
            'completed': 0, 'total': None, 'speed': None, 'revision': None,
            'error': 'Inference destination changed. Retry to install or verify this model on the new server.',
            'updated_at': time.time()}


def records(server_id):
    migrate()
    server = servers.get(server_id, False)
    with closing(db.get_db()) as conn, conn:
        # Preserve legacy permissions. Their installation is explicitly unverified.
        for model in server['models']:
            record = dict(id=uuid.uuid4().hex, server_id=server_id, model_id=model, engine=server['engine'],
                          status='Completed', enabled=True, verified=False, legacy=True, total=None, completed=0)
            conn.execute('INSERT OR IGNORE INTO shared_models VALUES (?,?,?,?)',
                         (record['id'], server_id, model, json.dumps(record)))
        return [json.loads(row[0]) for row in conn.execute('SELECT value FROM shared_models WHERE server_id=? ORDER BY rowid', (server_id,))]


def find(server_id, identifier):
    record = next((r for r in records(server_id) if r['id'] == identifier), None)
    if not record:
        raise HTTPException(404, 'Shared model not found.')
    return record


def guard(server_id):
    migrate()
    with closing(db.get_db()) as conn:
        values = [json.loads(r[0]) for r in conn.execute('SELECT value FROM shared_models WHERE server_id=?', (server_id,))]
    if any(r['status'] in ACTIVE for r in values):
        raise HTTPException(409, 'Cancel or finish model downloads before changing this server.')


def target(server_id):
    try:
        value = json.loads(os.environ.get('EASYPAPER_VLLM_TARGETS', '{}'))[server_id]
        if not Path(value['python']).is_absolute() or not Path(value['cache']).is_absolute():
            raise ValueError()
        if value.get('server_url', '').rstrip('/') != servers.get(server_id, False)['url'].rstrip('/'):
            raise ValueError()
        return value
    except (KeyError, ValueError, TypeError):
        raise HTTPException(409, 'Configure EASYPAPER_VLLM_TARGETS with this server ID, its server_url, vLLM Python and shared Hugging Face cache on the Lab server.')


async def worker(server_id, action, model_id='', update=None):
    deployment = target(server_id)
    process = await asyncio.create_subprocess_exec(
        deployment['python'], str(Path(__file__).with_name('hf_model_worker.py')), action, model_id, deployment['cache'],
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        env={**os.environ, 'HF_HUB_DISABLE_XET': '1', 'HF_HUB_DISABLE_PROGRESS_BARS': '0'})
    result = {}
    try:
        while line := await asyncio.wait_for(process.stdout.readline(), timeout=300):
            result = json.loads(line)
            if result.get('error'):
                raise ValueError(result['error'])
            if update:
                update(result)
        if await process.wait() != 0:
            raise ValueError('The configured vLLM worker failed. Check its Python environment and Hugging Face dependencies.')
        return result
    finally:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()


async def validate_deployment(server):
    """Do not substitute an unrelated local vLLM installation for the serving host."""
    target(server['id'])
    capabilities = await asyncio.wait_for(worker(server['id'], 'capabilities'), 60)
    root = server['url'].rstrip('/')
    root = root[:-3] if root.endswith('/v1') else root
    headers = {'Authorization': 'Bearer ' + server['api_key']} if server.get('api_key') else {}
    try:
        async with client('inference:' + server['id'], server, timeout=15, trust_env=False, follow_redirects=False) as connection:
            response = await connection.get(root + '/version', headers=headers)
            response.raise_for_status()
            actual = response.json().get('version')
    except (httpx.HTTPError, ValueError):
        raise ValueError('Cannot verify the vLLM server version. Expose /version through the configured connection.')
    if not actual or actual != capabilities.get('version'):
        raise ValueError('The serving vLLM version differs from the configured download environment. Use the same vLLM build.')
    if not capabilities.get('cache_writable'):
        raise ValueError('The configured shared Hugging Face cache is not writable.')
    return capabilities


async def catalog(server_id):
    server = servers.get(server_id)
    result = [r for r in CATALOG if r['engine'] == server['engine']]
    if server['engine'] == 'ollama':
        return {'models': result, 'notice': ''}
    try:
        capabilities = await validate_deployment(server)
        return {'models': [r for r in result if r['architecture'] in capabilities['architectures']],
                'notice': 'vLLM ' + capabilities['version']}
    except (HTTPException, ValueError, OSError, asyncio.TimeoutError) as exc:
        return {'models': [], 'notice': exc.detail if isinstance(exc, HTTPException) else str(exc) if isinstance(exc, ValueError) else 'Cannot verify the installed vLLM. Configure its Python environment and shared cache.'}


def model_id(engine, value):
    value = value.strip()
    pattern = r'[A-Za-z0-9][A-Za-z0-9_.-]*(?:/[A-Za-z0-9][A-Za-z0-9_.-]*)?(?::[A-Za-z0-9][A-Za-z0-9_.-]*)?' if engine == 'ollama' else r'[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*'
    if len(value) > 200 or not re.fullmatch(pattern, value) or '..' in value:
        raise HTTPException(422, 'Use an Ollama name:tag or a Hugging Face owner/model ID, without URLs or paths.')
    if engine == 'ollama' and ':' not in value:
        value += ':latest'
    if value.endswith('-cloud') or value.endswith(':cloud'):
        raise HTTPException(422, 'Choose a locally downloadable model, not a cloud model.')
    return value


def sync_permissions(server_id):
    rows = records(server_id)
    data = servers.state()
    server = next(s for s in data['servers'] if s['id'] == server_id)
    server['models'] = [r['model_id'] for r in rows if r['enabled'] and r['status'] == 'Completed']
    if server['model'] not in server['models']:
        server['model'] = next(iter(server['models']), '')
    servers.write(data)


async def add(server_id, value):
    manager.require_available('inference:' + server_id)
    server = servers.get(server_id)
    value = model_id(server['engine'], value)
    rows = records(server_id)
    existing = next((r for r in rows if canonical_id(server['engine'], r['model_id']) == value), None)
    if existing:
        if existing['status'] in ('Failed', 'Cancelled'):
            return await action(server_id, existing['id'], 'retry')
        return existing
    if len(rows) >= 100:
        raise HTTPException(409, 'A server can manage at most 100 models.')
    if server['engine'] == 'vllm':
        target(server_id)
    record = dict(id=uuid.uuid4().hex, server_id=server_id, model_id=value, engine=server['engine'],
                  enabled=False, verified=False, status='Pending', total=None, completed=0, speed=None, error=None)
    metadata = next((m for m in CATALOG if m['engine'] == server['engine'] and m['model_id'] == value), {})
    record.update({k: metadata[k] for k in ('name', 'parameters', 'quantization') if k in metadata})
    write(record)
    launch(record)
    return record


def launch(record):
    if record['id'] not in _tasks:
        async def queued():
            slot = _slots.setdefault(asyncio.get_running_loop(), asyncio.Semaphore(2))
            try:
                async with slot:
                    await download(record)
            except asyncio.CancelledError:
                record.update(status='Cancelled', enabled=False, speed=None)
                write(record)
                raise
        task = asyncio.create_task(queued())
        _tasks[record['id']] = task
        task.add_done_callback(lambda _: _tasks.pop(record['id'], None))


async def ollama(record, server, update):
    headers = {'Authorization': 'Bearer ' + server['api_key']} if server.get('api_key') else {}
    root = server['url'].rstrip('/')
    async with client('inference:' + server['id'], server, timeout=httpx.Timeout(300, connect=15), follow_redirects=False, trust_env=False) as connection:
        response = await connection.get(root + '/api/tags', headers=headers)
        response.raise_for_status()
        installed = next((m for m in response.json().get('models', []) if canonical_id('ollama', m['name']) == canonical_id('ollama', record['model_id'])), None)
        if not installed:
            layers = {}
            async with connection.stream('POST', root + '/api/pull', headers=headers, json={'model': canonical_id('ollama', record['model_id']), 'stream': True}) as response:
                response.raise_for_status()
                success = False
                async for line in response.aiter_lines():
                    if not line.strip():
                        continue
                    event = json.loads(line)
                    if event.get('error'):
                        reason = str(event['error']).lower()
                        if 'not found' in reason or 'does not exist' in reason:
                            raise ValueError('Ollama model or tag does not exist. Check the model ID.')
                        if 'version' in reason:
                            raise ValueError('This model requires a newer Ollama version. Upgrade the inference server.')
                        if 'space' in reason:
                            raise ValueError('Ollama has insufficient disk space for this model.')
                        if 'unauthorized' in reason or 'denied' in reason:
                            raise ValueError('Ollama registry authentication or access was denied.')
                        raise ValueError('Ollama rejected the model. Check its ID/tag, engine version, registry access and free disk space.')
                    if event.get('digest') and event.get('total'):
                        layers[event['digest']] = (event.get('completed', 0), event['total'])
                    update(dict(status='Downloading', completed=sum(v[0] for v in layers.values()),
                                total=sum(v[1] for v in layers.values()) or None,
                                progress_scope='discovered layers'))
                    success = event.get('status') == 'success'
                if not success:
                    raise ValueError('Ollama ended the download before reporting success. Retry to resume.')
        update({'status': 'Verifying'})
        response = await connection.post(root + '/api/show', headers=headers, json={'model': canonical_id('ollama', record['model_id'])})
        response.raise_for_status()
        shown = response.json()
        capabilities = shown.get('capabilities', [])
        if capabilities and 'completion' not in capabilities:
            raise ValueError('This model does not support text completion.')
        response = await connection.get(root + '/api/tags', headers=headers)
        response.raise_for_status()
        installed = next((m for m in response.json().get('models', []) if canonical_id('ollama', m['name']) == canonical_id('ollama', record['model_id'])), None)
        if not installed:
            raise ValueError('Ollama did not confirm the installed model.')
        update(dict(total=installed.get('size'), completed=installed.get('size', 0),
                    parameters=shown.get('details', {}).get('parameter_size'),
                    quantization=shown.get('details', {}).get('quantization_level')))


async def download(record):
    previous_time, previous_bytes = time.monotonic(), record.get('completed', 0)
    last_write = 0.0

    def update(values):
        nonlocal previous_time, previous_bytes, last_write
        now = time.monotonic()
        count = values.get('completed', record.get('completed', 0))
        status_changed = values.get('status', record['status']) != record['status']
        record.update(values)
        if now - previous_time >= .5:
            record['speed'] = max(0, count - previous_bytes) / (now - previous_time)
            previous_time, previous_bytes = now, count
        if status_changed or now - last_write >= .25 or record['status'] not in ACTIVE:
            write(record)
            last_write = now

    try:
        server = servers.get(record['server_id'])
        async with manager.lease('inference:' + server['id']):
            update(dict(status='Downloading', error=None))
            if server['engine'] == 'ollama':
                await ollama(record, server, update)
            else:
                await validate_deployment(server)
                def worker_update(values):
                    update({**values, 'status': 'Verifying'} if values.get('status') == 'Completed' else values)
                result = await worker(server['id'], 'download', record['model_id'], worker_update)
                if result.get('status') != 'Completed':
                    raise ValueError('Model verification did not complete.')
            update(dict(status='Completed', verified=True, enabled=True, speed=None))
            sync_permissions(server['id'])
    except asyncio.CancelledError:
        update(dict(status='Cancelled', enabled=False, speed=None))
        raise
    except Exception as exc:
        message = str(exc) if isinstance(exc, ValueError) else 'Download failed. Check the server connection, engine version, authentication and disk space.'
        update(dict(status='Failed', enabled=False, speed=None, error=message))


async def action(server_id, identifier, operation):
    manager.require_available('inference:' + server_id)
    record = find(server_id, identifier)
    if operation == 'cancel':
        task = _tasks.get(identifier)
        if task:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        record = find(server_id, identifier)
        if record['status'] in ACTIVE:
            record.update(status='Cancelled', enabled=False)
            write(record)
    elif operation == 'retry':
        if record['status'] in ACTIVE:
            return record
        record.update(status='Pending', enabled=False, error=None, verified=False)
        write(record)
        sync_permissions(server_id)
        launch(record)
    elif operation in ('enable', 'disable'):
        if record['status'] != 'Completed' or (not record.get('verified') and not record.get('legacy')):
            raise HTTPException(409, 'Wait for a verified download before enabling this model.')
        record['enabled'] = operation == 'enable'
        write(record)
        sync_permissions(server_id)
    else:
        raise HTTPException(422, 'Unknown model action.')
    return find(server_id, identifier)


async def remove(server_id, identifier, delete_files=False):
    manager.require_available('inference:' + server_id)
    record = find(server_id, identifier)
    if record['status'] in ACTIVE:
        raise HTTPException(409, 'Cancel the download before removing this model.')
    if delete_files:
        from services.shared_model_deletion import delete
        return await delete(server_id, identifier)
    record['enabled'] = False
    write(record)
    sync_permissions(server_id)
    with closing(db.get_db()) as conn, conn:
        conn.execute('DELETE FROM shared_models WHERE id=?', (identifier,))
    return {'deleted': True, 'files_deleted': False}


async def listing(server_id):
    rows = records(server_id)
    server = servers.get(server_id)
    available = None
    try:
        headers = {'Authorization': 'Bearer ' + server['api_key']} if server.get('api_key') else {}
        path = '/api/tags' if server['engine'] == 'ollama' else '/models'
        async with client('inference:' + server_id, server, timeout=5, follow_redirects=False, trust_env=False) as connection:
            response = await connection.get(server['url'].rstrip('/') + path, headers=headers)
            response.raise_for_status()
            data = response.json()
        available = [m['name'] for m in data.get('models', [])] if server['engine'] == 'ollama' else [m['id'] for m in data.get('data', [])]
    except (httpx.HTTPError, HTTPException, ValueError, KeyError):
        pass
    return [{**r, 'available': canonical_id(server['engine'], r['model_id']) in {canonical_id(server['engine'], m) for m in available} if available is not None else None,
             'percent': min(100, round(100 * r['completed'] / r['total'], 1)) if r.get('total') else None} for r in rows]


async def start():
    migrate()
    with closing(db.get_db()) as conn:
        rows = [json.loads(r[0]) for r in conn.execute('SELECT value FROM shared_models')]
    for record in rows:
        if record['status'] in ACTIVE:
            # Partial engine/Hub caches survive; retry explicitly after a server restart.
            record.update(status='Failed', enabled=False, error='Lab server restarted. Retry to resume cached downloads.', speed=None)
            write(record)
    for server_id in {r['server_id'] for r in rows}:
        sync_permissions(server_id)


async def stop():
    tasks = list(_tasks.values())
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    _tasks.clear()
    _slots.clear()
