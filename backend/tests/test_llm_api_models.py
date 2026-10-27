import json

import httpx
import pytest

from services import llm_client


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("provider", "model", "supports_temperature"),
    [
        ("openai", "gpt-6.1-terra", False),
        ("openai", "gpt-6.1-sol", False),
        ("openai", "gpt-6-astra", False),
        ("openai", "gpt-6-sol", False),
        ("openai", "gpt-6-luna", False),
        ("openai", "gpt-4o", True),
        ("claude", "claude-opus-5-5", False),
        ("claude", "claude-fable-5-1", False),
        ("claude", "claude-sonnet-5-5", False),
        ("claude", "claude-haiku-5-5", False),
        ("claude", "claude-haiku-4-5", True),
    ],
)
async def test_model_sampling_compatibility(monkeypatch, provider, model, supports_temperature):
    captured = {}

    def handler(request):
        captured.update(json.loads(request.content))
        if provider == "openai":
            content = b'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
        else:
            content = b'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hidden"}}\n\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n'
        return httpx.Response(200, content=content)

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(llm_client, f"get_{provider}_api_key", lambda: "test-key")
    monkeypatch.setattr(llm_client.httpx, "AsyncClient", lambda **kwargs: real_client(transport=transport, **kwargs))
    stream = getattr(llm_client, f"stream_{provider}")
    messages = [{"role": "system", "content": "Translate"}, {"role": "user", "content": "hello"}]
    assert [token async for token in stream(messages, model)] == ["ok"]
    assert captured["model"] == model
    assert ("temperature" in captured) is supports_temperature
    if supports_temperature:
        assert captured["temperature"] == 0.5
    if provider == "claude":
        assert captured["system"] == "Translate"
        assert captured["max_tokens"] == 8192
