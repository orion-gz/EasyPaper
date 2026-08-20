import uuid
import os
import shutil
import asyncio
from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from fastapi.responses import JSONResponse
import aiofiles
from services.auth import get_current_user

from config import UPLOAD_DIR, MAX_FILE_SIZE_MB
from services.pdf_parser import extract_pages, get_pdf_metadata
from services.library import save_document, get_document, get_pdf_path as lib_pdf_path, list_documents
from services.translation_job import start_job, resume_incomplete_jobs, get_job_status
from services.insight_job import start_keyword_job, start_summary_job
from services.primer import generate_primer
from services.rate_limiter import enforce_rate_limit
from models.schemas import UploadResponse

router = APIRouter()

# 메모리 내 세션 저장소
sessions: dict = {}


def ensure_session(session_id: str) -> bool:
    """세션이 메모리에 존재하는지 확인하고, 없다면 DB에서 조회하여 복구합니다."""
    if session_id in sessions:
        return True
    
    from services.db import db_get_document
    doc = db_get_document(session_id)
    if not doc:
        return False
        
    pdf_path = doc["pdf_path"]
    if not os.path.exists(pdf_path):
        pdf_path = lib_pdf_path(session_id)
        if not pdf_path or not os.path.exists(pdf_path):
            return False
            
    try:
        from services.cache import get_cached_pages, save_pages_cache
        pages = get_cached_pages(session_id, pdf_path)
        if pages is None:
            pages = extract_pages(pdf_path)
            save_pages_cache(session_id, pdf_path, pages)
        sessions[session_id] = {
            "pdf_path": pdf_path,
            "filename": doc["filename"],
            "pages": pages,
            "total_pages": doc["total_pages"],
            "metadata": doc.get("metadata", {}),
            "from_library": True,
            "username": doc.get("username", "admin"),
            "document_mode": doc.get("document_mode", "research"),
            "document_type": doc.get("document_type", "research_paper"),
        }
        return True
    except Exception:
        return False


def require_session_owner(session_id: str, current_user: str) -> dict:
    """세션이 존재하고 현재 로그인한 사용자 소유인지 확인합니다.

    library.py의 _require_owned_document와 동일한 이유로, 다른 사용자의
    세션은 존재 여부조차 알려주지 않도록(403이 아니라) 존재하지 않는
    경우와 동일하게 404로 응답한다. jobs.py/main.py의 세션 기반
    엔드포인트에서도 재사용한다.
    """
    if not ensure_session(session_id):
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다.")
    session = sessions[session_id]
    if session.get("username") != current_user:
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다.")
    return session


def restore_sessions_from_library():
    """서버 시작 시 미완료 번역 잡이 있는 문서만 세션으로 복원하고 잡을 재개합니다.

    예전에는 라이브러리의 모든 문서를 매번 세션으로 복원했다(각 PDF를
    처음부터 다시 extract_pages()로 텍스트 추출). 이러면 서버 기동 시간이
    문서 수에 비례해 늘어나는데, Tauri 데스크톱 앱은 앱을 켤 때마다
    백엔드 프로세스가 재시작되므로 이 지연을 매번 겪게 되고, 배포 서버도
    문서가 쌓일수록 CI 헬스체크(재시작 후 30초 이내 응답) 타임아웃을
    넘기기 시작했다.

    부팅 시점에 실제로 필요한 건 "재개해야 할 미완료 번역 잡이 있는
    문서"뿐이다 - 그 외 문서는 ensure_session()이 실제로 열람되는 시점에
    그때 한 번만 추출해 캐싱하므로(require_session_owner 경유) 미리
    준비해둘 필요가 없다. job_status.json 존재 여부만 확인하는 건 PDF를
    열지 않는 가벼운 파일 I/O라 문서 수가 많아도 부담이 없다.
    """
    for doc in list_documents():
        doc_id = doc["id"]
        job = get_job_status(doc_id)
        if job and job.get("status") == "running":
            ensure_session(doc_id)

    # 미완료 번역 잡 재개 (위에서 세션이 복원된 문서만 대상)
    resume_incomplete_jobs(sessions)


@router.post("/upload", response_model=UploadResponse)
async def upload_pdf(
    file: UploadFile = File(...),
    target_lang: str = "한국어",
    style: str = "academic",
    ignore_math: bool = False,
    ignore_table: bool = True,
    ignore_refs: bool = False,
    translation_mode: str = "auto",
    keyword_mode: str = "manual",
    summary_mode: str = "manual",
    document_mode: str = "research",
    document_type: str = "research_paper",
    current_user: str = Depends(get_current_user)
):
    """PDF 파일을 업로드하고 텍스트를 추출합니다."""
    enforce_rate_limit("upload", current_user)

    from services.document_policy import validate_classification
    try:
        validate_classification(document_mode, document_type)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # 파일 검증
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="PDF 파일만 업로드 가능합니다.")

    # 세션 ID 생성
    session_id = str(uuid.uuid4())
    session_dir = os.path.join(UPLOAD_DIR, session_id)
    os.makedirs(session_dir, exist_ok=True)
    pdf_path = os.path.join(session_dir, "document.pdf")

    # 파일 저장 (스트리밍) - await file.read()로 전체를 한 번에 읽으면 크기
    # 제한 검사가 이미 전체 파일을 메모리에 다 올린 "다음"에야 이루어져,
    # MAX_FILE_SIZE_MB를 아무리 작게 잡아도 공격자가 매우 큰 파일을 계속
    # 올려 메모리를 고갈시키는 DoS 벡터가 된다. 청크 단위로 읽어 디스크에
    # 바로 쓰면서, 누적 크기가 한도를 넘는 순간 더 읽지 않고 즉시 중단한다.
    CHUNK_SIZE = 1024 * 1024  # 1MB
    max_bytes = MAX_FILE_SIZE_MB * 1024 * 1024
    total_bytes = 0
    try:
        async with aiofiles.open(pdf_path, "wb") as f:
            while True:
                chunk = await file.read(CHUNK_SIZE)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if total_bytes > max_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"파일 크기가 {MAX_FILE_SIZE_MB}MB를 초과합니다."
                    )
                await f.write(chunk)
    except HTTPException:
        shutil.rmtree(session_dir, ignore_errors=True)
        raise

    file_size_mb = total_bytes / (1024 * 1024)

    # PDF 파싱
    try:
        metadata = get_pdf_metadata(pdf_path)
        pages = extract_pages(pdf_path)
    except Exception as e:
        shutil.rmtree(session_dir, ignore_errors=True)
        raise HTTPException(status_code=422, detail=f"PDF 파싱 실패: {str(e)}")

    # 라이브러리에 영구 저장
    save_document(
        session_id, file.filename, pdf_path, len(pages), metadata,
        username=current_user, document_mode=document_mode, document_type=document_type,
    )

    # 세션 저장 (메모리)
    sessions[session_id] = {
        "pdf_path": pdf_path,
        "filename": file.filename,
        "pages": pages,
        "total_pages": len(pages),
        "metadata": metadata,
        "from_library": False,
        "username": current_user,
        "document_mode": document_mode,
        "document_type": document_type,
    }

    # translation_mode가 "auto"(기본값)가 아니면 - 번역 창을 펼칠 때(pane) 또는
    # 스크롤로 페이지를 볼 때(scroll)만 번역하길 원하는 사용자이므로 - 업로드
    # 직후 전체 문서를 자동으로 번역하는 백그라운드 잡을 시작하지 않는다. 이후
    # 번역은 프런트엔드가 상황에 맞춰 /jobs/{id}/restart(pane) 또는
    # /translate/{id}/{page}(scroll) 를 호출해 트리거한다.
    #
    # auto 번역 잡은 선택 기능인 읽기 전 브리핑에 의존하지 않도록
    # 업로드 응답 전에 즉시 등록한다. 이렇게 해야 primer LLM이 느리거나
    # 멈춰도 job status가 404로 남지 않고 번역이 진행된다. 문서당 세션을
    # 재사용하는 CLI provider의 실제 LLM 호출은 llm_client의 세션 락이
    # 직렬화하므로 동시에 같은 세션을 쓰지 않는다.
    if translation_mode == "auto":
        start_job(
            session_id,
            pages,
            target_lang=target_lang,
            style=style,
            ignore_math=ignore_math,
            ignore_table=ignore_table,
            ignore_refs=ignore_refs
        )

    async def _run_post_upload_insights():
        try:
            if document_mode == "research":
                await generate_primer(
                    session_id,
                    pages,
                    metadata,
                    username=current_user,
                    pdf_path=pdf_path,
                    target_lang=target_lang,
                    session_id=session_id,
                )
        except Exception as e:
            print(f"[Upload {session_id}] Primer 생성 실패: {e}")

        if keyword_mode == "auto":
            start_keyword_job(
                session_id,
                pages,
                target_lang,
                metadata.get("title") or file.filename,
                document_mode,
                document_type,
            )

        if summary_mode == "auto":
            start_summary_job(
                session_id,
                pages,
                target_lang,
                metadata.get("title") or file.filename,
                document_mode,
                document_type,
            )

    asyncio.create_task(_run_post_upload_insights())

    return UploadResponse(
        session_id=session_id,
        filename=file.filename,
        total_pages=len(pages),
        file_size_mb=round(file_size_mb, 2),
        metadata=metadata,
        document_mode=document_mode,
        document_type=document_type,
    )



@router.get("/session/{session_id}")
async def get_session(session_id: str, current_user: str = Depends(get_current_user)):
    """세션 정보를 반환합니다."""
    session = require_session_owner(session_id, current_user)
    return {
        "session_id": session_id,
        "filename": session["filename"],
        "total_pages": session["total_pages"],
        "metadata": session["metadata"],
        "document_mode": session.get("document_mode", "research"),
        "document_type": session.get("document_type", "research_paper"),
    }


@router.delete("/session/{session_id}")
async def delete_session(session_id: str, current_user: str = Depends(get_current_user)):
    """세션 및 업로드 파일을 삭제합니다."""
    require_session_owner(session_id, current_user)

    session = sessions.pop(session_id)
    session_dir = os.path.dirname(session["pdf_path"])

    from services.library import delete_chat_sessions
    delete_chat_sessions(session_id)

    shutil.rmtree(session_dir, ignore_errors=True)

    from services.cache import clear_session_cache
    clear_session_cache(session_id)

    return {"message": "세션이 삭제되었습니다."}


@router.get("/pdf/{session_id}")
async def get_pdf_path(session_id: str, current_user: str = Depends(get_current_user)):
    """세션의 PDF 파일 경로를 반환합니다."""
    session = require_session_owner(session_id, current_user)
    return {"pdf_path": session["pdf_path"]}
