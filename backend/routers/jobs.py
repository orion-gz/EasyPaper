from typing import Optional

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
from routers.upload import require_session_owner

router = APIRouter()


def _validated_languages(session: dict, target_value: str, source_value: str) -> tuple[str, str]:
    """Apply the same target/source policy to get, download, and restart."""
    from services.languages import (
        DOCUMENT_LANGUAGE_CODES, api_language_error, normalize_document_language,
        resolve_source_language,
    )
    try:
        target = normalize_document_language(target_value, allow_legacy=True)
    except ValueError:
        raise HTTPException(status_code=400, detail=api_language_error(target_value))
    try:
        source = resolve_source_language(session, source_value)
    except ValueError:
        raise HTTPException(status_code=400, detail=api_language_error(source_value, source=True))
    if source not in DOCUMENT_LANGUAGE_CODES:
        raise HTTPException(status_code=409, detail={
            "code": "source_language_not_translatable",
            "params": {"language": source},
            "fallback": "The source language cannot be translated automatically.",
        })
    return target, source


class RestartJobRequest(BaseModel):
    target_lang: str = "ko"
    source_lang: str = "auto"
    style: str = "academic"
    ignore_math: bool = False
    ignore_table: bool = True
    ignore_refs: bool = False
    page_numbers: Optional[list[int]] = None
    resume_scope: bool = False


@router.get("/jobs/{session_id}/status")
async def job_status(session_id: str, current_user: str = Depends(get_current_user)):
    """잡 진행 상황을 반환합니다."""
    require_session_owner(session_id, current_user)
    job = get_job_status(session_id)
    if not job:
        raise HTTPException(status_code=404, detail="잡을 찾을 수 없습니다.")
    return job


@router.get("/jobs/{session_id}/page/{page_num}")
async def get_page_translation(
    session_id: str,
    page_num: int,
    target_lang: str = "ko",
    source_lang: str = "auto",
    style: str = "academic",
    ignore_math: bool = False,
    ignore_table: bool = True,
    ignore_refs: bool = False,
    current_user: str = Depends(get_current_user)
):
    """특정 페이지의 번역 MD 내용 및 매핑 데이터를 반환합니다."""
    session = require_session_owner(session_id, current_user)
    target_lang, source_lang = _validated_languages(session, target_lang, source_lang)
    from services.document_policy import translation_cache_candidates
    suffix_candidates = translation_cache_candidates(
        session.get("document_mode", "research"),
        session.get("document_type", "research_paper"),
        target_lang, style, ignore_math, ignore_table, ignore_refs, source_lang,
    )
    
    from services.library import get_translation_full
    full_cached = {"translation": "", "sentences": []}
    for suffix in suffix_candidates:
        full_cached = get_translation_full(session_id, page_num, suffix, fallback=False)
        if full_cached.get("translation"):
            break
        page_text = get_page_md(session_id, page_num, suffix, fallback=False)
        if page_text is not None:
            return {"page_num": page_num, "translation": page_text, "sentences": []}
    if not full_cached.get("translation"):
        raise HTTPException(status_code=404, detail="아직 번역되지 않은 페이지입니다.")
        
    return {
        "page_num": page_num,
        "translation": full_cached["translation"],
        "sentences": full_cached.get("sentences", [])
    }


@router.get("/jobs/{session_id}/download")
async def download_translation(
    session_id: str,
    target_lang: str = "ko",
    source_lang: str = "auto",
    style: str = "academic",
    ignore_math: bool = False,
    ignore_table: bool = True,
    ignore_refs: bool = False,
    current_user: str = Depends(get_current_user)
):
    """전체 번역 MD 파일을 다운로드합니다."""
    session = require_session_owner(session_id, current_user)
    target_lang, source_lang = _validated_languages(session, target_lang, source_lang)
    from services.document_policy import translation_cache_candidates
    suffix_candidates = translation_cache_candidates(
        session.get("document_mode", "research"),
        session.get("document_type", "research_paper"),
        target_lang, style, ignore_math, ignore_table, ignore_refs, source_lang,
    )
    path = None
    matched_suffix = suffix_candidates[0]
    for suffix in suffix_candidates:
        path = get_full_md_path(session_id, suffix, fallback=False)
        if path:
            matched_suffix = suffix
            break
    if not path:
        raise HTTPException(status_code=404, detail="아직 번역이 완료되지 않았습니다.")
    return FileResponse(
        path,
        media_type="text/markdown",
        filename=f"translation_{matched_suffix}.md",
    )


@router.post("/jobs/{session_id}/restart")
async def restart_translation_job(
    session_id: str,
    data: RestartJobRequest,
    current_user: str = Depends(get_current_user)
):
    """주어진 옵션으로 번역 작업을 중단하고 새로 재시작합니다."""
    session = require_session_owner(session_id, current_user)
    target_lang, source_lang = _validated_languages(session, data.target_lang, data.source_lang)
    if source_lang == target_lang:
        raise HTTPException(status_code=409, detail={
            "code": "same_source_and_target_language", "params": {"language": target_lang},
            "fallback": "Source and target languages must be different.",
        })
    pages = session["pages"]
    page_numbers = data.page_numbers
    if data.resume_scope and page_numbers is None:
        previous_job = get_job_status(session_id)
        if previous_job:
            page_numbers = previous_job.get("target_pages")

    try:
        job = start_job(
            session_id,
            pages,
            target_lang=target_lang,
            source_lang=source_lang,
            style=data.style,
            ignore_math=data.ignore_math,
            ignore_table=data.ignore_table,
            ignore_refs=data.ignore_refs,
            page_numbers=page_numbers,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"message": "Translation job restarted.", "job": job}


@router.post("/jobs/{session_id}/cancel")
async def cancel_translation_job(
    session_id: str,
    current_user: str = Depends(get_current_user)
):
    """현재 진행 중인 번역 작업을 취소(중단)합니다."""
    require_session_owner(session_id, current_user)

    cancelled = cancel_job(session_id)
    return {"message": "번역 작업이 취소되었습니다." if cancelled else "진행 중인 번역 작업이 없습니다."}

