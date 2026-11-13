import asyncio
from contextlib import closing

import pytest
from fastapi import HTTPException

from test_lab_mode import environment
from services import db, lab, inference_servers, lab_models, lab_resources, lab_tasks
from services.lab_context import identity


def register(client, **changes):
    value = dict(lab_shared=True, name='Shared', engine='ollama', url='http://localhost:11434',
                 models=['small', 'large'], model='small')
    value.update(changes)
    response = client.post('/api/inference/servers', json=value)
    assert response.status_code == 201, response.text
    return response.json()


def enable(client):
    assert client.put('/api/lab/settings', json={'enabled': True, 'password': 'master-secret'}).status_code == 200


def test_mode_selections_are_preserved_and_disabled_server_cannot_run(environment):
    client, master = environment
    server = register(client)
    personal = dict(provider='ollama', model='small', server_id=server['id'])
    client.put('/api/me/model-settings', json=personal)
    enable(client)
    assert client.get('/api/me/model-settings').json() == {}
    shared = dict(personal, model='large')
    client.put('/api/me/model-settings', json=shared)
    assert client.put('/api/inference/servers/' + server['id'], json=dict(server, enabled=False)).status_code == 200
    assert client.put('/api/me/model-settings', json=shared).status_code == 409
    token = identity.set(master)
    try:
        with pytest.raises(HTTPException, match='disabled'):
            lab.selection()
    finally:
        identity.reset(token)
    client.put('/api/lab/settings', json={'enabled': False, 'password': 'master-secret'})
    assert client.get('/api/me/model-settings').json() == personal


@pytest.mark.asyncio
async def test_snapshot_filters_disabled_and_distinguishes_residency(environment, monkeypatch):
    client, _ = environment
    server = register(client)
    register(client, name='Hidden', enabled=False)
    enable(client)
    async def observe(record):
        assert record['id'] == server['id']
        return {'small': 1234}, None
    monkeypatch.setattr(lab_models, 'observe', observe)
    lab_models._observers.clear()
    value = await lab_models.snapshot()
    assert [m['state'] for m in value['models']] == ['idle', 'unloaded']
    common = dict(server, model='large')
    async with lab_models.tracking(common, waiting=True):
        assert (await lab_models.snapshot())['models'][1]['queued_requests'] == 1
    async with lab_models.tracking(common):
        assert (await lab_models.snapshot())['models'][1]['state'] == 'loading'
        async with lab_models.tracking(dict(server, model='small')):
            assert (await lab_models.snapshot())['models'][0]['state'] == 'inferencing'
    assert (await lab_models.snapshot())['models'][0]['active_requests'] == 0
    assert 'username' not in str(value) and 'url' not in str(value)


@pytest.mark.asyncio
async def test_observation_is_shared_by_concurrent_subscribers(environment, monkeypatch):
    client, _ = environment
    register(client); enable(client)
    calls = []
    async def observe(server):
        calls.append(server['id'])
        await asyncio.sleep(0)
        return {}, None
    monkeypatch.setattr(lab_models, 'observe', observe)
    lab_models._observers.clear()
    await asyncio.gather(*(lab_models.snapshot() for _ in range(8)))
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_memory_reservations_block_overcommit_and_do_not_kill_running_work(monkeypatch):
    policy = lab_resources.MemoryPolicy(gpu_pool='GPU-test', budget_gib=2, max_loaded=1, models={
        name: {'parameters_billions': 1, 'context_tokens': 1, 'concurrency': 2} for name in ['a', 'b']})
    server = dict(id='memory-test', engine='ollama', url='https://remote.example', model='a', memory_policy=policy.model_dump())
    async def observe(_):
        return {}, None
    monkeypatch.setattr(lab_models, 'observe', observe)
    lab_resources._states.clear()
    async with lab_resources.admission(server):
        async with lab_resources.admission(server):
            with pytest.raises(HTTPException, match='concurrency'):
                async with lab_resources.admission(server):
                    pytest.fail('Must not exceed model concurrency')
        with pytest.raises(HTTPException, match='budget'):
            async with lab_resources.admission(dict(server, model='b')):
                pytest.fail('Must not load a second model')
    async with lab_resources.admission(dict(server, model='b')):
        pass


def test_estimate_includes_quantization_context_concurrency_and_measured_floor():
    small = lab_resources.ModelMemory(parameters_billions=7)
    assert lab_resources.ModelMemory(parameters_billions=7, weight_bits=8).estimate() > small.estimate()
    assert lab_resources.ModelMemory(parameters_billions=7, concurrency=4).estimate() > small.estimate()
    assert lab_resources.ModelMemory(parameters_billions=7, measured_gib=20).estimate() >= 20 * 2**30
    policy = lab_resources.MemoryPolicy(gpu_pool='GPU-test', budget_gib=1, models={'large': small})
    assert lab_resources.recommendations({'models': ['large', 'unknown']}, policy)['suggestions'] == []


@pytest.mark.asyncio
async def test_eligible_fifo_skips_user_at_limit_and_cancel_does_not_leak(monkeypatch):
    monkeypatch.setattr(lab, 'configuration', lambda: {'engine': 'ollama', 'max_concurrent': 2, 'per_user': 1})
    monkeypatch.setattr(lab, 'settings', lambda: {'enabled': True})
    lab_tasks._limits.clear()
    order = []
    async def work(user):
        async with lab_tasks.admission(user):
            order.append(user)
    async with lab_tasks.admission('alice'):
        alice = asyncio.create_task(work('alice'))
        bob = asyncio.create_task(work('bob'))
        await asyncio.wait_for(bob, 1)
        assert order == ['bob']
        alice.cancel()
        await asyncio.gather(alice, return_exceptions=True)
    state = lab_tasks._limits[asyncio.get_running_loop()][None]
    assert not state['waiters'] and state['total'] == 0


def test_master_only_resource_controls_and_unregistered_models(environment):
    client, _ = environment
    server = register(client)
    assert client.post('/api/lab/resources/' + server['id'] + '/unload', json={'model': 'unregistered'}).status_code == 404
    client.post('/api/lab/users', json={'username': 'member'})
    enable(client)
    with closing(db.get_db()) as conn, conn:
        conn.execute("UPDATE lab_accounts SET must_change_password=0 WHERE username='member'")
    from services.auth import create_session_token
    client.cookies.set('session_token', create_session_token('member'))
    assert client.get('/api/lab/resources/' + server['id']).status_code == 403
    assert client.put('/api/inference/servers/' + server['id'], json=server).status_code == 403


def test_personal_servers_never_enter_lab_catalog_or_selection(environment):
    client, master = environment
    server = register(client, lab_shared=False)
    enable(client)
    result = client.get('/api/lab/models').json()
    assert result['models'] == []
    assert client.put('/api/me/model-settings', json={'provider': 'ollama', 'model': 'small', 'server_id': server['id']}).status_code == 409


@pytest.mark.asyncio
async def test_model_memory_concurrency_waits_without_blocking_other_models(monkeypatch):
    policy = {'engine': 'ollama', 'models': ['large', 'small'], 'max_concurrent': 3, 'per_user': 2,
              'memory_policy': {'models': {'large': {'concurrency': 1}}}}
    monkeypatch.setattr(lab, 'configuration', lambda: policy)
    monkeypatch.setattr(lab, 'settings', lambda: {'enabled': True})
    lab_tasks._limits.clear()
    order = []
    async def request(model):
        async with lab_tasks.admission('bob', model=model):
            order.append(model)
    async with lab_tasks.admission('alice', model='large'):
        large = asyncio.create_task(request('large'))
        small = asyncio.create_task(request('small'))
        await asyncio.wait_for(small, 1)
        assert order == ['small']
    await asyncio.wait_for(large, 1)
    assert order == ['small', 'large']


def test_ollama_payload_context_is_capped_without_mutating_personal_settings():
    from services.lab_context import selected_server
    payload = {'options': {'num_ctx': 16384, 'temperature': 0.5}}
    token = selected_server.set({'provider': 'ollama', 'model': 'm', 'memory_policy': {'models': {'m': {'context_tokens': 4096}}}})
    try:
        assert lab_resources.constrain_payload(payload)['options']['num_ctx'] == 4096
        assert payload['options']['num_ctx'] == 16384
    finally:
        selected_server.reset(token)
    assert lab_resources.constrain_payload(payload) is payload


@pytest.mark.asyncio
async def test_vllm_sleep_is_unloaded_and_status_failures_are_not_idle(monkeypatch):
    import httpx
    asleep = True
    def response(request):
        if request.url.path == '/v1/models':
            return httpx.Response(200, json={'data': [{'id': 'm'}]})
        if request.url.path == '/health':
            return httpx.Response(200)
        return httpx.Response(200, json={'is_sleeping': asleep})
    monkeypatch.setattr(lab_models, 'client', lambda *args, **kwargs: httpx.AsyncClient(transport=httpx.MockTransport(response)))
    server = {'id': 's', 'engine': 'vllm', 'url': 'https://example.test/v1'}
    assert await lab_models.observe(server) == ({}, None)
    asleep = False
    assert await lab_models.observe(server) == ({'m': None}, None)


def test_lab_master_can_delete_last_shared_server(environment):
    client, _ = environment
    server = register(client)
    enable(client)
    assert client.delete('/api/inference/servers/' + server['id']).status_code == 200
    assert client.get('/api/lab/models').json()['models'] == []
    assert client.put('/api/me/model-settings', json={'provider': 'codex', 'model': 'test'}).status_code == 200


@pytest.mark.asyncio
async def test_lab_memory_policy_is_required_but_normal_mode_unchanged(environment):
    client, _ = environment
    server = register(client)
    async with lab_resources.admission(server):
        pass
    enable(client)
    with pytest.raises(HTTPException, match='memory policy'):
        async with lab_resources.admission(server):
            pytest.fail('Lab requests must not bypass memory admission')


@pytest.mark.asyncio
async def test_two_servers_share_one_gpu_budget_and_catalog_decision(environment, monkeypatch):
    client, _ = environment
    policy = lab_resources.MemoryPolicy(gpu_pool='GPU-shared', budget_gib=1, max_loaded=2,
        models={'small': {'parameters_billions': 1, 'context_tokens': 1},
                'large': {'parameters_billions': 1, 'context_tokens': 1}}).model_dump()
    first = register(client, memory_policy=policy, url='https://gpu-one.example')
    second = register(client, memory_policy=policy, url='https://gpu-two.example')
    enable(client)
    async def observe(_):
        return {}, None
    monkeypatch.setattr(lab_models, 'observe', observe)
    lab_resources._states.clear(); lab_models._observers.clear()
    async with lab_resources.admission(first):
        with pytest.raises(HTTPException, match='pool budget'):
            async with lab_resources.admission(second):
                pytest.fail('Two endpoints must not overbook the same GPU')
        model = next(m for m in (await lab_models.snapshot())['models'] if m['server_id'] == second['id'])
        assert not model['available'] and 'pool budget' in model['detail']
    async with lab_resources.admission(second):
        pass


@pytest.mark.asyncio
async def test_ollama_latest_alias_does_not_double_reserve(environment, monkeypatch):
    client, _ = environment
    policy = lab_resources.MemoryPolicy(gpu_pool='GPU-alias', budget_gib=1, max_loaded=1,
        models={'small': {'parameters_billions': 1, 'context_tokens': 1, 'concurrency': 2}}).model_dump()
    server = register(client, models=['small'], memory_policy=policy, url='https://gpu.example')
    enable(client)
    async def observe(_):
        return {'small:latest': 600_000_000}, None
    monkeypatch.setattr(lab_models, 'observe', observe)
    lab_resources._states.clear(); lab_models._observers.clear()
    model = (await lab_models.snapshot())['models'][0]
    assert model['state'] == 'idle' and model['available'] and model['vram_bytes'] == 600_000_000
    async with lab_resources.admission(server):
        async with lab_resources.admission(server):
            pass


def test_single_process_guard_rejects_another_worker(environment):
    import os
    import subprocess
    import sys
    from services import lab_runtime
    lab_runtime.ensure_owner()
    script = "from services import db, lab_runtime; db.DB_PATH = " + repr(str(db.DB_PATH)) + "; lab_runtime.ensure_owner()"
    environment_vars = dict(os.environ, PYTHONPATH=str(__import__('pathlib').Path(__file__).parents[1]))
    result = subprocess.run([sys.executable, '-c', script], env=environment_vars, capture_output=True, text=True)
    assert result.returncode != 0 and 'one backend worker' in result.stderr
    lab_runtime.release_owner()
    assert subprocess.run([sys.executable, '-c', script], env=environment_vars, capture_output=True).returncode == 0


@pytest.mark.asyncio
async def test_ssh_gpu_query_uses_fixed_command_and_not_jump_host(monkeypatch):
    from types import SimpleNamespace
    from services.ssh_connections import manager
    commands = []
    class Connection:
        async def run(self, command, **kwargs):
            commands.append(command)
            return SimpleNamespace(stdout='GPU-abc, Test GPU, 24576, 16384\n')
    async def port(key, server):
        return 12345
    monkeypatch.setattr(manager, 'port', port)
    monkeypatch.setattr(manager, 'connections', {'inference:test': (Connection(), None, None)})
    server = {'id': 'test', 'transport': 'ssh', 'url': 'http://localhost:11434'}
    result = await lab_resources.gpu_info(server)
    assert result['gpus'][0]['id'] == 'GPU-abc'
    assert commands == ['nvidia-smi --query-gpu=uuid,name,memory.total,memory.free --format=csv,noheader,nounits']
    result = await lab_resources.gpu_info(dict(server, url='http://another-host:11434'))
    assert not result['available'] and len(commands) == 1


def test_unload_through_alias_cannot_interrupt_other_server(environment):
    from services.ssh_connections import manager
    client, _ = environment
    first = register(client)
    alias = register(client)
    manager.active['inference:' + first['id']] = 1
    try:
        assert client.post('/api/lab/resources/' + alias['id'] + '/unload', json={'model': 'small'}).status_code == 409
    finally:
        manager.active.pop('inference:' + first['id'])
