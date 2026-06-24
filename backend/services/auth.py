import hashlib
import hmac
import os
import time
from fastapi import Request, HTTPException, status
from config import get_app_password, SECRET_KEY

def verify_password(stored_password_hash: str, provided_password: str) -> bool:
    # 1. 만약 평문 비밀번호(APP_PASSWORD)가 설정되어 있다면 즉시 비교
    app_pwd = get_app_password()
    if app_pwd and provided_password == app_pwd:
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

def create_session_token(username: str) -> str:
    # 7일 만료
    expires = int(time.time()) + 7 * 24 * 3600
    payload = f"{username}:{expires}"
    signature = hmac.new(SECRET_KEY.encode('utf-8'), payload.encode('utf-8'), hashlib.sha256).hexdigest()
    return f"{payload}:{signature}"

def verify_session_token(token: str) -> bool:
    try:
        parts = token.split(':')
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
    token = request.cookies.get("session_token")
    if not token or not verify_session_token(token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="로그인이 필요합니다.",
        )
    return token.split(':')[0]
