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
