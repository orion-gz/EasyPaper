from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import FileResponse
from pydantic import BaseModel

from services.translation_job import (
    get_job_status,
    get_full_md_path,
    get_page_md,
    start_job,
    cancel_job,
)
from services.auth import get_current_user
from routers.upload import sessions, ensure_session

router = APIRouter()

class RestartJobRequest(BaseModel):
    target_lang: str = "한국어"
    style: str = "academic"
    ignore_math: bool = False
    ignore_table: bool = True
    ignore_refs: bool = False


@router.get("/jobs/{session_id}/status")
async def job_status(session_id: str):
    """잡 진행 상황을 반환합니다."""
    job = get_job_status(session_id)
    if not job:
        raise HTTPException(status_code=404, detail="잡을 찾을 수 없습니다.")
    return job


@router.get("/jobs/{session_id}/page/{page_num}")
async def get_page_translation(
    session_id: str,
    page_num: int,
    target_lang: str = "한국어",
    style: str = "academic",
    ignore_math: bool = False,
    ignore_table: bool = True,
    ignore_refs: bool = False
):
    """특정 페이지의 번역 MD 내용을 반환합니다."""
    suffix = f"{target_lang}_{style}_math{int(ignore_math)}_table{int(ignore_table)}_refs{int(ignore_refs)}"
    text = get_page_md(session_id, page_num, suffix)
    if text is None:
        raise HTTPException(status_code=404, detail="아직 번역되지 않은 페이지입니다.")
    return {"page_num": page_num, "translation": text}


@router.get("/jobs/{session_id}/download")
async def download_translation(
    session_id: str,
    target_lang: str = "한국어",
    style: str = "academic",
    ignore_math: bool = False,
    ignore_table: bool = True,
    ignore_refs: bool = False
):
    """전체 번역 MD 파일을 다운로드합니다."""
    suffix = f"{target_lang}_{style}_math{int(ignore_math)}_table{int(ignore_table)}_refs{int(ignore_refs)}"
    path = get_full_md_path(session_id, suffix)
    if not path:
        raise HTTPException(status_code=404, detail="아직 번역이 완료되지 않았습니다.")
    return FileResponse(
        path,
        media_type="text/markdown",
        filename=f"translation_{suffix}.md",
    )


@router.post("/jobs/{session_id}/restart")
async def restart_translation_job(
    session_id: str,
    data: RestartJobRequest,
    current_user: str = Depends(get_current_user)
):
    """주어진 옵션으로 번역 작업을 중단하고 새로 재시작합니다."""
    if not ensure_session(session_id):
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다.")
        
    session = sessions[session_id]
    pages = session["pages"]
    
    job = start_job(
        session_id,
        pages,
        target_lang=data.target_lang,
        style=data.style,
        ignore_math=data.ignore_math,
        ignore_table=data.ignore_table,
        ignore_refs=data.ignore_refs
    )
    return {"message": "번역 잡이 성공적으로 재시작되었습니다.", "job": job}


@router.post("/jobs/{session_id}/cancel")
async def cancel_translation_job(
    session_id: str,
    current_user: str = Depends(get_current_user)
):
    """현재 진행 중인 번역 작업을 취소(중단)합니다."""
    if not ensure_session(session_id):
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다.")
        
    cancelled = cancel_job(session_id)
    return {"message": "번역 작업이 취소되었습니다." if cancelled else "진행 중인 번역 작업이 없습니다."}

