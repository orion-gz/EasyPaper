"""No GPU/network required: exercise jobs against engine/Hub protocol fixtures."""
import asyncio
from contextlib import closing
import json
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from test_lab_mode import environment
from services import db, inference_servers as servers, shared_models as models


def create(client, engine='ollama', legacy=False):
    result = client.post('/api/inference/servers', json=dict(name='Lab GPU', engine=engine,
        url='http://engine:11434' if engine == 'ollama' else 'http://engine:8000/v1',
        models=['old:latest'] if legacy else [], model='old:latest' if legacy else ''))
    assert result.status_code == 201, result.text
    return result.json()['id']


def engine(monkeypatch, events=None, installed=False, completion=True):
    calls = []
    present = installed
    def handle(request):
        nonlocal present
        calls.append(request.url.path)
        if request.url.path == '/api/tags':
            return httpx.Response(200, json={'models': [{'name': 'qwen3.5:4b', 'size': 100}] if present else []})
        if request.url.path == '/api/pull':
            present = True
            messages = events if events is not None else [
                {'digest': 'sha:a', 'total': 80, 'completed': 40},
                {'digest': 'sha:a', 'total': 80, 'completed': 80},
                {'digest': 'sha:b', 'total': 20, 'completed': 20}, {'status': 'success'}]
            return httpx.Response(200, text='\n'.join(json.dumps(e) for e in messages))
        if request.url.path == '/api/show':
            return httpx.Response(200, json={'capabilities': ['completion'] if completion else ['embedding'], 'details': {'parameter_size': '4B'}})
        return httpx.Response(404)
    monkeypatch.setattr(models, 'client', lambda *a, **kw: httpx.AsyncClient(transport=httpx.MockTransport(handle)))
    return calls


async def finish(record):
    task = models._tasks.get(record['id'])
    if task:
        await task
    return models.find(record['server_id'], record['id'])


@pytest.mark.asyncio
async def test_pull_registers_only_after_verification_and_keeps_legacy(environment, monkeypatch):
    client, _ = environment
    identifier = create(client, legacy=True)
    calls = engine(monkeypatch)
    old = models.records(identifier)[0]
    assert old['legacy'] and not old['verified'] and old['enabled']
    record = await models.add(identifier, 'qwen3.5:4b')
    assert servers.get(identifier)['models'] == ['old:latest']
    assert (await models.add(identifier, 'qwen3.5:4b'))['id'] == record['id']
    result = await finish(record)
    assert result['status'] == 'Completed' and result['verified']
    assert result['completed'] == result['total'] == 100
    assert servers.get(identifier)['models'] == ['old:latest', 'qwen3.5:4b']
    assert calls.count('/api/pull') == 1
    assert '/api/show' in calls
    assert not any(p in calls for p in ('/api/chat', '/api/generate'))
    assert (await models.listing(identifier))[1]['available'] is True


@pytest.mark.asyncio
@pytest.mark.parametrize('events,completion', [([{'error': 'not found'}], True), ([{'status': 'pulling manifest'}], True), (None, False)])
async def test_invalid_or_interrupted_models_are_never_shared(environment, monkeypatch, events, completion):
    client, _ = environment
    identifier = create(client)
    engine(monkeypatch, events, completion=completion)
    record = await models.add(identifier, 'qwen3.5:4b')
    result = await finish(record)
    assert result['status'] == 'Failed' and result['error']
    assert servers.get(identifier)['models'] == []
    with pytest.raises(HTTPException):
        await models.action(identifier, result['id'], 'enable')


@pytest.mark.asyncio
async def test_cached_models_skip_pull_and_permissions_follow_toggle_remove(environment, monkeypatch):
    client, _ = environment
    identifier = create(client)
    calls = engine(monkeypatch, installed=True)
    record = await models.add(identifier, 'qwen3.5:4b')
    await finish(record)
    assert '/api/pull' not in calls
    await models.action(identifier, record['id'], 'disable')
    assert servers.get(identifier)['models'] == []
    assert servers.get(identifier)['model'] == ''
    await models.action(identifier, record['id'], 'enable')
    assert servers.get(identifier)['model'] == 'qwen3.5:4b'
    with pytest.raises(HTTPException):
        await models.remove(identifier, record['id'], delete_files=True)
    await models.remove(identifier, record['id'])
    assert models.records(identifier) == []
    assert '/api/delete' not in calls


@pytest.mark.asyncio
async def test_cancel_retry_and_server_edit_guard(environment, monkeypatch):
    client, _ = environment
    identifier = create(client)
    started = asyncio.Event()
    async def blocked(*args):
        started.set()
        await asyncio.Event().wait()
    monkeypatch.setattr(models, 'ollama', blocked)
    record = await models.add(identifier, 'qwen3.5:4b')
    await started.wait()
    with pytest.raises(HTTPException):
        models.guard(identifier)
    with pytest.raises(HTTPException):
        await models.remove(identifier, record['id'])
    await models.action(identifier, record['id'], 'cancel')
    assert models.find(identifier, record['id'])['status'] == 'Cancelled'
    assert not models._tasks
    async def success(record, server, update):
        update({'status': 'Verifying', 'total': 100, 'completed': 100})
    monkeypatch.setattr(models, 'ollama', success)
    await models.action(identifier, record['id'], 'retry')
    assert (await finish(record))['status'] == 'Completed'


@pytest.mark.asyncio
async def test_restart_preserves_progress_for_explicit_resume(environment):
    client, _ = environment
    identifier = create(client, legacy=True)
    record = models.records(identifier)[0]
    record.update(status='Downloading', completed=50, total=100, enabled=False)
    models.write(record)
    await models.start()
    result = models.find(identifier, record['id'])
    assert result['status'] == 'Failed' and result['completed'] == 50
    assert 'Retry' in result['error']


@pytest.mark.parametrize('engine_name,value', [('vllm','../secret'), ('vllm','https://host/repo'), ('ollama','bad\nmodel'), ('ollama','model:cloud')])
def test_invalid_identifiers(engine_name,value):
    with pytest.raises(HTTPException):
        models.model_id(engine_name,value)


@pytest.mark.asyncio
async def test_vllm_missing_target_and_runtime_filtered_catalog(environment, monkeypatch):
    client, _ = environment
    identifier = create(client, 'vllm')
    monkeypatch.delenv('EASYPAPER_VLLM_TARGETS', raising=False)
    with pytest.raises(HTTPException):
        await models.add(identifier, 'Qwen/Qwen3.5-4B')
    assert not (await models.catalog(identifier))['models']
    async def capabilities(*args):
        return {'version': 'test', 'architectures': ['Qwen3_5ForConditionalGeneration']}
    monkeypatch.setattr(models, 'worker', capabilities)
    catalog = await models.catalog(identifier)
    assert catalog['models']
    assert all(m['provider'] == 'Qwen' for m in catalog['models'])


def test_members_cannot_manage_downloads(environment):
    from services.auth import create_session_token
    client, _ = environment
    identifier = create(client)
    client.post('/api/lab/users', json={'username': 'member'})
    client.put('/api/lab/settings', json={'enabled': True, 'password': 'master-secret'})
    with closing(db.get_db()) as conn, conn:
        conn.execute("UPDATE lab_accounts SET must_change_password=0 WHERE username='member'")
    client.cookies.set('session_token', create_session_token('member'))
    root = f'/api/inference/servers/{identifier}'
    for method, path, body in [('GET','/model-catalog', None), ('GET','/shared-models', None),
        ('POST','/shared-models', {'model_id':'qwen3.5:4b'}),
        ('PATCH','/shared-models/id', {'action':'enable'}), ('DELETE','/shared-models/id', None)]:
        assert client.request(method, root+path, json=body).status_code == 403


def test_stale_settings_cannot_reenable_disabled_model(environment):
    client, _ = environment
    identifier = create(client, legacy=True)
    record = models.records(identifier)[0]
    record['enabled'] = False
    models.write(record)
    models.sync_permissions(identifier)
    response = client.put('/api/inference/servers/'+identifier, json=dict(name='Renamed',engine='ollama',
        url='http://engine:11434',models=['old:latest'],model='old:latest'))
    assert response.status_code == 200
    assert response.json()['models'] == []


def test_hf_worker_pins_revision_and_verifies_native_files(tmp_path, monkeypatch):
    from services import hf_model_worker as worker
    import importlib.metadata
    events, calls = [], []
    files = {'config.json': json.dumps({'architectures':['Supported']}), 'tokenizer.json': '{}',
             'model.safetensors': 'weights', 'model.safetensors.index.json': json.dumps({'weight_map':{'a':'model.safetensors'}})}
    hub = ModuleType('huggingface_hub')
    hub.HfApi = lambda **kw: SimpleNamespace(model_info=lambda *a,**kw: SimpleNamespace(sha='fixed-commit', siblings=[SimpleNamespace(rfilename=k,size=len(v)) for k,v in files.items()]))
    def download(model, filename, tqdm_class=None, **kw):
        calls.append(kw)
        path = tmp_path / filename
        path.write_text(files[filename])
        return str(path)
    hub.hf_hub_download = download
    utils = ModuleType('huggingface_hub.utils')
    utils.tqdm = type('Progress', (), {})
    vllm = ModuleType('vllm')
    vllm.ModelRegistry = SimpleNamespace(get_supported_archs=lambda:['Supported'])
    from contextlib import nullcontext
    safetensors = ModuleType('safetensors')
    safetensors.safe_open = lambda *a, **kw: nullcontext(SimpleNamespace(keys=lambda: ['a']))
    transformers = ModuleType('transformers')
    transformers.AutoTokenizer = SimpleNamespace(from_pretrained=lambda *a, **kw: None)
    monkeypatch.setitem(sys.modules,'safetensors',safetensors)
    monkeypatch.setitem(sys.modules,'transformers',transformers)
    for name, module in [('huggingface_hub',hub),('huggingface_hub.utils',utils),('vllm',vllm)]:
        monkeypatch.setitem(sys.modules,name,module)
    monkeypatch.setattr(importlib.metadata, 'version', lambda _: 'test')
    monkeypatch.setattr(worker,'emit',lambda **value:events.append(value))
    worker.run('download','owner/repo',str(tmp_path))
    assert events[-1]['status'] == 'Completed'
    assert events[-1]['completed'] == sum(map(len,files.values()))
    assert all(c['revision'] == 'fixed-commit' for c in calls)
    files['config.json'] = json.dumps({'architectures':['Unsupported']})
    with pytest.raises(ValueError,match='does not support'):
        worker.run('download','owner/repo',str(tmp_path))
    files['config.json'] = json.dumps({'architectures':['Supported']})
    files['model.safetensors.index.json'] = json.dumps({'weight_map':{'a':'missing.safetensors'}})
    with pytest.raises(ValueError,match='shard'):
        worker.run('download','owner/repo',str(tmp_path))


@pytest.mark.asyncio
async def test_vllm_job_persists_worker_progress_and_registers(environment, monkeypatch):
    client, _ = environment
    identifier = create(client, 'vllm')
    monkeypatch.setenv('EASYPAPER_VLLM_TARGETS', json.dumps({identifier:{'python':sys.executable,'cache':'/tmp/cache'}}))
    async def worker(server_id, action, model_id='', update=None):
        assert server_id == identifier and action == 'download'
        for event in [dict(status='Downloading',total=200,completed=100),
                      dict(status='Verifying',total=200,completed=200),
                      dict(status='Completed',total=200,completed=200,revision='fixed')]:
            update(event)
        return event
    monkeypatch.setattr(models,'worker',worker)
    record = await models.add(identifier, 'Qwen/Qwen3.5-4B')
    result = await finish(record)
    assert result['revision'] == 'fixed' and result['verified']
    assert servers.get(identifier)['models'] == ['Qwen/Qwen3.5-4B']


@pytest.mark.asyncio
async def test_worker_cancellation_terminates_subprocess(tmp_path, monkeypatch):
    script = tmp_path / 'slow.py'
    script.write_text('import time\nprint(\'{"status":"Downloading"}\', flush=True)\ntime.sleep(60)\n')
    original = asyncio.create_subprocess_exec
    processes = []
    async def create(*args, **kwargs):
        process = await original(sys.executable, str(script), **kwargs)
        processes.append(process)
        return process
    monkeypatch.setattr(asyncio,'create_subprocess_exec',create)
    monkeypatch.setattr(models,'target',lambda _: {'python':sys.executable,'cache':str(tmp_path)})
    progress = asyncio.Event()
    task = asyncio.create_task(models.worker('id','download','owner/model',lambda _:progress.set()))
    await asyncio.wait_for(progress.wait(), 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert processes[0].returncode is not None
