import pytest
from fastapi import HTTPException

from services.rate_limiter import SlidingWindowRateLimiter


def test_sliding_window_rate_limiter_returns_retry_after_and_isolates_users():
    now = [100.0]
    limiter = SlidingWindowRateLimiter({"chat": (2, 10.0)}, clock=lambda: now[0])

    limiter.check("chat", "alice")
    limiter.check("chat", "alice")
    limiter.check("chat", "bob")

    with pytest.raises(HTTPException) as exc_info:
        limiter.check("chat", "alice")

    assert exc_info.value.status_code == 429
    assert exc_info.value.headers == {"Retry-After": "10"}

    now[0] = 110.0
    limiter.check("chat", "alice")


def test_sliding_window_rate_limiter_evicts_retired_identities():
    now = [100.0]
    limiter = SlidingWindowRateLimiter({"chat": (2, 10.0)}, clock=lambda: now[0])

    limiter.check("chat", "old-name")
    limiter.check("chat", "other-user")
    assert len(limiter._requests) == 2

    now[0] = 110.0
    limiter.check("chat", "active-user")

    assert set(limiter._requests) == {("chat", "active-user")}


def test_upload_endpoint_enforces_configured_limit(test_client, monkeypatch):
    import services.rate_limiter as rate_limiter

    limiter = SlidingWindowRateLimiter({"upload": (1, 60.0)})
    monkeypatch.setattr(rate_limiter, "request_rate_limiter", limiter)

    first = test_client.post(
        "/api/upload",
        files={"file": ("invalid.txt", b"not a pdf", "text/plain")},
    )
    second = test_client.post(
        "/api/upload",
        files={"file": ("invalid.txt", b"not a pdf", "text/plain")},
    )

    assert first.status_code == 400
    assert second.status_code == 429
    assert second.headers["Retry-After"] == "60"
