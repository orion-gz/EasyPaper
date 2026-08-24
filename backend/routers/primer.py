import asyncio
import time

from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import FileResponse

from routers.upload import require_session_owner
from services.auth import get_current_user
from services.ownership import require_owned_document
from services.primer import (get_cached_primer, generate_primer, invalidate_primer_cache,
    generate_document_overview, get_cached_document_overview, invalidate_document_overview)
from services.library import get_primer_figure_path

router = APIRouter()

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


def _ensure_generation_started(doc_id: str, target_lang: str, session: dict, current_user: str) -> None:
    """이 문서/언어 조합의 브리핑 생성이 이미 진행 중이 아니면 백그라운드
    태스크로 새로 시작한다. GET(캐시 미스)과 POST(재생성) 양쪽에서 공유한다."""
    document_mode = session.get("document_mode", "research")
    document_type = session.get("document_type", "research_paper")
    # 기존 연구 브리핑의 task key는 유지해 쿨다운/진행 중 상태 호환성을 보존한다.
    # 일반 문서만 종류별 개요 정책이 달라 분류를 key에 포함한다.
    task_key = (
        f"{doc_id}:{target_lang}"
        if document_mode == "research"
        else f"{doc_id}:{target_lang}:{document_mode}:{document_type}"
    )
    task = _pending_generations.get(task_key)
    if task is not None and not task.done():
        return

    last_failure = _last_failure_at.get(task_key)
    if last_failure is not None and (time.monotonic() - last_failure) < _RETRY_COOLDOWN_SECONDS:
        return

    async def _generate():
        try:
            if document_mode == "general":
                await generate_document_overview(
                    doc_id, session["pages"], session["metadata"], document_type,
                    target_lang=target_lang, session_id=doc_id,
                )
            else:
                await generate_primer(
                    doc_id, session["pages"], session["metadata"],
                    username=current_user, pdf_path=session["pdf_path"],
                    target_lang=target_lang, session_id=doc_id,
                    source_lang=session.get("source_language") or session.get("detected_source_language", "auto"),
                )
            _last_failure_at.pop(task_key, None)
        except Exception as e:
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
async def get_primer(doc_id: str, target_lang: str = "한국어", current_user: str = Depends(get_current_user)):
    """읽기 전 브리핑 콘텐츠를 반환합니다. 업로드 직후 백그라운드로 이미 생성되어
    있으면 캐시에서 즉시 반환하고, 아직 없으면(구버전 문서 등) 백그라운드 생성을
    시작(또는 이미 진행 중이면 그대로 두고)하고 {"status": "pending"}을 반환합니다."""
    session = require_session_owner(doc_id, current_user)
    if session.get("document_mode", "research") == "general":
        cached = get_cached_document_overview(
            doc_id, session.get("document_type", "other"), target_lang=target_lang,
        )
    else:
        cached = get_cached_primer(doc_id, target_lang=target_lang)
    if cached:
        return cached
    _ensure_generation_started(doc_id, target_lang, session, current_user)
    return {"status": "pending"}


@router.post("/library/{doc_id}/primer/regenerate")
async def regenerate_primer(doc_id: str, target_lang: str = "한국어", current_user: str = Depends(get_current_user)):
    """캐시된 브리핑을 지우고 처음부터 다시 생성을 시작합니다. 사용자가 결과가
    부실하다고 느낄 때 수동으로 재시도할 수 있게 하는 용도. GET과 마찬가지로
    생성은 백그라운드로 돌리고 즉시 {"status": "pending"}을 반환한다."""
    session = require_session_owner(doc_id, current_user)
    if session.get("document_mode", "research") == "general":
        invalidate_document_overview(doc_id, session.get("document_type", "other"), target_lang)
    else:
        invalidate_primer_cache(doc_id, target_lang)
    _ensure_generation_started(doc_id, target_lang, session, current_user)
    return {"status": "pending"}


@router.get("/library/{doc_id}/primer-figure")
async def get_primer_figure(doc_id: str, current_user: str = Depends(get_current_user)):
    """읽기 전 브리핑에 쓰이는 대표 Figure 크롭 이미지를 서빙합니다."""
    require_owned_document(doc_id, current_user)
    figure_path = get_primer_figure_path(doc_id)
    if not figure_path:
        raise HTTPException(status_code=404, detail="Figure 이미지가 없습니다.")
    return FileResponse(figure_path, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})
