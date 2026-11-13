import httpx
import pytest
from services import lab_inference
from services.ssh_connections import manager


@pytest.mark.asyncio
async def test_vllm_contract_and_real_inference(monkeypatch):
    calls = []
    def respond(request):
        calls.append(request)
        assert manager.active.get("inference:default") == 1
        if request.url.path == '/openapi.json':
            return httpx.Response(200, json={'paths': {'/v1/chat/completions': {'post': {'requestBody': {'content': {'application/json': {'schema': {'$ref': '#/components/schemas/Chat'}}}}}}}, 'components': {'schemas': {'Chat': {'properties': {'cache_salt': {'anyOf': [{'type': 'string'}, {'type': 'null'}]}}}}}})
        assert request.url.path == '/v1/chat/completions'
        import json
        body = json.loads(request.content)
        assert body['cache_salt'] and body['max_tokens'] == 1
        return httpx.Response(200, json={'choices': [{'message': {'content': 'OK'}}]})
    monkeypatch.setattr(httpx, 'AsyncHTTPTransport', lambda: httpx.MockTransport(respond))
    lab_inference._verified.clear()
    config = {'engine': 'vllm', 'url': 'http://server/v1', 'model': 'model'}
    assert (await lab_inference.probe(config))['inference_verified']
    await lab_inference.require_cache_salt(config)
    assert len(calls) == 2
    assert manager.active["inference:default"] == 0


@pytest.mark.asyncio
async def test_vllm_without_cache_salt_is_rejected(monkeypatch):
    monkeypatch.setattr(httpx, 'AsyncHTTPTransport', lambda: httpx.MockTransport(lambda req: httpx.Response(200, json={'paths': {}})))
    lab_inference._verified.clear()
    with pytest.raises(RuntimeError, match='cache_salt'):
        await lab_inference.require_cache_salt({'url': 'http://old-server/v1'})


@pytest.mark.asyncio
async def test_diagnostic_budget_rejection_never_sends_completion(monkeypatch):
    from contextlib import asynccontextmanager
    from fastapi import HTTPException
    from services import lab, lab_resources, inference_servers
    from services.lab_context import selected_server
    config = {'id': 'diagnostic', 'engine': 'ollama', 'model': 'm', 'models': ['m']}
    monkeypatch.setattr(lab, 'settings', lambda: {'enabled': True})
    monkeypatch.setattr(inference_servers, 'get', lambda *args, **kwargs: config)
    @asynccontextmanager
    async def denied(value):
        assert value is config
        raise HTTPException(409, 'GPU budget full')
        yield
    monkeypatch.setattr(lab_resources, 'admission', denied)
    async def forbidden(value):
        pytest.fail('Completion bypassed GPU admission')
    monkeypatch.setattr(lab_inference, 'probe', forbidden)
    previous = selected_server.get()
    with pytest.raises(HTTPException, match='GPU budget full'):
        await lab_inference.checked_probe(config)
    assert selected_server.get() is previous
    assert manager.active.get('inference:diagnostic', 0) == 0


@pytest.mark.asyncio
async def test_diagnostic_waits_for_inference_slot_and_caps_context(monkeypatch):
    import asyncio
    import json
    from contextlib import asynccontextmanager
    from services import lab, lab_resources, lab_tasks, inference_servers
    config = {'id': 'diagnostic', 'engine': 'ollama', 'url': 'http://engine',
              'model': 'm', 'models': ['m'], 'max_concurrent': 1,
              'memory_policy': {'models': {'m': {'context_tokens': 2048}}}}
    monkeypatch.setattr(lab, 'settings', lambda: {'enabled': True})
    monkeypatch.setattr(inference_servers, 'get', lambda *args, **kwargs: config)
    reserved = False
    @asynccontextmanager
    async def memory(value):
        nonlocal reserved
        reserved = True
        try:
            yield
        finally:
            reserved = False
    monkeypatch.setattr(lab_resources, 'admission', memory)
    calls = []
    def respond(request):
        assert reserved
        assert json.loads(request.content)['options'] == {'num_predict': 1, 'num_ctx': 2048}
        calls.append(request)
        return httpx.Response(200, json={'message': {'content': 'OK'}})
    monkeypatch.setattr(httpx, 'AsyncHTTPTransport', lambda: httpx.MockTransport(respond))
    async with lab_tasks.admission('alice', 'diagnostic', 'm'):
        task = asyncio.create_task(lab_inference.checked_probe(config))
        await asyncio.sleep(0)
        assert not task.done() and not calls
    assert (await asyncio.wait_for(task, 1))['inference_verified']
    assert len(calls) == 1 and not reserved
