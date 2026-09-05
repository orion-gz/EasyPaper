import asyncio
import time

from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import FileResponse

from routers.upload import require_session_owner
from services.auth import get_current_user
from services.ownership import require_owned_document
from services.primer import (get_cached_primer, invalidate_primer_cache,
    get_cached_document_overview, invalidate_document_overview,
    generate_adaptive_document_briefing, get_cached_adaptive_briefing,
    invalidate_adaptive_briefing)
from services.library import get_primer_figure_path

router = APIRouter()


def _validated_languages(session: dict, target_value: str) -> tuple[str, str]:
    from services.languages import (
        api_language_error, normalize_document_language, resolve_source_language,
    )
    try:
        target = normalize_document_language(target_value, allow_legacy=True)
    except ValueError:
        raise HTTPException(status_code=400, detail=api_language_error(target_value))
    requested_source = session.get("source_language") or "auto"
    try:
        source = resolve_source_language(session, requested_source)
    except ValueError:
        raise HTTPException(status_code=400, detail=api_language_error(requested_source, source=True))
    # Primer/overview prompts include the source excerpts themselves, so unlike
    # translation they can safely let the LLM infer an undetermined or mixed
    # source language. Upload-time generation already uses ``und``/``mul``;
    # rejecting those values here made the generated cache impossible to read
    # from both the Library and Viewer.
    return target, source

# 캐시가 없는 문서(구버전 등)는 이 자리에서 생성해야 하는데, 계보/실험 흐름/
# 용어집까지 생성하는 지금의 프롬프트는 로컬 LLM 기준 수 분씩 걸릴 수 있다.
# 이 시간 동안 HTTP 요청을 열어둔 채 기다리면 리버스 프록시(nginx 등)의 기본
# read timeout(보통 60초)에 걸려 요청이 끊겨버린다 - 실제로 이 문제로 "브리핑을
# 불러오지 못했다"는 문제가 재현됐다. 그래서 생성은 백그라운드 태스크로 돌리고
# 매 GET 요청은 "완료됐으면 결과, 아니면 즉시 pending"만 응답해 요청 자체는
# 항상 짧게 끝나도록 한다 - 프런트(library.js fetchPrimer)가 pending이면 짧은
# 간격으로 재조회한다.
_pending_generations: dict[str, "asyncio.Task"] = {}

# 실패 직후 폴링(3초 간격)이 곧바로 재시도를 몰아치는 걸 막기 위한 쿨다운.
# CLI가 (설정 오류 등으로) 거의 즉시 실패하는 경우, 이 쿨다운이 없으면 매 폴링마다
# 서브프로세스를 새로 띄우게 되어 백엔드 CPU를 독점하는 장애로 이어질 수 있다 -
# 실제로 잘못된 CLI 인자 조합 때문에 이 문제가 재현된 적이 있다.
_last_failure_at: dict[str, float] = {}
_RETRY_COOLDOWN_SECONDS = 15



def cancel_primer_generation(doc_id: str) -> bool:
    cancelled = False
    prefix = f"{doc_id}:"
    for task_key, task in list(_pending_generations.items()):
        if task_key.startswith(prefix) and not task.done():
            task.cancel()
            cancelled = True
    return cancelled


def _ensure_generation_started(doc_id: str, target_lang: str, source_lang: str, session: dict, current_user: str, durable_task_id: str | None = None) -> None:
    """이 문서/언어 조합의 브리핑 생성이 이미 진행 중이 아니면 백그라운드
    태스크로 새로 시작한다. GET(캐시 미스)과 POST(재생성) 양쪽에서 공유한다."""
    from services.processing_policy import ensure_processing_allowed
    ensure_processing_allowed(session, "primer")
    document_mode = session.get("document_mode", "research")
    document_type = session.get("document_type", "research_paper")
    # 기존 연구 브리핑의 task key는 유지해 쿨다운/진행 중 상태 호환성을 보존한다.
    # 일반 문서만 종류별 개요 정책이 달라 분류를 key에 포함한다.
    task_key = (
        f"{doc_id}:{source_lang}:{target_lang}"
        if document_mode == "research"
        else f"{doc_id}:{source_lang}:{target_lang}:{document_mode}:{document_type}"
    )
    task = _pending_generations.get(task_key)
    if task is not None and not task.done():
        return

    last_failure = _last_failure_at.get(task_key)
    if last_failure is not None and (time.monotonic() - last_failure) < _RETRY_COOLDOWN_SECONDS:
        return

    from services.document_tasks import create_task, get_task, update_task
    durable = get_task(durable_task_id) if durable_task_id else None
    if durable is None:
        durable = create_task(doc_id, "primer", {
            "target_lang": target_lang, "source_lang": source_lang,
            "document_mode": document_mode, "document_type": document_type,
        }, status="queued")
    durable_task_id = durable["id"]

    async def _generate():
        from services.document_tasks import retry_async
        from services.document_tasks import wait_for_retry
        if not await wait_for_retry(durable_task_id):
            _pending_generations.pop(task_key, None)
            return
        update_task(durable_task_id, status="running", increment_attempt=True)

        async def generate_once():
            return await generate_adaptive_document_briefing(
                doc_id, session["pages"], session["metadata"], document_mode, document_type,
                target_lang=target_lang, source_lang=source_lang, session_id=doc_id,
            )

        def record_retry(_attempt: int, code: str, retry_at: str) -> None:
            update_task(durable_task_id, status="retry_wait", last_error_code=code,
                        next_retry_at=retry_at, increment_attempt=True)

        try:
            await retry_async(generate_once, on_retry=record_retry)
            update_task(durable_task_id, status="succeeded")
            _last_failure_at.pop(task_key, None)
        except Exception as e:
            update_task(durable_task_id, status="failed",
                        last_error_code=getattr(e, "document_task_error_code", "generation_failed"))
            # generate_primer()가 실패하면 캐시에 아무것도 저장하지 않은 채 여기서
            # 끝난다. 태스크가 pop되므로 쿨다운이 지난 뒤 다음 GET/재생성 요청이
            # 처음부터 다시 시도한다(pending 폴링이 이미 그 재시도를 감당하도록
            # 되어 있다).
            print(f"[primer] 브리핑 생성 실패 ({doc_id}): {e}")
            _last_failure_at[task_key] = time.monotonic()
        finally:
            _pending_generations.pop(task_key, None)

    _pending_generations[task_key] = asyncio.create_task(_generate())


@router.get("/library/{doc_id}/primer")
async def get_primer(doc_id: str, target_lang: str = "ko", current_user: str = Depends(get_current_user)):
    """읽기 전 브리핑 콘텐츠를 반환합니다. 업로드 직후 백그라운드로 이미 생성되어
    있으면 캐시에서 즉시 반환하고, 아직 없으면(구버전 문서 등) 백그라운드 생성을
    시작(또는 이미 진행 중이면 그대로 두고)하고 {"status": "pending"}을 반환합니다."""
    session = require_session_owner(doc_id, current_user)
    target_lang, source_lang = _validated_languages(session, target_lang)
    from services.processing_policy import ensure_processing_allowed
    ensure_processing_allowed(session, "primer")
    document_mode = session.get("document_mode", "research")
    document_type = session.get("document_type", "research_paper")
    cached = get_cached_adaptive_briefing(
        doc_id, document_type, target_lang=target_lang, source_lang=source_lang,
    )
    # Read-only compatibility for pre-v3 caches; all new generation uses v3.
    if not cached:
        cached = (
            get_cached_document_overview(doc_id, document_type, target_lang=target_lang, source_lang=source_lang)
            if document_mode == "general"
            else get_cached_primer(doc_id, target_lang=target_lang, source_lang=source_lang)
        )
    if cached:
        return cached
    _ensure_generation_started(doc_id, target_lang, source_lang, session, current_user)
    await asyncio.sleep(0)
    return {"status": "pending"}


@router.post("/library/{doc_id}/primer/regenerate")
async def regenerate_primer(doc_id: str, target_lang: str = "ko", current_user: str = Depends(get_current_user)):
    """캐시된 브리핑을 지우고 처음부터 다시 생성을 시작합니다. 사용자가 결과가
    부실하다고 느낄 때 수동으로 재시도할 수 있게 하는 용도. GET과 마찬가지로
    생성은 백그라운드로 돌리고 즉시 {"status": "pending"}을 반환한다."""
    session = require_session_owner(doc_id, current_user)
    target_lang, source_lang = _validated_languages(session, target_lang)
    from services.processing_policy import ensure_processing_allowed
    ensure_processing_allowed(session, "primer")
    document_mode = session.get("document_mode", "research")
    document_type = session.get("document_type", "research_paper")
    invalidate_adaptive_briefing(doc_id, document_type, target_lang, source_lang)
    # Explicit regeneration also retires any legacy response for this language.
    if document_mode == "general":
        invalidate_document_overview(doc_id, document_type, target_lang, source_lang)
    else:
        invalidate_primer_cache(doc_id, target_lang, source_lang)
    _ensure_generation_started(doc_id, target_lang, source_lang, session, current_user)
    await asyncio.sleep(0)
    return {"status": "pending"}


@router.get("/library/{doc_id}/primer-figure")
async def get_primer_figure(doc_id: str, current_user: str = Depends(get_current_user)):
    """읽기 전 브리핑에 쓰이는 대표 Figure 크롭 이미지를 서빙합니다."""
    require_owned_document(doc_id, current_user)
    figure_path = get_primer_figure_path(doc_id)
    if not figure_path:
        raise HTTPException(status_code=404, detail="Figure 이미지가 없습니다.")
    return FileResponse(figure_path, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})
