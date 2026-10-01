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
    if task["status"] not in {"queued", "running", "retry_wait"}:
        return task
    from services import translation_job, insight_job, chapter_summaries, document_classification
    from routers import primer
    import asyncio
    workers = []
    if task["kind"] == "translate":
        workers = [translation_job._running_tasks.get(task["doc_id"])]
    elif task["kind"] in {"keywords", "summary"}:
        workers = [insight_job._running_tasks.get((task["doc_id"], task["kind"]))]
    elif task["kind"] in {"chapter_summary", "full_summary"}:
        workers = [chapter_summaries._running.get(task_id)]
    elif task["kind"] == "classification":
        workers = [document_classification._running.get(task_id)]
    elif task["kind"] == "primer":
        options = task["options"]
        prefix = f'{task["doc_id"]}:{options.get("source_lang", "auto")}:{options.get("target_lang", "ko")}'
        workers = [worker for key, worker in primer._pending_generations.items() if key == prefix or key.startswith(prefix + ':')]
    request_cancel(task_id)
    workers = [worker for worker in workers if worker and not worker.done()]
    for worker in workers:
        worker.cancel()
    if workers:
        await asyncio.gather(*workers, return_exceptions=True)
    if task["kind"] == "classification":
        from services.db import db_update_document_classification_recommendation
        db_update_document_classification_recommendation(task["doc_id"], "failed", error="classification_cancelled")
    return get_task(task_id)


@router.post("/tasks/{task_id}/retry")
async def retry_document_task(task_id: str, current_user: str = Depends(get_current_user)):
    previous = _owned_task(task_id, current_user)
    if previous["kind"] not in {"translate", "keywords", "summary", "primer", "chapter_summary", "full_summary", "classification"}:
        raise HTTPException(status_code=409, detail="이 작업 종류는 수동 재시도를 지원하지 않습니다.")
    failed_pages = previous["failed_pages"] or [
        page["page_num"] for page in previous["pages"] if page["status"] == "cancelled"
    ]
    if previous["status"] not in {"failed", "partial_failed", "cancelled"}:
        raise HTTPException(status_code=409, detail="실패하거나 취소된 작업만 재시도할 수 있습니다.")
    session = require_session_owner(previous["doc_id"], current_user)
    from services.processing_policy import ensure_processing_allowed
    operation = {"translate": "translate", "classification": "classification", "primer": "primer"}.get(previous["kind"], "insight")
    ensure_processing_allowed(session, operation)
    try:
        task = reset_failed(task_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
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
