import hashlib
import hmac
import os
import time
from fastapi import Depends, Request, HTTPException, status
from config import get_app_password, get_app_username, get_skip_login, SECRET_KEY

def verify_password(stored_password_hash: str, provided_password: str) -> bool:
    # 1. 만약 평문 비밀번호(APP_PASSWORD)가 설정되어 있다면 즉시 비교
    # (== 대신 compare_digest로 비교 - 문자열 조기 종료 비교는 앞글자부터
    # 하나씩 맞춰가는 타이밍 공격에 이론상 노출된다. 비ASCII 비밀번호도
    # 지원하도록 bytes로 인코딩해 비교한다.)
    app_pwd = get_app_password()
    if app_pwd and hmac.compare_digest(provided_password.encode('utf-8'), app_pwd.encode('utf-8')):
        return True

    # 2. 해시 기반 검증 수행 (하위 호환 및 보안 권장 사양)
    try:
        salt_hex, key_hex = stored_password_hash.split(':')
        salt = bytes.fromhex(salt_hex)
        key = bytes.fromhex(key_hex)
        new_key = hashlib.pbkdf2_hmac('sha256', provided_password.encode('utf-8'), salt, 100000)
        return hmac.compare_digest(new_key, key)
    except Exception:
        return False


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    key = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 100000)
    return f"{salt.hex()}:{key.hex()}"


# ─────────────────────────────────────────────────────────
#  로그인 무차별 대입(brute-force) 방어
# ─────────────────────────────────────────────────────────
# self-host 배포(리버스 프록시 뒤 네트워크 노출)를 명시적으로 지원하는 앱인데
# 로그인 시도 횟수 제한이 전혀 없어, 비밀번호를 admin/admin에서 바꾼 뒤에도
# 무제한으로 대입 공격이 가능했다. Redis 등 별도 인프라 없이(단일 관리자
# 계정, 인메모리 세션과 동일한 수준의 영속성이면 충분) 클라이언트 IP 기준
# 슬라이딩 윈도우 잠금을 둔다 - 서버 재시작 시 초기화되는 건 감내 가능한
# 트레이드오프(재시작 자체가 이미 관리자 권한이 필요한 드문 이벤트).
LOGIN_MAX_ATTEMPTS = 5
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_LOCKOUT_SECONDS = 5 * 60

# IP -> {"count": 실패 횟수, "first_at": 첫 실패 시각, "locked_until": 잠금 해제 시각}
_login_failures: dict[str, dict] = {}


def _client_ip(request: Request) -> str:
    # 리버스 프록시(NPM 등) 뒤에서는 request.client.host가 프록시 자신의
    # 주소로 잡혀 모든 클라이언트가 하나로 묶일 수 있지만, X-Forwarded-For는
    # 프록시를 신뢰할 수 있다는 보장 없이는 클라이언트가 임의로 위조해
    # 잠금을 우회할 수 있는 값이라 그대로 신뢰하지 않는다. 지금은 요청의
    # 실제 커넥션 주소만 기준으로 삼는다.
    return request.client.host if request.client else "unknown"


def get_login_lockout_remaining(request: Request) -> float:
    """현재 요청의 클라이언트가 잠겨 있으면 남은 초를, 아니면 0을 반환합니다."""
    state = _login_failures.get(_client_ip(request))
    if not state:
        return 0.0
    remaining = state.get("locked_until", 0) - time.time()
    return remaining if remaining > 0 else 0.0


def record_failed_login(request: Request) -> None:
    """로그인 실패를 기록하고, 임계치를 넘으면 잠급니다."""
    ip = _client_ip(request)
    now = time.time()
    state = _login_failures.get(ip)
    if not state or now - state["first_at"] > LOGIN_WINDOW_SECONDS:
        state = {"count": 0, "first_at": now, "locked_until": 0.0}
    state["count"] += 1
    if state["count"] >= LOGIN_MAX_ATTEMPTS:
        state["locked_until"] = now + LOGIN_LOCKOUT_SECONDS
    _login_failures[ip] = state


def reset_login_attempts(request: Request) -> None:
    """로그인 성공 시 해당 클라이언트의 실패 기록을 초기화합니다."""
    _login_failures.pop(_client_ip(request), None)

SESSION_TTL_DEFAULT_SECONDS = 7 * 24 * 3600
# "로그인 상태 유지"를 체크했을 때 쓰는 훨씬 긴 만료 기간 - 매번 다시
# 로그인하지 않아도 되는 "자동 로그인" 효과를 기존의 안전한 HttpOnly
# 세션 쿠키 메커니즘 그대로(새로운 자격증명 저장 없이) 얻는다.
SESSION_TTL_REMEMBER_SECONDS = 90 * 24 * 3600

def create_session_token(username: str, ttl_seconds: int = SESSION_TTL_DEFAULT_SECONDS) -> str:
    expires = int(time.time()) + ttl_seconds
    payload = f"{username}:{expires}"
    signature = hmac.new(SECRET_KEY.encode('utf-8'), payload.encode('utf-8'), hashlib.sha256).hexdigest()
    return f"{payload}:{signature}"

def verify_session_token(token: str) -> bool:
    try:
        parts = token.rsplit(':', 2)
        if len(parts) != 3:
            return False
        username, expires_str, signature = parts
        expires = int(expires_str)
        if time.time() > expires:
            return False
        payload = f"{username}:{expires_str}"
        expected_signature = hmac.new(SECRET_KEY.encode('utf-8'), payload.encode('utf-8'), hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected_signature, signature)
    except Exception:
        return False

async def get_current_user(request: Request) -> str:
    if get_skip_login():
        return get_app_username()

    token = request.cookies.get("session_token")
    if not token or not verify_session_token(token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="로그인이 필요합니다.",
        )
    return token.rsplit(':', 2)[0]


async def require_admin_user(current_user: str = Depends(get_current_user)) -> str:
    """현재 단일 관리자 계정과 일치하는 인증 사용자만 반환합니다."""
    configured_admin = get_app_username()
    if not hmac.compare_digest(current_user.encode("utf-8"), configured_admin.encode("utf-8")):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="관리자 권한이 필요합니다.")
    return current_user
