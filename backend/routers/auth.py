from fastapi import APIRouter, Response, HTTPException, status, Depends
from fastapi.responses import StreamingResponse
import json
import httpx
from pydantic import BaseModel
from services.auth import verify_password, hash_password, create_session_token, get_current_user
from config import (
    get_app_username,
    get_app_password_hash,
    update_credentials_in_env,
    get_ollama_host,
    update_system_settings,
    get_trans_provider,
    get_trans_model,
    get_chat_provider,
    get_chat_model,
    get_openai_api_key,
    get_gemini_api_key,
    get_claude_api_key
)
from services.llm_client import check_ollama_health

router = APIRouter()

class LoginRequest(BaseModel):
    username: str
    password: str

class ChangeCredentialsRequest(BaseModel):
    current_password: str
    new_username: str
    new_password: str

@router.post("/auth/login")
async def login(response: Response, data: LoginRequest):
    from services.db import get_user
    user = get_user(data.username)
    
    if not user or not verify_password(user["password_hash"], data.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="아이디 또는 비밀번호가 올바르지 않습니다."
        )
    
    token = create_session_token(data.username)
    
    # 보안 강화를 위해 HttpOnly, SameSite=Lax 적용 쿠키로 토큰 주입
    response.set_cookie(
        key="session_token",
        value=token,
        httponly=True,
        max_age=7 * 24 * 3600,  # 7일
        expires=7 * 24 * 3600,
        samesite="lax",
        secure=False,  # 로컬 개발 환경 및 내부망 접속 대응용 (HTTPS 운영 시 True 변경 권장)
        path="/"
    )
    return {"message": "로그인 성공", "username": data.username}

@router.post("/auth/logout")
async def logout(response: Response):
    response.delete_cookie(
        key="session_token",
        path="/"
    )
    return {"message": "로그아웃 성공"}

@router.get("/auth/check")
async def check_auth(username: str = Depends(get_current_user)):
    return {"status": "authenticated", "username": username}

@router.post("/auth/change-credentials")
async def change_credentials(
    response: Response, 
    data: ChangeCredentialsRequest, 
    current_user: str = Depends(get_current_user)
):
    from services.db import get_user, update_user_credentials
    user = get_user(current_user)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="사용자를 찾을 수 없습니다."
        )
        
    current_password_hash = user["password_hash"]
    
    # 현재 비밀번호 검증
    if not verify_password(current_password_hash, data.current_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="현재 비밀번호가 일치하지 않습니다."
        )
        
    new_username = data.new_username.strip()
    new_password = data.new_password.strip()
    
    if not new_username:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="새 아이디를 입력해주세요."
        )
        
    if not new_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="새 비밀번호를 입력해주세요."
        )

    # 새 비밀번호가 현재 비밀번호와 동일한지 확인
    if verify_password(current_password_hash, new_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="새 비밀번호는 현재 비밀번호와 다르게 설정해야 합니다."
        )

        
    # 새로운 해시 생성 및 DB + .env 업데이트
    new_hash = hash_password(new_password)
    if not update_user_credentials(current_user, new_username, new_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="이미 존재하는 아이디입니다."
        )
    update_credentials_in_env(new_username, new_hash)
    
    # 세션 갱신
    new_token = create_session_token(new_username)
    response.set_cookie(
        key="session_token",
        value=new_token,
        httponly=True,
        max_age=7 * 24 * 3600,
        expires=7 * 24 * 3600,
        samesite="lax",
        secure=False,
        path="/"
    )
    
    return {"message": "아이디 및 비밀번호가 성공적으로 변경되었습니다.", "username": new_username}

class SystemSettingsRequest(BaseModel):
    ollama_host: str
    trans_provider: str
    trans_model: str
    chat_provider: str
    chat_model: str
    openai_api_key: str = ""
    gemini_api_key: str = ""
    claude_api_key: str = ""

@router.get("/settings/system")
async def get_system_settings(current_user: str = Depends(get_current_user)):
    health = await check_ollama_health()
    available_models = health.get("available_models", [])
    
    return {
        "ollama_host": get_ollama_host(),
        "available_models": available_models,
        "trans_provider": get_trans_provider(),
        "trans_model": get_trans_model(),
        "chat_provider": get_chat_provider(),
        "chat_model": get_chat_model(),
        "openai_api_key": get_openai_api_key(),
        "gemini_api_key": get_gemini_api_key(),
        "claude_api_key": get_claude_api_key()
    }

@router.post("/settings/system")
async def save_system_settings(data: SystemSettingsRequest, current_user: str = Depends(get_current_user)):
    trans_provider = data.trans_provider.strip().lower()
    chat_provider = data.chat_provider.strip().lower()
    
    if trans_provider not in ["ollama", "openai", "gemini", "claude", "antigravity"] or chat_provider not in ["ollama", "openai", "gemini", "claude", "antigravity"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="올바르지 않은 AI 제공업체입니다."
        )
        
    update_system_settings(
        ollama_host=data.ollama_host.strip(),
        trans_provider=trans_provider,
        trans_model=data.trans_model.strip(),
        chat_provider=chat_provider,
        chat_model=data.chat_model.strip(),
        openai_api_key=data.openai_api_key.strip(),
        gemini_api_key=data.gemini_api_key.strip(),
        claude_api_key=data.claude_api_key.strip()
    )
    return {"message": "시스템 설정이 성공적으로 변경되었습니다."}

@router.get("/settings/pull-model")
async def pull_model_stream(model_name: str, current_user: str = Depends(get_current_user)):
    """Ollama 서버에 새로운 모델 다운로드를 요청하고 진행 상황을 스트리밍합니다."""
    model_name = model_name.strip()
    if not model_name:
        raise HTTPException(status_code=400, detail="모델명을 입력해주세요.")
        
    async def event_stream():
        payload = {"name": model_name, "stream": True}
        try:
            # Ollama API에 스트리밍 요청 발송
            async with httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=10.0)) as client:
                async with client.stream(
                    "POST",
                    f"{get_ollama_host()}/api/pull",
                    json=payload
                ) as response:
                    if response.status_code != 200:
                        yield f"data: {json.dumps({'status': 'error', 'message': 'Ollama 서버 응답 에러'})}\n\n"
                        return
                        
                    async for line in response.aiter_lines():
                        if not line.strip():
                            continue
                        yield f"data: {line.strip()}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'status': 'error', 'message': str(e)})}\n\n"
            
    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        }
    )



