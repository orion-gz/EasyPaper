from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from routers.upload import require_session_owner
from services.auth import get_current_user
from services.document_tasks import get_task, list_tasks, request_cancel, reset_failed
from services.ownership import require_owned_document

router = APIRouter()


def _owned_task(task_id: str, current_user: str) -> dict:
    task = get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="작업을 찾을 수 없습니다.")
    require_owned_document(task["doc_id"], current_user)
    return task


@router.get("/tasks")
async def get_document_tasks(doc_id: Optional[str] = Query(default=None), current_user: str = Depends(get_current_user)):
    if not doc_id:
        raise HTTPException(status_code=400, detail="doc_id가 필요합니다.")
    require_owned_document(doc_id, current_user)
    return {"tasks": list_tasks(doc_id)}


@router.get("/tasks/{task_id}")
async def get_document_task(task_id: str, current_user: str = Depends(get_current_user)):
    return _owned_task(task_id, current_user)


@router.post("/tasks/{task_id}/cancel")
async def cancel_document_task(task_id: str, current_user: str = Depends(get_current_user)):
    task = _owned_task(task_id, current_user)
    if task["kind"] == "translate":
        from services.translation_job import cancel_job
        cancel_job(task["doc_id"])
    elif task["kind"] in {"keywords", "summary"}:
        from services.insight_job import cancel_insight_job
        cancel_insight_job(task["doc_id"], task["kind"])
    elif task["kind"] in {"chapter_summary", "full_summary"}:
        from services.chapter_summaries import cancel_summary_task
        cancel_summary_task(task_id)
    return request_cancel(task_id)


@router.post("/tasks/{task_id}/retry")
async def retry_document_task(task_id: str, current_user: str = Depends(get_current_user)):
    previous = _owned_task(task_id, current_user)
    if previous["kind"] not in {"translate", "keywords", "summary", "primer", "chapter_summary", "full_summary", "classification"}:
        raise HTTPException(status_code=409, detail="이 작업 종류는 수동 재시도를 지원하지 않습니다.")
    failed_pages = previous["failed_pages"] or [
        page["page_num"] for page in previous["pages"] if page["status"] == "cancelled"
    ]
    task = reset_failed(task_id)
    session = require_session_owner(task["doc_id"], current_user)
    options = task["options"]
    if task["kind"] == "translate":
        from services.translation_job import start_job
        start_job(
            task["doc_id"], session["pages"], target_lang=options.get("target_lang", "ko"),
            source_lang=options.get("source_lang", "auto"), style=options.get("style", "academic"),
            ignore_math=bool(options.get("ignore_math", False)),
            ignore_table=bool(options.get("ignore_table", True)),
            ignore_refs=bool(options.get("ignore_refs", False)),
            page_numbers=failed_pages or None, durable_task_id=task_id,
        )
    elif task["kind"] in {"keywords", "summary"}:
        from services.insight_job import start_keyword_job, start_summary_job
        starter = start_keyword_job if task["kind"] == "keywords" else start_summary_job
        starter(
            task["doc_id"], session["pages"], options.get("target_lang", "ko"),
            session.get("metadata", {}).get("title") or session.get("filename", ""),
            session.get("document_mode", "research"), session.get("document_type", "research_paper"),
            options.get("source_lang", "auto"), durable_task_id=task_id,
        )
    elif task["kind"] == "primer":
        from routers.primer import _ensure_generation_started
        _ensure_generation_started(
            task["doc_id"], options.get("target_lang", "ko"), options.get("source_lang", "auto"),
            session, current_user, durable_task_id=task_id,
        )
    elif task["kind"] == "classification":
        from services.document_classification import start_classification_task
        start_classification_task(
            task["doc_id"], options.get("title") or session.get("filename", ""),
            session["pages"], durable_task_id=task_id,
        )
    elif task["kind"] in {"chapter_summary", "full_summary"}:
        from services.chapter_summaries import recover_summary_task
        from services.db import db_get_document
        document = db_get_document(task["doc_id"])
        if not document:
            raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다.")
        recover_summary_task(task, document, session["pages"], session.get("pdf_path", ""))
    return get_task(task_id)
