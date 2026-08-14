"""services/auth.py 단위 테스트 (비밀번호 해시, 세션 토큰 발급/검증)."""

import time

import pytest
from fastapi import HTTPException

from services.auth import (
    hash_password,
    verify_password,
    create_session_token,
    verify_session_token,
    get_current_user,
    get_login_lockout_remaining,
    record_failed_login,
    reset_login_attempts,
    LOGIN_MAX_ATTEMPTS,
    SESSION_TTL_DEFAULT_SECONDS,
    SESSION_TTL_REMEMBER_SECONDS,
)


class FakeRequest:
    """request.client.host만 흉내내는 최소 페이크(라우터의 Request 대신 사용)."""
    def __init__(self, ip="1.2.3.4"):
        self.client = type("Client", (), {"host": ip})()


def test_hash_password_produces_verifiable_hash():
    h = hash_password("my-secret-pw")
    assert ":" in h
    assert verify_password(h, "my-secret-pw") is True


def test_verify_password_rejects_wrong_password():
    h = hash_password("correct-password")
    assert verify_password(h, "wrong-password") is False


def test_verify_password_accepts_configured_plaintext_password(monkeypatch):
    """APP_PASSWORD(평문)가 설정된 경우의 비교 경로 - compare_digest로 bytes 비교하도록
    바뀌었으므로 정상적으로 동작하는지, 비ASCII(한글) 비밀번호도 지원하는지 확인."""
    import services.auth as auth_module
    monkeypatch.setattr(auth_module, "get_app_password", lambda: "비밀번호123!")
    assert verify_password("unused-hash", "비밀번호123!") is True
    assert verify_password("unused-hash", "wrong") is False


def test_verify_password_rejects_malformed_hash():
    assert verify_password("not-a-valid-hash", "anything") is False


def test_hash_password_uses_random_salt():
    h1 = hash_password("same-password")
    h2 = hash_password("same-password")
    assert h1 != h2, "매번 다른 salt를 써야 같은 비밀번호도 다른 해시가 나온다"


def test_session_token_round_trip():
    token = create_session_token("admin")
    assert verify_session_token(token) is True
    assert token.split(":")[0] == "admin"


def test_session_token_round_trip_with_colon_in_username():
    token = create_session_token("team:admin")
    assert verify_session_token(token) is True
    assert token.rsplit(":", 2)[0] == "team:admin"


def test_session_token_rejects_tampered_username():
    token = create_session_token("admin")
    _, expires, sig = token.split(":")
    forged = f"attacker:{expires}:{sig}"
    assert verify_session_token(forged) is False, \
        "서명은 원래 username에 대해 계산된 것이므로 username을 바꾸면 검증에 실패해야 한다"


def test_session_token_rejects_expired_token():
    payload = "admin:" + str(int(time.time()) - 10)  # 이미 만료된 시각
    import hmac, hashlib
    from config import SECRET_KEY
    sig = hmac.new(SECRET_KEY.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    expired_token = f"{payload}:{sig}"
    assert verify_session_token(expired_token) is False


def test_session_token_rejects_malformed_token():
    assert verify_session_token("not-enough-parts") is False
    assert verify_session_token("") is False


def test_create_session_token_respects_custom_ttl():
    """"로그인 상태 유지" 체크 시 기본 7일보다 훨씬 긴 만료 기간을 써야 한다."""
    token = create_session_token("admin", ttl_seconds=SESSION_TTL_REMEMBER_SECONDS)
    _, expires_str, _ = token.split(":")
    expires = int(expires_str)
    assert expires - int(time.time()) > SESSION_TTL_DEFAULT_SECONDS


async def test_get_current_user_bypasses_cookie_check_when_skip_login_enabled(monkeypatch):
    """로그인 생략 설정이 켜져 있으면 쿠키 확인 없이 바로 관리자로 인증돼야 한다."""
    import services.auth as auth_module
    monkeypatch.setattr(auth_module, "get_skip_login", lambda: True)
    monkeypatch.setattr(auth_module, "get_app_username", lambda: "admin")
    username = await get_current_user(None)
    assert username == "admin"


async def test_get_current_user_still_requires_cookie_when_skip_login_disabled(monkeypatch):
    """로그인 생략 설정이 꺼져 있으면 기존처럼 쿠키가 없을 때 401을 내야 한다."""
    import services.auth as auth_module
    monkeypatch.setattr(auth_module, "get_skip_login", lambda: False)

    class FakeRequest:
        cookies = {}

    with pytest.raises(HTTPException):
        await get_current_user(FakeRequest())


async def test_get_current_user_preserves_colon_in_username(monkeypatch):
    import services.auth as auth_module

    monkeypatch.setattr(auth_module, "get_skip_login", lambda: False)
    token = create_session_token("team:admin")

    class FakeRequest:
        cookies = {"session_token": token}

    assert await get_current_user(FakeRequest()) == "team:admin"


def test_login_lockout_starts_unlocked():
    req = FakeRequest("10.0.0.1")
    assert get_login_lockout_remaining(req) == 0


def test_record_failed_login_locks_out_after_max_attempts():
    req = FakeRequest("10.0.0.2")
    for _ in range(LOGIN_MAX_ATTEMPTS - 1):
        record_failed_login(req)
        assert get_login_lockout_remaining(req) == 0, "임계치 도달 전에는 잠기면 안 된다"

    record_failed_login(req)
    assert get_login_lockout_remaining(req) > 0, "임계치에 도달하면 잠겨야 한다"


def test_reset_login_attempts_clears_lockout():
    req = FakeRequest("10.0.0.3")
    for _ in range(LOGIN_MAX_ATTEMPTS):
        record_failed_login(req)
    assert get_login_lockout_remaining(req) > 0

    reset_login_attempts(req)
    assert get_login_lockout_remaining(req) == 0, "로그인 성공(초기화) 후에는 잠금이 풀려야 한다"


def test_login_lockout_is_scoped_per_client_ip():
    attacker = FakeRequest("10.0.0.4")
    bystander = FakeRequest("10.0.0.5")
    for _ in range(LOGIN_MAX_ATTEMPTS):
        record_failed_login(attacker)

    assert get_login_lockout_remaining(attacker) > 0
    assert get_login_lockout_remaining(bystander) == 0, \
        "다른 IP의 실패 시도가 무관한 클라이언트를 잠그면 안 된다"


def test_login_lockout_expires_after_window(monkeypatch):
    import services.auth as auth_module

    req = FakeRequest("10.0.0.6")
    for _ in range(LOGIN_MAX_ATTEMPTS):
        record_failed_login(req)
    assert get_login_lockout_remaining(req) > 0

    real_time = time.time
    monkeypatch.setattr(auth_module.time, "time", lambda: real_time() + auth_module.LOGIN_LOCKOUT_SECONDS + 1)
    assert get_login_lockout_remaining(req) == 0, "잠금 시간이 지나면 다시 시도할 수 있어야 한다"
