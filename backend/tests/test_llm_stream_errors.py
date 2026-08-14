import httpx
import pytest

from services.llm_client import _ensure_provider_response_ok, _raise_provider_transport_error


@pytest.mark.asyncio
async def test_provider_http_error_preserves_message_and_body_limit():
    response = httpx.Response(429, content=b"x" * 205)

    with pytest.raises(RuntimeError) as exc_info:
        await _ensure_provider_response_ok(response, "Gemini")

    assert str(exc_info.value) == f"Gemini API 오류 (HTTP 429): {'x' * 200}"


@pytest.mark.asyncio
async def test_provider_success_response_is_accepted():
    await _ensure_provider_response_ok(httpx.Response(200), "OpenAI")


@pytest.mark.parametrize(
    ("provider", "error", "message"),
    [
        ("OpenAI", httpx.ConnectError("offline"), "OpenAI 서버에 연결할 수 없습니다."),
        ("Claude", httpx.ReadTimeout("slow"), "Claude 요청 시간이 초과되었습니다."),
    ],
)
def test_provider_transport_errors_preserve_messages(provider, error, message):
    with pytest.raises(RuntimeError, match=f"^{message}$"):
        _raise_provider_transport_error(provider, error)
