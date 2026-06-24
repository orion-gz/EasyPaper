import asyncio
import json
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from routers.upload import sessions, ensure_session
from services.chunker import split_into_chunks
from services.llm_client import stream_translation, check_ollama_health
from services.cache import get_cached_translation, save_translation_cache
from services.library import save_translation as lib_save_translation, get_translation as lib_get_translation, clear_translations as lib_clear_translations

router = APIRouter()


@router.get("/translate/{session_id}/{page_num}")
async def translate_page(
    session_id: str,
    page_num: int,
    target_lang: str = "한국어",
    style: str = "academic",
    ignore_math: bool = False,
    ignore_table: bool = True,
    ignore_refs: bool = False
):
    """
    특정 페이지를 번역하고 SSE 스트리밍으로 반환합니다.
    이미 동일한 옵션으로 번역된 페이지는 캐시에서 즉시 반환합니다.
    """
    if not ensure_session(session_id):
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다.")

    session = sessions[session_id]
    total_pages = session["total_pages"]

    if page_num < 1 or page_num > total_pages:
        raise HTTPException(
            status_code=400,
            detail=f"페이지 번호는 1~{total_pages} 사이여야 합니다."
        )

    pages = session["pages"]
    page_data = next((p for p in pages if p["page_num"] == page_num), None)

    if not page_data:
        raise HTTPException(status_code=404, detail="페이지를 찾을 수 없습니다.")

    page_text = page_data.get("text", "").strip()
    
    # 설정 옵션들을 결합한 고유 캐시 접미사 생성
    suffix = f"{target_lang}_{style}_math{int(ignore_math)}_table{int(ignore_table)}_refs{int(ignore_refs)}"

    async def event_stream():
        # 1순위: 라이브러리 저장 번역 확인
        lib_cached = lib_get_translation(session_id, page_num, suffix)
        cached = lib_cached or get_cached_translation(session_id, page_num, suffix)

        if cached:
            chunk_size = 100
            for i in range(0, len(cached), chunk_size):
                chunk = cached[i:i + chunk_size]
                data = json.dumps({"content": chunk, "done": False, "cached": True}, ensure_ascii=False)
                yield f"data: {data}\n\n"
                await asyncio.sleep(0.01)
            yield f"data: {json.dumps({'content': '', 'done': True, 'cached': True})}\n\n"
            return

        # 텍스트가 없는 페이지 처리
        if not page_text:
            msg = "이 페이지에는 번역할 텍스트가 없습니다."
            data = json.dumps({"content": msg, "done": False, "cached": False}, ensure_ascii=False)
            yield f"data: {data}\n\n"
            yield f"data: {json.dumps({'content': '', 'done': True, 'cached': False})}\n\n"
            return

        # 청크 분할
        chunks = split_into_chunks(page_text)
        full_translation = []
        doc_title = session.get("metadata", {}).get("title") or session.get("filename", "")

        try:
            for chunk_idx, chunk in enumerate(chunks):
                # 청크 구분자 (여러 청크일 때)
                if chunk_idx > 0:
                    separator = "\n\n"
                    data = json.dumps({"content": separator, "done": False, "cached": False}, ensure_ascii=False)
                    yield f"data: {data}\n\n"

                # 이전 번역 문맥 구성 (첫 번째 청크면 이전 페이지 번역, 그 외에는 현재 페이지의 이전 청크들 번역)
                if chunk_idx == 0:
                    prev_context = ""
                    if page_num > 1:
                        prev_cached = lib_get_translation(session_id, page_num - 1, suffix) or get_cached_translation(session_id, page_num - 1, suffix)
                        if prev_cached:
                            prev_context = prev_cached
                else:
                    prev_context = "\n\n".join(full_translation)

                # LLM 스트리밍 (사용자 지정 옵션 동적 바인딩)
                chunk_result = []
                async for token in stream_translation(
                    chunk,
                    target_lang=target_lang,
                    style=style,
                    ignore_math=ignore_math,
                    ignore_table=ignore_table,
                    ignore_refs=ignore_refs,
                    doc_title=doc_title,
                    prev_context=prev_context
                ):
                    chunk_result.append(token)
                    data = json.dumps({"content": token, "done": False, "cached": False}, ensure_ascii=False)
                    yield f"data: {data}\n\n"

                full_translation.append("".join(chunk_result))

            # 완성된 번역 캐시 저장 (파일 캐시 + 라이브러리 영구 저장)
            complete_translation = "\n\n".join(full_translation)
            save_translation_cache(session_id, page_num, complete_translation, suffix)
            lib_save_translation(session_id, page_num, complete_translation, suffix)

        except Exception as e:
            error_data = json.dumps({"error": str(e), "done": True})
            yield f"data: {error_data}\n\n"
            return

        yield f"data: {json.dumps({'content': '', 'done': True, 'cached': False})}\n\n"


    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.get("/health")
async def health_check():
    """AI 제공자 및 상태를 확인합니다."""
    from config import get_trans_provider, get_openai_api_key, get_gemini_api_key, get_claude_api_key
    provider = get_trans_provider()
    
    if provider == "openai":
        has_key = bool(get_openai_api_key())
        return {"status": "ok" if has_key else "error", "provider": "openai", "model_available": has_key}
    elif provider == "gemini":
        has_key = bool(get_gemini_api_key())
        return {"status": "ok" if has_key else "error", "provider": "gemini", "model_available": has_key}
    elif provider == "claude":
        has_key = bool(get_claude_api_key())
        return {"status": "ok" if has_key else "error", "provider": "claude", "model_available": has_key}
    elif provider == "antigravity":
        import os
        has_cli = os.path.exists("/home/ubuntu/.local/bin/agy")
        return {"status": "ok" if has_cli else "error", "provider": "antigravity", "model_available": has_cli}
        
    health = await check_ollama_health()
    health["provider"] = "ollama"
    return health


@router.get("/translation-status/{session_id}")
async def translation_status(session_id: str):
    """세션의 번역 완료 페이지 목록을 반환합니다."""
    if not ensure_session(session_id):
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다.")

    session = sessions[session_id]
    total_pages = session["total_pages"]

    from services.cache import get_cached_translation
    translated_pages = [
        p for p in range(1, total_pages + 1)
        if get_cached_translation(session_id, p) is not None
    ]

    return {
        "session_id": session_id,
        "total_pages": total_pages,
        "translated_pages": translated_pages,
        "progress": len(translated_pages) / total_pages if total_pages > 0 else 0,
    }


@router.post("/translate/{session_id}/clear-cache")
async def clear_translation_cache(session_id: str):
    """세션의 모든 번역 캐시와 라이브러리 번역 저장본 및 잡 상태를 지웁니다."""
    if not ensure_session(session_id):
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다.")
        
    # 1. 파일 캐시 삭제
    from services.cache import clear_session_cache
    clear_session_cache(session_id)
    
    # 2. 라이브러리 번역 저장본 삭제 및 메타데이터 업데이트
    lib_clear_translations(session_id)
    
    from config import LIBRARY_DIR
    import os
    import shutil
    import json
    
    doc_trans_dir = os.path.join(LIBRARY_DIR, session_id, "translations")
    if os.path.exists(doc_trans_dir):
        shutil.rmtree(doc_trans_dir, ignore_errors=True)
        os.makedirs(doc_trans_dir, exist_ok=True)
        
    meta_path = os.path.join(LIBRARY_DIR, session_id, "metadata.json")
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            meta["translated_pages"] = []
            with open(meta_path, "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
            
    # 3. 백그라운드 태스크 취소 및 잡 파일 삭제
    from services.translation_job import _running_tasks, _job_path
    if session_id in _running_tasks:
        try:
            _running_tasks[session_id].cancel()
            del _running_tasks[session_id]
        except Exception:
            pass
        
    job_path = _job_path(session_id)
    if os.path.exists(job_path):
        try:
            os.remove(job_path)
        except Exception:
            pass
            
    return {"message": "번역 캐시와 잡이 성공적으로 초기화되었습니다."}

