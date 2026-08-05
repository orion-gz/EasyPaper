from fastapi import APIRouter, Request, Response, HTTPException, status, Depends
from fastapi.responses import StreamingResponse
import json
import httpx
from pydantic import BaseModel
from services.auth import (
    verify_password,
    hash_password,
    create_session_token,
    get_current_user,
    get_login_lockout_remaining,
    record_failed_login,
    reset_login_attempts,
)
from config import (
    get_app_username,
    get_app_password_hash,
    update_credentials_in_env,
    get_ollama_host,
    is_ollama_host_local,
    update_system_settings,
    get_trans_provider,
    get_trans_model,
    get_chat_provider,
    get_chat_model,
    get_openai_api_key,
    get_gemini_api_key,
    get_claude_api_key,
    get_openalex_mailto,
    get_pdf_parser_engine,
    get_translation_prompt_template,
    update_translation_prompt_template,
    get_agy_path,
    get_claude_code_path,
    get_codex_path,
    find_ollama_binary,
    get_project_root,
    get_skip_login,
    set_skip_login,
)
from services.llm_client import check_ollama_health


async def _stream_subprocess_lines(proc):
    """서브프로세스의 stdout을 한 줄씩 비동기로 yield합니다 (설치 스크립트 진행 로그 스트리밍용).

    클라이언트가 SSE 연결을 중간에 끊으면(설치 진행 중 브라우저 탭을 닫는 등)
    FastAPI/Starlette가 이 async generator를 GeneratorExit로 강제 종료하는데,
    그 시점에 설치 서브프로세스가 아직 살아있으면 아무도 기다려주지 않는
    좀비/유령 프로세스로 남는다. finally에서 아직 살아있으면 항상 죽이고
    회수해, 취소된 설치가 반복될 때마다 프로세스가 계속 쌓이지 않게 한다.
    """
    try:
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip()
            if text:
                yield text
    finally:
        if proc.returncode is None:
            try:
                proc.kill()
            except Exception:
                pass
            try:
                await proc.wait()
            except Exception:
                pass

router = APIRouter()

class LoginRequest(BaseModel):
    username: str
    password: str
    remember: bool = False

class ChangeCredentialsRequest(BaseModel):
    current_password: str
    new_username: str
    new_password: str

@router.post("/auth/login")
async def login(request: Request, response: Response, data: LoginRequest):
    from services.auth import SESSION_TTL_DEFAULT_SECONDS, SESSION_TTL_REMEMBER_SECONDS
    from services.db import get_user

    lockout_remaining = get_login_lockout_remaining(request)
    if lockout_remaining > 0:
        retry_after = int(lockout_remaining) + 1
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"로그인 시도가 너무 많습니다. {retry_after}초 후 다시 시도해주세요.",
            headers={"Retry-After": str(retry_after)},
        )

    user = get_user(data.username)

    if not user or not verify_password(user["password_hash"], data.password):
        record_failed_login(request)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="아이디 또는 비밀번호가 올바르지 않습니다."
        )

    reset_login_attempts(request)

    # "로그인 상태 유지"를 체크하면 훨씬 긴 만료 기간의 세션 쿠키를 발급해,
    # 다음에 앱을 열 때 자동으로 로그인된 상태로 시작하게 한다(비밀번호를
    # 별도로 저장하지 않고, 기존의 안전한 HttpOnly 쿠키 메커니즘만 그대로 씀).
    ttl_seconds = SESSION_TTL_REMEMBER_SECONDS if data.remember else SESSION_TTL_DEFAULT_SECONDS
    token = create_session_token(data.username, ttl_seconds=ttl_seconds)

    # 보안 강화를 위해 HttpOnly, SameSite=Lax 적용 쿠키로 토큰 주입
    response.set_cookie(
        key="session_token",
        value=token,
        httponly=True,
        max_age=ttl_seconds,
        expires=ttl_seconds,
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


class SkipLoginRequest(BaseModel):
    enabled: bool


@router.get("/settings/skip-login")
async def get_skip_login_endpoint(current_user: str = Depends(get_current_user)):
    """로그인 화면을 건너뛰는 설정이 켜져 있는지 반환합니다."""
    return {"enabled": get_skip_login()}


@router.post("/settings/skip-login")
async def set_skip_login_endpoint(data: SkipLoginRequest, current_user: str = Depends(get_current_user)):
    """로그인 화면을 건너뛰고 항상 관리자로 자동 인증할지 여부를 저장합니다.

    이 서버에 네트워크로 접근 가능한 모든 사람이 인증 없이 전체 기능을 쓸
    수 있게 되므로, 반드시 이미 로그인된 상태(current_user 의존성)에서만
    바꿀 수 있게 한다.
    """
    set_skip_login(data.enabled)
    return {"enabled": data.enabled}


class SystemSettingsRequest(BaseModel):
    ollama_host: str
    trans_provider: str
    trans_model: str
    chat_provider: str
    chat_model: str
    openai_api_key: str = ""
    gemini_api_key: str = ""
    claude_api_key: str = ""
    openalex_mailto: str = ""
    translation_prompt_template: str = ""
    pdf_parser_engine: str = "pymupdf"

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
        "claude_api_key": get_claude_api_key(),
        "openalex_mailto": get_openalex_mailto(),
        "translation_prompt_template": get_translation_prompt_template(),
        "pdf_parser_engine": get_pdf_parser_engine()
    }

@router.post("/settings/system")
async def save_system_settings(data: SystemSettingsRequest, current_user: str = Depends(get_current_user)):
    trans_provider = data.trans_provider.strip().lower()
    chat_provider = data.chat_provider.strip().lower()
    pdf_parser_engine = data.pdf_parser_engine.strip().lower() if data.pdf_parser_engine else "pymupdf"
    
    valid_providers = ["ollama", "openai", "gemini", "claude", "antigravity", "claude_code", "codex"]
    if trans_provider not in valid_providers or chat_provider not in valid_providers:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="올바르지 않은 AI 제공업체입니다."
        )
        
    valid_parsers = ["pymupdf", "pdfplumber", "marker", "mineru"]
    if pdf_parser_engine not in valid_parsers:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="올바르지 않은 PDF 파서 엔진입니다."
        )

    update_system_settings(
        ollama_host=data.ollama_host.strip(),
        trans_provider=trans_provider,
        trans_model=data.trans_model.strip(),
        chat_provider=chat_provider,
        chat_model=data.chat_model.strip(),
        openai_api_key=data.openai_api_key.strip(),
        gemini_api_key=data.gemini_api_key.strip(),
        claude_api_key=data.claude_api_key.strip(),
        openalex_mailto=data.openalex_mailto.strip(),
        pdf_parser_engine=pdf_parser_engine
    )
    
    # 고급 설정: 번역 프롬프트 템플릿 저장
    update_translation_prompt_template(data.translation_prompt_template)
    
    return {"message": "시스템 설정이 성공적으로 변경되었습니다."}


def _is_package_installed(module_name: str) -> bool:
    import importlib.util
    try:
        return importlib.util.find_spec(module_name) is not None
    except Exception:
        return False


@router.get("/settings/pdf-parsers")
async def get_pdf_parsers_info(current_user: str = Depends(get_current_user)):
    current_engine = get_pdf_parser_engine()
    parsers = [
        {
            "id": "pymupdf",
            "name": "PyMuPDF (fitz)",
            "description": "기본 파서 - 초고속, 경량 (텍스트 중심 논문 추천)",
            "pros": "초고속 (몇 ms), 별도 설치 필요 없음",
            "cons": "2단 복잡 구조, 수식 텍스트 엉킴 발생 가능",
            "size_info": "기본 설치됨 (0 MB)",
            "installed": True,
            "install_package": None
        },
        {
            "id": "pdfplumber",
            "name": "pdfplumber",
            "description": "표(Table) 정밀 분석 및 위치 레이아웃 보존 파서",
            "pros": "표 구조 및 그래픽 좌표 추적 우수",
            "cons": "PyMuPDF보다 약간 느림",
            "size_info": "약 15 MB",
            "installed": _is_package_installed("pdfplumber"),
            "install_package": "pdfplumber"
        },
        {
            "id": "marker",
            "name": "Marker (AI Markdown)",
            "description": "AI 딥러닝 논문 파서 (LaTeX 수식, 표, 2단 레이아웃 지원)",
            "pros": "수식을 LaTeX 변환, 정교한 오버레이 크롭",
            "cons": "PyTorch/Vision 포함 (대용량), 처리 속도 느림",
            "size_info": "약 2.5 GB (PyTorch & Vision 모델 포함)",
            "installed": _is_package_installed("marker"),
            "install_package": "marker-pdf"
        },
        {
            "id": "mineru",
            "name": "MinerU (Magic-PDF)",
            "description": "대규모 학술 서적 및 논문 레이아웃 분석 AI 파서",
            "pros": "YOLOv8 기반 레이아웃 핀포인트 세그멘테이션",
            "cons": "대용량 패키지, 높은 CPU/GPU 및 메모리 소모",
            "size_info": "약 3.0 GB (YOLO & Layout/Formula 모델 포함)",
            "installed": _is_package_installed("magic_pdf"),
            "install_package": "magic-pdf"
        }
    ]
    return {
        "current_engine": current_engine,
        "parsers": parsers
    }


@router.get("/settings/install-pdf-parser")
async def install_pdf_parser_stream(parser_id: str):
    import sys
    import asyncio

    package_map = {
        "pdfplumber": "pdfplumber",
        "marker": "marker-pdf",
        "mineru": "magic-pdf"
    }

    pkg_name = package_map.get(parser_id)
    if not pkg_name:
        raise HTTPException(status_code=400, detail="지원되지 않는 파서 엔진입니다.")

    async def event_stream():
        python_bin = sys.executable
        yield f"data: {json.dumps({'status': 'progress', 'line': f'백엔드 가상환경({python_bin})에 {pkg_name} 설치를 시작합니다...'})}\n\n"
        try:
            cmd = [python_bin, "-u", "-m", "pip", "install", pkg_name]
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                stdin=asyncio.subprocess.DEVNULL
            )
            async for text in _stream_subprocess_lines(proc):
                yield f"data: {json.dumps({'status': 'progress', 'line': text})}\n\n"
            await proc.wait()
            if proc.returncode == 0:
                yield f"data: {json.dumps({'status': 'success', 'message': f'{pkg_name} 설치가 정상적으로 완료되었습니다.'})}\n\n"
            else:
                yield f"data: {json.dumps({'status': 'error', 'message': f'설치가 오류 코드 {proc.returncode}로 종료되었습니다.'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'status': 'error', 'message': f'설치 실행 중 오류가 발생했습니다: {str(e)}'})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        }
    )

@router.post("/settings/uninstall-pdf-parser")
async def uninstall_pdf_parser(request: Request):
    import sys, subprocess
    import config as cfg

    body = await request.json()
    parser_id = body.get("parser_id", "")

    package_map = {
        "pdfplumber": "pdfplumber",
        "marker": "marker-pdf",
        "mineru": "magic-pdf"
    }

    pkg_name = package_map.get(parser_id)
    if not pkg_name:
        raise HTTPException(status_code=400, detail="지원되지 않는 파서 엔진입니다.")

    python_bin = sys.executable
    result = subprocess.run(
        [python_bin, "-m", "pip", "uninstall", "-y", pkg_name],
        capture_output=True, text=True
    )

    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=f"삭제 실패: {result.stderr.strip() or result.stdout.strip()}")

    # 삭제한 파서가 현재 엔진이면 pymupdf로 복귀
    from config import update_system_settings
    if cfg.PDF_PARSER_ENGINE == parser_id:
        update_system_settings(
            ollama_host=cfg.OLLAMA_HOST,
            trans_provider=cfg.TRANS_PROVIDER,
            trans_model=cfg.TRANS_MODEL,
            chat_provider=cfg.CHAT_PROVIDER,
            chat_model=cfg.CHAT_MODEL,
            openai_api_key=cfg.OPENAI_API_KEY,
            gemini_api_key=cfg.GEMINI_API_KEY,
            claude_api_key=cfg.CLAUDE_API_KEY,
            openalex_mailto=cfg.OPENALEX_MAILTO,
            pdf_parser_engine="pymupdf"
        )

    return {"status": "success", "message": f"{pkg_name} 패키지가 삭제되었습니다."}



@router.post("/settings/clear-pages-cache")
async def clear_pages_cache(current_user: str = Depends(get_current_user)):
    """모든 문서의 PDF 텍스트/이미지 추출 결과 디스크 캐시(extract_pages(),
    extract_pdf_images() 결과)를 삭제합니다. 이 캐시는 서버/앱 재시작 후
    문서를 다시 열 때 PDF를 매번 재파싱하지 않도록 저장해두는 것으로,
    지워도 다음 열람 시 자동으로 다시 채워지므로 데이터 손실은 없습니다."""
    from services.cache import clear_all_pages_cache, clear_all_images_cache
    pages_count, pages_bytes = clear_all_pages_cache()
    images_count, images_bytes = clear_all_images_cache()
    return {
        "cleared_files": pages_count + images_count,
        "freed_bytes": pages_bytes + images_bytes,
    }


@router.get("/settings/ollama-status")
async def ollama_status(current_user: str = Depends(get_current_user)):
    """Ollama CLI가 이 서버에 설치되어 있는지, 설정된 호스트가 로컬인지 확인합니다."""
    installed = bool(find_ollama_binary())
    return {
        "installed": installed,
        "is_local": is_ollama_host_local(),
    }


@router.get("/settings/install-ollama")
async def install_ollama_stream(current_user: str = Depends(get_current_user)):
    """이 서버의 운영체제에 맞는 방법으로 Ollama를 설치하고 진행 상황을 스트리밍합니다.
    Linux는 공식 설치 스크립트, macOS는 Homebrew(있는 경우), Windows는 공식 설치
    프로그램을 내려받아 무인 설치합니다. 원격 호스트를 가리키고 있거나 이미 설치된
    경우에는 실행하지 않습니다."""
    import asyncio
    import os
    import platform
    import shutil
    import tempfile

    system = platform.system()  # 'Linux' | 'Darwin' | 'Windows'

    async def event_stream():
        if not is_ollama_host_local():
            yield f"data: {json.dumps({'status': 'error', 'message': 'Ollama 호스트가 이 서버(localhost)가 아니어서 여기서 설치할 수 없습니다.'})}\n\n"
            return
        if find_ollama_binary():
            yield f"data: {json.dumps({'status': 'error', 'message': 'Ollama가 이미 설치되어 있습니다.'})}\n\n"
            return

        try:
            if system == "Linux":
                proc = await asyncio.create_subprocess_shell(
                    "curl -fsSL https://ollama.com/install.sh | sh",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    # sudo가 비밀번호를 요구하면 무한 대기하지 않고 즉시 실패하도록 stdin을 막는다
                    stdin=asyncio.subprocess.DEVNULL,
                )
                async for text in _stream_subprocess_lines(proc):
                    yield f"data: {json.dumps({'status': 'progress', 'line': text})}\n\n"
                await proc.wait()
                if proc.returncode == 0 and find_ollama_binary():
                    yield f"data: {json.dumps({'status': 'success'})}\n\n"
                else:
                    yield f"data: {json.dumps({'status': 'error', 'message': f'설치 스크립트가 오류 코드 {proc.returncode}로 종료되었습니다. sudo 권한이 필요할 수 있습니다.'})}\n\n"

            elif system == "Darwin":
                if not shutil.which("brew"):
                    yield f"data: {json.dumps({'status': 'error', 'message': 'Homebrew가 설치되어 있지 않아 이 서버에서 자동 설치할 수 없습니다. https://ollama.com/download/mac 에서 직접 다운로드해 설치해주세요.'})}\n\n"
                    return
                yield f"data: {json.dumps({'status': 'progress', 'line': 'Homebrew로 Ollama를 설치합니다 (brew install ollama)...'})}\n\n"
                proc = await asyncio.create_subprocess_shell(
                    "brew install ollama",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    stdin=asyncio.subprocess.DEVNULL,
                )
                async for text in _stream_subprocess_lines(proc):
                    yield f"data: {json.dumps({'status': 'progress', 'line': text})}\n\n"
                await proc.wait()
                if proc.returncode == 0 and find_ollama_binary():
                    yield f"data: {json.dumps({'status': 'success'})}\n\n"
                else:
                    yield f"data: {json.dumps({'status': 'error', 'message': f'brew install이 오류 코드 {proc.returncode}로 종료되었습니다.'})}\n\n"

            elif system == "Windows":
                yield f"data: {json.dumps({'status': 'progress', 'line': 'Ollama 설치 프로그램을 다운로드합니다...'})}\n\n"
                installer_path = os.path.join(tempfile.gettempdir(), "OllamaSetup.exe")
                try:
                    async with httpx.AsyncClient(timeout=180.0, follow_redirects=True) as client:
                        async with client.stream("GET", "https://ollama.com/download/OllamaSetup.exe") as resp:
                            resp.raise_for_status()
                            with open(installer_path, "wb") as f:
                                async for chunk in resp.aiter_bytes():
                                    f.write(chunk)
                except Exception as e:
                    yield f"data: {json.dumps({'status': 'error', 'message': f'설치 프로그램 다운로드 실패: {e}. https://ollama.com/download/windows 에서 직접 다운로드해주세요.'})}\n\n"
                    return

                yield f"data: {json.dumps({'status': 'progress', 'line': '다운로드 완료. 자동으로 설치를 진행합니다...'})}\n\n"
                proc = await asyncio.create_subprocess_exec(
                    installer_path, "/VERYSILENT", "/NORESTART",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    stdin=asyncio.subprocess.DEVNULL,
                )
                async for text in _stream_subprocess_lines(proc):
                    yield f"data: {json.dumps({'status': 'progress', 'line': text})}\n\n"
                await proc.wait()
                if proc.returncode == 0 and find_ollama_binary():
                    yield f"data: {json.dumps({'status': 'success'})}\n\n"
                else:
                    yield f"data: {json.dumps({'status': 'error', 'message': f'설치 프로그램이 종료 코드 {proc.returncode}로 끝났습니다. https://ollama.com/download/windows 에서 직접 설치해주세요.'})}\n\n"
            else:
                yield f"data: {json.dumps({'status': 'error', 'message': f'지원하지 않는 운영체제({system})입니다. https://ollama.com/download 에서 직접 설치해주세요.'})}\n\n"
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


def _make_native_cli_install_endpoint(
    unix_install_url: str,
    windows_install_url: str,
    path_getter,
    already_installed_message: str,
):
    """claude_code/codex 공식 curl(Unix)/PowerShell(Windows) 네이티브 설치
    스크립트로 CLI를 설치하는 SSE 스트림을 만듭니다.

    예전에는 `npm install -g <package>`를 썼는데, macOS 공식 Node.js
    설치본은 npm 전역 prefix(/usr/local/lib/node_modules)가 root 소유라
    sudo 없이 실행하면 EACCES(permission denied)로 실패했다(실제로
    재현됨). 두 CLI 모두 Node.js가 전혀 필요 없는 공식 네이티브 바이너리
    설치 스크립트를 제공하므로(Antigravity와 동일한 배포 방식), npm을
    아예 거치지 않는 이 방식으로 바꿔 문제를 원천적으로 피한다. 각
    설치 스크립트가 자체적으로 셸 rc 파일(.zprofile/.bashrc 등)이나
    Windows 사용자 PATH에 설치 위치를 등록한다.
    """
    async def stream(current_user: str = Depends(get_current_user)):
        import asyncio
        import os
        import platform
        import shutil

        system = platform.system()  # 'Linux' | 'Darwin' | 'Windows'

        async def event_stream():
            cli_path = path_getter()
            if os.path.exists(cli_path) or shutil.which(cli_path):
                yield f"data: {json.dumps({'status': 'error', 'message': already_installed_message})}\n\n"
                return

            try:
                if system == "Windows":
                    # PowerShell 명령을 별도 argv 원소로 넘겨 create_subprocess_exec로
                    # 실행한다 - 셸 문자열 하나로 조립해 create_subprocess_shell에
                    # 넘기면 Windows에서 cmd /c "..."로 한 번 더 감싸이면서 명령 안의
                    # 큰따옴표와 중첩되어 명령 경계가 깨지는 문제(Antigravity Windows
                    # 설치에서 이미 겪은 것과 같은 부류)를 새로 만들 위험이 있다.
                    proc = await asyncio.create_subprocess_exec(
                        "powershell", "-NoProfile", "-ExecutionPolicy", "ByPass", "-Command",
                        f"irm {windows_install_url} | iex",
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.STDOUT,
                        stdin=asyncio.subprocess.DEVNULL,
                    )
                else:
                    proc = await asyncio.create_subprocess_shell(
                        f"curl -fsSL {unix_install_url} | bash",
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.STDOUT,
                        stdin=asyncio.subprocess.DEVNULL,
                    )
                async for text in _stream_subprocess_lines(proc):
                    yield f"data: {json.dumps({'status': 'progress', 'line': text})}\n\n"
                await proc.wait()

                installed = os.path.exists(path_getter()) or shutil.which(path_getter())
                if proc.returncode == 0 and installed:
                    yield f"data: {json.dumps({'status': 'success'})}\n\n"
                else:
                    yield f"data: {json.dumps({'status': 'error', 'message': f'설치가 오류 코드 {proc.returncode}로 종료되었습니다.'})}\n\n"
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

    return stream


router.add_api_route(
    "/settings/install-claude-code",
    _make_native_cli_install_endpoint(
        "https://claude.ai/install.sh",
        "https://claude.ai/install.ps1",
        get_claude_code_path,
        "Claude Code CLI가 이미 설치되어 있습니다.",
    ),
    methods=["GET"],
)

router.add_api_route(
    "/settings/install-codex",
    _make_native_cli_install_endpoint(
        "https://chatgpt.com/codex/install.sh",
        "https://chatgpt.com/codex/install.ps1",
        get_codex_path,
        "Codex CLI가 이미 설치되어 있습니다.",
    ),
    methods=["GET"],
)


@router.get("/settings/install-antigravity")
async def install_antigravity_stream(current_user: str = Depends(get_current_user)):
    """공식 설치 스크립트(https://antigravity.google/cli)로 이 서버에 Antigravity CLI(agy)를
    설치하고 진행 상황을 스트리밍합니다."""
    import asyncio
    import os
    import platform
    import shutil

    system = platform.system()  # 'Linux' | 'Darwin' | 'Windows'

    async def event_stream():
        agy_path = get_agy_path()
        if os.path.exists(agy_path) or shutil.which(agy_path) or shutil.which("agy"):
            yield f"data: {json.dumps({'status': 'error', 'message': 'Antigravity CLI가 이미 설치되어 있습니다.'})}\n\n"
            return

        try:
            if system == "Windows":
                # install.cmd 자체에 "명령줄 인자에 &, |, ; 등 위험한 셸 문자가
                # 있으면 거부"하는 자체 보안 검증이 있다. 예전에는 `curl -o ... &&
                # call ... && del ...`를 하나의 문자열로 만들어
                # create_subprocess_shell에 넘겼는데, Python이 shell=True일 때
                # 이 문자열 전체를 다시 `cmd /c "..."`로 한 번 더 감싸면서 이미
                # 문자열 안에 있던 큰따옴표들과 중첩되어 cmd.exe가 명령 경계를
                # 잘못 해석했다. 그 결과 "&&" 뒤의 내용 일부가 install.cmd
                # 자신에게 인자로 새어 들어가 그 자체 검증에 걸려
                # "Fatal: Illegal shell characters detected in command line
                # arguments"로 실패했다(위 Ollama Windows 설치와 동일하게 셸
                # 문자열 조립 없이 httpx로 직접 받고 create_subprocess_exec로
                # 실행하면 이 문제가 원천적으로 생기지 않는다).
                import tempfile
                from config import windows_safe_exec_args

                yield f"data: {json.dumps({'status': 'progress', 'line': 'Antigravity 설치 스크립트를 다운로드합니다...'})}\n\n"
                installer_path = os.path.join(tempfile.gettempdir(), "antigravity_install.cmd")
                try:
                    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
                        async with client.stream("GET", "https://antigravity.google/cli/install.cmd") as resp:
                            resp.raise_for_status()
                            with open(installer_path, "wb") as f:
                                async for chunk in resp.aiter_bytes():
                                    f.write(chunk)
                except Exception as e:
                    yield f"data: {json.dumps({'status': 'error', 'message': f'설치 스크립트 다운로드 실패: {e}'})}\n\n"
                    return

                yield f"data: {json.dumps({'status': 'progress', 'line': '다운로드 완료. 설치를 진행합니다...'})}\n\n"
                proc = await asyncio.create_subprocess_exec(
                    *windows_safe_exec_args([installer_path]),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    stdin=asyncio.subprocess.DEVNULL,
                )
                async for text in _stream_subprocess_lines(proc):
                    yield f"data: {json.dumps({'status': 'progress', 'line': text})}\n\n"
                await proc.wait()
                try:
                    os.remove(installer_path)
                except OSError:
                    pass
            else:
                # macOS와 Linux는 동일한 공식 셸 스크립트를 사용한다.
                proc = await asyncio.create_subprocess_shell(
                    "curl -fsSL https://antigravity.google/cli/install.sh | bash",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    stdin=asyncio.subprocess.DEVNULL,
                )
                async for text in _stream_subprocess_lines(proc):
                    yield f"data: {json.dumps({'status': 'progress', 'line': text})}\n\n"
                await proc.wait()

            agy_path_after = get_agy_path()
            installed = os.path.exists(agy_path_after) or shutil.which(agy_path_after) or shutil.which("agy")
            if proc.returncode == 0 and installed:
                yield f"data: {json.dumps({'status': 'success'})}\n\n"
            else:
                yield f"data: {json.dumps({'status': 'error', 'message': f'설치 스크립트가 오류 코드 {proc.returncode}로 종료되었습니다.'})}\n\n"
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


class DeleteModelRequest(BaseModel):
    model_name: str


@router.delete("/settings/delete-model")
async def delete_model(data: DeleteModelRequest, current_user: str = Depends(get_current_user)):
    """Ollama 서버에서 설치된 모델을 삭제합니다."""
    model_name = data.model_name.strip()
    if not model_name:
        raise HTTPException(status_code=400, detail="모델명을 입력해주세요.")
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.request(
                "DELETE",
                f"{get_ollama_host()}/api/delete",
                json={"name": model_name}
            )
            if resp.status_code != 200:
                detail = resp.text
                try:
                    err_json = resp.json()
                    if "error" in err_json:
                        detail = err_json["error"]
                except Exception:
                    pass
                raise HTTPException(status_code=resp.status_code, detail=f"Ollama 모델 삭제 실패: {detail}")
            return {"status": "success", "message": f"모델 '{model_name}'이(가) 삭제되었습니다."}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ollama 모델 삭제 중 오류 발생: {str(e)}")



def _is_running_under_systemd() -> bool:
    """이 프로세스가 systemd 유닛으로 실행 중인지 확인합니다.

    systemd는 v232부터 자신이 띄운 모든 프로세스에 유닛 실행마다 고유한
    INVOCATION_ID 환경변수를 심어준다 - 이 프로젝트의 easypaper.service도
    ExecStart로 직접 python main.py를 실행하므로 이 값이 신뢰할 수 있는
    판별 근거가 된다.
    """
    import os
    return bool(os.environ.get("INVOCATION_ID"))


async def _restart_server_process(project_dir: str):
    """서버를 재시작합니다. Linux에서 systemd로 실행 중이면 systemctl로, 그 외의
    모든 경우(Windows/macOS, 또는 scripts/sh/start.sh·scripts\\bat\\start.bat로
    터미널에서 직접 실행한 Linux)에는 스스로 새 프로세스를 미리 띄워두고
    자신은 종료하는 방식으로 재시작합니다.

    예전에는 `sudo systemctl restart easypaper`만 무조건 실행했는데, 이는
    Linux + systemd 조합에서만 동작하는 명령이다. Windows에는 systemctl/sudo
    자체가 없고, macOS는 systemd가 없어 커맨드 자체가 즉시 실패한다. 게다가
    이 호출은 "쏘고 잊는"(fire-and-forget) 백그라운드 태스크라 실패해도
    사용자에게는 "업데이트 성공"이라고 응답이 나간 뒤라 아무도 알아채지
    못하고, 실제로는 서버가 예전 코드로 계속 돌아가는 상태로 남았다.
    """
    import asyncio
    import os
    import platform
    import shutil
    import subprocess
    import sys

    await asyncio.sleep(1.0)

    if platform.system() == "Linux" and _is_running_under_systemd() and shutil.which("systemctl"):
        try:
            proc = await asyncio.create_subprocess_exec(
                "sudo", "systemctl", "restart", "easypaper",
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            await proc.communicate()
            return
        except Exception as e:
            print(f"[system_update] systemctl restart 실패, 자체 재시작으로 대체: {e}", flush=True)

    # systemd가 아닌 환경 - 같은 명령으로 새 프로세스를 미리(포트가 풀릴 시간을
    # 두고) 띄워둔 뒤 현재 프로세스를 종료해 사실상 스스로를 재시작한다.
    backend_dir = os.path.join(project_dir, "backend")
    python_exe = sys.executable
    delay_launch_script = (
        "import subprocess, sys, time\n"
        "time.sleep(3)\n"
        f"subprocess.Popen([{python_exe!r}, 'main.py'], cwd={backend_dir!r})\n"
    )

    popen_kwargs = {"cwd": backend_dir}
    if platform.system() == "Windows":
        popen_kwargs["creationflags"] = (
            subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        )
    else:
        popen_kwargs["start_new_session"] = True

    try:
        subprocess.Popen([python_exe, "-c", delay_launch_script], **popen_kwargs)
    except Exception as e:
        print(f"[system_update] 자체 재시작 프로세스 실행 실패: {e}", flush=True)
        return

    await asyncio.sleep(0.3)
    # 새 프로세스가 이미 대기 중이므로, 현재 프로세스는 정리 절차 없이 즉시
    # 종료해 리스닝 중인 포트를 최대한 빨리 비워준다.
    os._exit(0)


@router.post("/settings/update")
async def system_update(current_user: str = Depends(get_current_user)):
    """깃허브 최신 커밋을 풀(pull) 받고, 프론트엔드를 빌드한 뒤 서버를 재기동합니다."""
    import subprocess
    import asyncio
    import os

    try:
        # 프로젝트 루트 디렉토리 찾기. os.path.dirname(__file__)로 직접 계산하면
        # 이 파일(routers/auth.py)이 backend/ 밑 한 단계 더 깊은 routers/ 안에
        # 있다는 걸 놓치기 쉬워, 실제로 project_dir이 backend/를 가리키게 되는
        # 버그가 있었다(그 결과 frontend_dir이 backend/frontend로 계산되어
        # 존재하지 않으니 프론트엔드 빌드가 조용히 스킵되고, _restart_server_process
        # 에서도 backend_dir이 backend/backend로 계산되어 재시작이
        # "No such file or directory"로 실패했다). config.py의 검증된
        # get_project_root()를 그대로 재사용해 이런 계산 실수를 원천 차단한다.
        project_dir = get_project_root()

        # 1. git pull origin main
        pull_proc = await asyncio.create_subprocess_exec(
            "git", "pull", "origin", "main",
            cwd=project_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        stdout, stderr = await pull_proc.communicate()
        if pull_proc.returncode != 0:
            return {
                "ok": False,
                "message": f"Git pull 실패: {stderr.decode('utf-8', errors='replace')}"
            }
        
        pull_output = stdout.decode('utf-8', errors='replace')
        
        # 2. 만약 pull 된 내용이 있으면 (또는 무조건 안전하게) 프론트엔드를 빌드합니다.
        if "Already up-to-date" not in pull_output and "Already up to date" not in pull_output:
            frontend_dir = os.path.join(project_dir, "frontend")
            if os.path.exists(frontend_dir):
                # npm install && npm run build
                from config import windows_safe_exec_args
                build_proc = await asyncio.create_subprocess_exec(
                    *windows_safe_exec_args(["npm", "run", "build"]),
                    cwd=frontend_dir,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE
                )
                build_stdout, build_stderr = await build_proc.communicate()
                if build_proc.returncode != 0:
                    return {
                        "ok": False,
                        "message": f"프론트엔드 빌드 실패: {build_stderr.decode('utf-8', errors='replace')}"
                    }
        
        # 3. 비동기로 1초 후에 서버 재시작 (OS/실행 방식에 맞춰 자동 판단)
        asyncio.create_task(_restart_server_process(project_dir))
        
        return {
            "ok": True,
            "message": "업데이트가 성공적으로 적용되었습니다. 서버가 1초 후에 재시작됩니다.",
            "output": pull_output
        }
        
    except Exception as e:
        return {
            "ok": False,
            "message": f"업데이트 중 알 수 없는 오류 발생: {str(e)}"
        }


class UpdateCheckConfigRequest(BaseModel):
    interval: str


@router.get("/settings/update-check-config")
async def get_update_check_config_endpoint(current_user: str = Depends(get_current_user)):
    """자동 업데이트 확인 주기 설정과 마지막 확인 시각을 반환합니다."""
    from services.update_checker import get_update_check_config
    return get_update_check_config()


@router.post("/settings/update-check-config")
async def set_update_check_config_endpoint(
    data: UpdateCheckConfigRequest,
    current_user: str = Depends(get_current_user)
):
    """자동 업데이트 확인 주기를 저장합니다 (daily/weekly/never)."""
    from services.update_checker import set_update_check_interval
    try:
        return set_update_check_interval(data.interval)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/settings/update-check")
async def check_for_update_endpoint(current_user: str = Depends(get_current_user)):
    """원격 저장소를 확인해 새 버전이 있는지, 있다면 변경 로그를 반환합니다."""
    from services.update_checker import check_for_update
    return await check_for_update()


@router.get("/settings/post-update-notice")
async def post_update_notice_endpoint(current_user: str = Depends(get_current_user)):
    """직전 재시작으로 버전이 바뀌었다면(방금 업데이트 완료) 1회에 한해 안내 정보를 반환합니다."""
    from services.update_checker import get_post_update_notice
    return await get_post_update_notice()


@router.get("/settings/changelog")
async def get_full_changelog(current_user: str = Depends(get_current_user)):
    """저장소 루트의 CHANGELOG.md 전체 내용을 반환합니다.

    설정 화면에서 버전 텍스트를 클릭하면 지금까지의 전체 변경 이력을 보여주는
    용도 - 업데이트 확인 시 뜨는 changelog(현재~최신 사이의 diff)와 달리
    이건 프로젝트 전체 누적 이력이라 git 조회가 아니라 이 파일 자체를
    그대로 서빙한다.
    """
    import os
    changelog_path = os.path.join(get_project_root(), "CHANGELOG.md")
    if not os.path.exists(changelog_path):
        return {"content": ""}
    with open(changelog_path, "r", encoding="utf-8") as f:
        return {"content": f.read()}


