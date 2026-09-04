"""Chapter boundaries and progressive document summaries."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from routers.upload import require_session_owner
from services.auth import get_current_user
from services.chapter_summaries import (
    detect_chapters, estimate_full_summary, find_chapter, get_cached_chapter_summary,
    get_cached_full_summary, invalidate_chapter_summary, invalidate_full_summary, latest_full_summary_task,
    start_chapter_summary, start_full_summary,
)
from services.ownership import require_owned_document

router = APIRouter()


class FullSummaryStartRequest(BaseModel):
    confirmed: bool = False
    target_lang: str | None = None


def _context(doc_id: str, current_user: str) -> tuple[dict, dict, dict]:
    document = require_owned_document(doc_id, current_user)
    session = require_session_owner(doc_id, current_user)
    detected = detect_chapters(document, session.get("pages", []), session.get("pdf_path", ""))
    return document, session, detected


def _language(document: dict, requested: str | None = None) -> str:
    return (requested or document.get("preferred_target_language") or "ko").strip()[:20]


def _require_chapters(detected: dict) -> list[dict]:
    if detected["status"] != "available":
        raise HTTPException(status_code=409, detail={
            "code": detected["reason"], "params": {},
            "fallback": "확인 가능한 목차 또는 장·절 헤더가 없습니다.",
        })
    return detected["chapters"]


@router.get("/library/{doc_id}/chapters")
async def list_document_chapters(doc_id: str, current_user: str = Depends(get_current_user)):
    document, _, detected = _context(doc_id, current_user)
    target_lang = _language(document)
    chapters = []
    for chapter in detected["chapters"]:
        item = dict(chapter)
        item["summary_status"] = "completed" if get_cached_chapter_summary(document, chapter, target_lang) else "not_started"
        chapters.append(item)
    return {**detected, "chapters": chapters, "target_lang": target_lang}


@router.get("/library/{doc_id}/chapters/{chapter_id}/summary")
async def get_chapter_summary(doc_id: str, chapter_id: str, current_user: str = Depends(get_current_user)):
    document, session, detected = _context(doc_id, current_user)
    chapter = find_chapter(_require_chapters(detected), chapter_id)
    if not chapter:
        raise HTTPException(status_code=404, detail="장을 찾을 수 없습니다.")
    target_lang = _language(document)
    cached = get_cached_chapter_summary(document, chapter, target_lang)
    if cached:
        return {"status": "completed", "summary": cached}
    task = start_chapter_summary(document, session["pages"], chapter, target_lang)
    return {"status": task["status"], "task_id": task["id"], "chapter": chapter}


@router.post("/library/{doc_id}/chapters/{chapter_id}/summary/regenerate")
async def regenerate_chapter_summary(doc_id: str, chapter_id: str, current_user: str = Depends(get_current_user)):
    document, session, detected = _context(doc_id, current_user)
    chapter = find_chapter(_require_chapters(detected), chapter_id)
    if not chapter:
        raise HTTPException(status_code=404, detail="장을 찾을 수 없습니다.")
    target_lang = _language(document)
    invalidate_chapter_summary(document, chapter, target_lang)
    invalidate_full_summary(document, target_lang)
    task = start_chapter_summary(document, session["pages"], chapter, target_lang)
    return {"status": task["status"], "task_id": task["id"], "chapter": chapter}


@router.get("/library/{doc_id}/full-summary/estimate")
async def full_summary_estimate(doc_id: str, current_user: str = Depends(get_current_user)):
    document, session, detected = _context(doc_id, current_user)
    chapters = _require_chapters(detected)
    return estimate_full_summary(document, session["pages"], chapters, _language(document))


@router.post("/library/{doc_id}/full-summary/start")
async def start_document_full_summary(doc_id: str, body: FullSummaryStartRequest, current_user: str = Depends(get_current_user)):
    if not body.confirmed:
        raise HTTPException(status_code=400, detail="정밀 전체 요약은 confirmed: true 확인이 필요합니다.")
    document, session, detected = _context(doc_id, current_user)
    target_lang = _language(document, body.target_lang)
    cached = get_cached_full_summary(document, target_lang)
    if cached:
        return {"status": "completed", "summary": cached}
    task = start_full_summary(document, session["pages"], _require_chapters(detected), target_lang)
    return {"status": task["status"], "task_id": task["id"]}


@router.get("/library/{doc_id}/full-summary/status")
async def full_summary_status(doc_id: str, current_user: str = Depends(get_current_user)):
    document = require_owned_document(doc_id, current_user)
    target_lang = _language(document)
    cached = get_cached_full_summary(document, target_lang)
    if cached:
        return {"status": "completed", "summary": cached}
    task = latest_full_summary_task(doc_id)
    return {"status": task["status"] if task else "not_started", "task": task}
