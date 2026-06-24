import uuid
import os
import shutil
from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from fastapi.responses import JSONResponse
import aiofiles
from services.auth import get_current_user

from config import UPLOAD_DIR, MAX_FILE_SIZE_MB
from services.pdf_parser import extract_pages, get_pdf_metadata
from services.library import save_document, get_document, get_pdf_path as lib_pdf_path, list_documents
from services.translation_job import start_job, resume_incomplete_jobs
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
        pages = extract_pages(pdf_path)
        sessions[session_id] = {
            "pdf_path": pdf_path,
            "filename": doc["filename"],
            "pages": pages,
            "total_pages": doc["total_pages"],
            "metadata": doc.get("metadata", {}),
            "from_library": True,
            "username": doc.get("username", "admin"),
        }
        return True
    except Exception:
        return False


def restore_sessions_from_library():
    """서버 시작 시 라이브러리의 문서들을 세션으로 복원하고 미완료 잡을 재개합니다."""
    for doc in list_documents():
        doc_id = doc["id"]
        pdf_path = lib_pdf_path(doc_id)
        if not pdf_path:
            continue
        try:
            pages = extract_pages(pdf_path)
            sessions[doc_id] = {
                "pdf_path": pdf_path,
                "filename": doc["filename"],
                "pages": pages,
                "total_pages": doc["total_pages"],
                "metadata": doc.get("metadata", {}),
                "from_library": True,
                "username": doc.get("username", "admin"),
            }
        except Exception:
            pass

    # 미완료 번역 잡 재개
    resume_incomplete_jobs(sessions)


@router.post("/upload", response_model=UploadResponse)
async def upload_pdf(
    file: UploadFile = File(...),
    target_lang: str = "한국어",
    style: str = "academic",
    ignore_math: bool = False,
    ignore_table: bool = True,
    ignore_refs: bool = False,
    current_user: str = Depends(get_current_user)
):
    """PDF 파일을 업로드하고 텍스트를 추출합니다."""
    # 파일 검증
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="PDF 파일만 업로드 가능합니다.")

    # 세션 ID 생성
    session_id = str(uuid.uuid4())
    session_dir = os.path.join(UPLOAD_DIR, session_id)
    os.makedirs(session_dir, exist_ok=True)
    pdf_path = os.path.join(session_dir, "document.pdf")

    # 파일 저장
    content = await file.read()
    file_size_mb = len(content) / (1024 * 1024)

    if file_size_mb > MAX_FILE_SIZE_MB:
        raise HTTPException(
            status_code=413,
            detail=f"파일 크기가 {MAX_FILE_SIZE_MB}MB를 초과합니다."
        )

    async with aiofiles.open(pdf_path, "wb") as f:
        await f.write(content)

    # PDF 파싱
    try:
        metadata = get_pdf_metadata(pdf_path)
        pages = extract_pages(pdf_path)
    except Exception as e:
        shutil.rmtree(session_dir, ignore_errors=True)
        raise HTTPException(status_code=422, detail=f"PDF 파싱 실패: {str(e)}")

    # 라이브러리에 영구 저장
    save_document(session_id, file.filename, pdf_path, len(pages), metadata, username=current_user)

    # 세션 저장 (메모리)
    sessions[session_id] = {
        "pdf_path": pdf_path,
        "filename": file.filename,
        "pages": pages,
        "total_pages": len(pages),
        "metadata": metadata,
        "from_library": False,
        "username": current_user,
    }

    # 백그라운드 번역 잡 즉시 시작 (사용자 지정 번역 옵션 바인딩)
    start_job(
        session_id,
        pages,
        target_lang=target_lang,
        style=style,
        ignore_math=ignore_math,
        ignore_table=ignore_table,
        ignore_refs=ignore_refs
    )

    return UploadResponse(
        session_id=session_id,
        filename=file.filename,
        total_pages=len(pages),
        file_size_mb=round(file_size_mb, 2),
        metadata=metadata,
    )



@router.get("/session/{session_id}")
async def get_session(session_id: str):
    """세션 정보를 반환합니다."""
    if not ensure_session(session_id):
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다.")

    session = sessions[session_id]
    return {
        "session_id": session_id,
        "filename": session["filename"],
        "total_pages": session["total_pages"],
        "metadata": session["metadata"],
    }


@router.delete("/session/{session_id}")
async def delete_session(session_id: str):
    """세션 및 업로드 파일을 삭제합니다."""
    if not ensure_session(session_id):
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다.")

    session = sessions.pop(session_id)
    session_dir = os.path.dirname(session["pdf_path"])
    shutil.rmtree(session_dir, ignore_errors=True)

    from services.cache import clear_session_cache
    clear_session_cache(session_id)

    return {"message": "세션이 삭제되었습니다."}


@router.get("/pdf/{session_id}")
async def get_pdf_path(session_id: str):
    """세션의 PDF 파일 경로를 반환합니다."""
    if not ensure_session(session_id):
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다.")
    return {"pdf_path": sessions[session_id]["pdf_path"]}
