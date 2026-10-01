"""Read-only cache lookup and explicit Easy English generation."""
import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from config import get_trans_model, get_trans_provider
from routers.upload import require_session_owner
from services.auth import get_current_user
from services import easy_english as service
from services.generation_errors import generation_error_payload
from services.processing_policy import ensure_processing_allowed
from services.rate_limiter import enforce_rate_limit

router = APIRouter()


class GenerateRequest(BaseModel):
    regenerate: bool = False


async def context(doc_id, page_num, user):
    session = await asyncio.to_thread(require_session_owner, doc_id, user)
    source = session.get("source_language", "auto")
    if source == "auto":
        source = session.get("detected_source_language", "und")
    if source != "en":
        raise HTTPException(409, detail={"code": "easy_english_requires_english", "fallback": "Easy English requires an English source. Check the document language."})
    page = next((p for p in session["pages"] if p["page_num"] == page_num), None)
    if page is None:
        raise HTTPException(404, detail="Page not found")
    if page.get("text_recovery") == "failed":
        raise HTTPException(422, detail={"code": "pdf_ocr_failed", "fallback": "This page has no usable text. Reparse the document."})
    provider, model = get_trans_provider(), get_trans_model()
    return session, page, provider, model, service.cache_key(session, page, provider, model)


@router.get("/easy-english/{session_id}/{page_num}")
async def get_result(session_id: str, page_num: int, current_user: str = Depends(get_current_user)):
    *_, key = await context(session_id, page_num, current_user)
    result = service.read_result(session_id, key)
    if result is None:
        raise HTTPException(404, detail="No Easy English result")
    return {**result, "cached": True}


@router.post("/easy-english/{session_id}/{page_num}")
async def generate_result(session_id: str, page_num: int, body: GenerateRequest, current_user: str = Depends(get_current_user)):
    session, page, provider, model, key = await context(session_id, page_num, current_user)
    ensure_processing_allowed(session, "easy_english", provider=provider)
    cached = None if body.regenerate else service.read_result(session_id, key)
    task = None
    if cached is None:
        if (session_id, key) not in service._running:
            enforce_rate_limit("translate", current_user)
        task = service.start_generation(session_id, session, page, key, provider, model)

    async def events():
        def event(payload):
            return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
        if cached is not None:
            yield event({**cached, "done": True, "cached": True})
            return
        yield event({"done": False, "status": "generating"})
        try:
            while not task.done():
                done, _ = await asyncio.wait({task}, timeout=10)
                if not done:
                    yield ": generating\n\n"
            result = await asyncio.shield(task)
            yield event({**result, "done": True, "cached": False})
        except asyncio.CancelledError:
            if task.cancelled():
                yield event({"done": True, "error": {"code": "generation_failed", "fallback": "The document changed during generation."}})
            else:
                raise
        except Exception as exc:
            yield event({"done": True, "error": generation_error_payload(exc)})
    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
