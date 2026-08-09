import httpx
import pytest

from services import llm_client


async def _collect(generator):
    return [token async for token in generator]


@pytest.mark.asyncio
async def test_gemini_uses_header_for_api_key(monkeypatch):
    seen = None
    def handler(request):
        nonlocal seen
        seen = request
        return httpx.Response(200, content=b'[{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}]')
    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient
    monkeypatch.setattr(llm_client, "get_gemini_api_key", lambda: "secret-key")
    monkeypatch.setattr(llm_client.httpx, "AsyncClient", lambda **kw: real_client(transport=transport, **kw))
    assert await _collect(llm_client.stream_gemini([{"role": "user", "content": "hello"}], "gemini-test")) == ["ok"]
    assert seen.url.query == b""
    assert seen.headers["x-goog-api-key"] == "secret-key"


@pytest.mark.asyncio
async def test_gemini_redacts_unexpected_exception(monkeypatch):
    class FailingClient:
        async def __aenter__(self):
            raise RuntimeError("secret-key https://example.test/?key=secret-key")
        async def __aexit__(self, *args):
            return False
    monkeypatch.setattr(llm_client, "get_gemini_api_key", lambda: "secret-key")
    monkeypatch.setattr(llm_client.httpx, "AsyncClient", lambda **kw: FailingClient())
    with pytest.raises(RuntimeError) as exc:
        await _collect(llm_client.stream_gemini([{"role": "user", "content": "hello"}], "gemini-test"))
    assert str(exc.value) == "Gemini 요청 처리 중 오류가 발생했습니다."
    assert "secret-key" not in str(exc.value)
