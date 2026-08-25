import asyncio
import hashlib
import json
import re
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from typing import List, Optional, Literal

from routers.upload import sessions, ensure_session, require_session_owner
from services.ownership import require_owned_documents
from services.llm_client import stream_chat, generate_suggested_questions
from services.db import (
    db_save_chat_message,
    db_get_chat_history,
    db_get_translation,
    db_save_chat_evidence,
    db_save_chat_verification,
    db_list_assistant_chat_sessions,
    db_upsert_compare_session,
    db_list_compare_chat_sessions,
)
from services.library import save_chat_quote_image
from services.auth import get_current_user
from services.rate_limiter import enforce_rate_limit

# 프론트가 이미지 인용 메시지에 붙이는 "[인용된 이미지 (Page N)|quoteId]" 마커에서
# quoteId만 뽑아낸다 - main.js의 sendChatMessage()가 만드는 placeholder 형식과 맞춰야 한다.
_QUOTE_IMAGE_MARKER_RE = re.compile(r'^\[인용된 이미지[^\]|]*\|([A-Za-z0-9_]+)\]')

router = APIRouter()

MAX_CHAT_MESSAGES = 100
MAX_CHAT_MESSAGE_CHARS = 100_000
MAX_CHAT_IMAGE_BASE64_CHARS = 16 * 1024 * 1024


class ChatMessage(BaseModel):
    role: str = Field(max_length=32)
    content: str = Field(max_length=MAX_CHAT_MESSAGE_CHARS)

class ChatRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128)
    messages: List[ChatMessage] = Field(max_length=MAX_CHAT_MESSAGES)
    # 캡처 모드로 첨부한 이미지의 raw base64(PNG, data URL 접두사 없음). 있으면
    # 이번 질문(messages의 마지막 user 메시지)에 실제로 첨부해 vision 지원
    # provider(openai/gemini/claude)가 캡처 영역을 직접 보고 답할 수 있게 한다.
    image_base64: Optional[str] = Field(default=None, max_length=MAX_CHAT_IMAGE_BASE64_CHARS)
    current_page: Optional[int] = Field(default=None, ge=1)
    selected_text: Optional[str] = Field(default=None, max_length=20_000)
    screen_context: Optional["ScreenContext"] = None
    verify_evidence: bool = False


class ScreenContext(BaseModel):
    mode: Literal["viewer", "standalone"] = "viewer"
    page_num: Optional[int] = Field(default=None, ge=1)
    include_visual: Optional[bool] = None


ChatRequest.model_rebuild()

# ── 여러 논문 간 비교 채팅 ──────────────────────────────
MIN_COMPARE_DOCS = 2
MAX_COMPARE_DOCS = 5
# 논문 한 편당 컨텍스트가 너무 짧아지지 않도록, 전체 예산을 문서 수로 나눈다
# (단일 논문 채팅의 40,000자 예산보다 넉넉하게 잡되 무한정 늘리지는 않는다).
COMPARE_TOTAL_CONTEXT_CHARS = 60000

class CompareChatRequest(BaseModel):
    doc_ids: List[str]
    messages: List[ChatMessage] = Field(max_length=MAX_CHAT_MESSAGES)


def _build_compare_id(doc_ids: List[str]) -> str:
    """문서 ID 조합에서 결정론적인 비교 세션 ID를 만든다 - 같은 조합을 어떤
    순서로 선택하든 동일한 채팅 기록/CLI 대화 세션을 재사용하기 위함."""
    key = ":".join(sorted(doc_ids))
    return "cmp_" + hashlib.sha256(key.encode()).hexdigest()[:20]

def _dedupe_preserve_order(items: List[str]) -> List[str]:
    return list(dict.fromkeys(items))

_VISUAL_QUESTION_RE = re.compile(
    r"(?:이 페이지|그림|도표|(?<![가-힣])표(?:\s*\d+|[을를이가의에서])?(?![가-힣])|차트|수식|이미지|figure|diagram|table|chart|equation|this page)",
    re.IGNORECASE,
)
_MAX_RENDERED_PAGE_IMAGE_CHARS = 12 * 1024 * 1024


def _provider_supports_vision(provider: str, model: str) -> bool:
    provider = (provider or "").lower()
    if provider in {"openai", "gemini", "claude", "antigravity", "claude_code", "codex"}:
        return True
    if provider != "ollama":
        return False
    normalized_model = (model or "").lower().replace("-", "").replace("_", "")
    return any(name in normalized_model for name in ("llava", "gemma3", "qwen2.5vl", "qwen25vl", "minicpmv", "bakllava"))


def _sse(event: str, payload: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def _semantic_verify_answer(answer: str, evidence: list[dict], session_id: str) -> dict:
    if not evidence:
        return {"mode": "structural_only", "status": "no_cited_evidence"}
    evidence_lines = []
    for item in evidence:
        evidence_id = item.get("evidence_id")
        page_num = item.get("page_num")
        quote = item.get("quote") or ""
        evidence_lines.append(f"[{evidence_id}] Page {page_num}: {quote[:1200]}")
    evidence_text = "\n\n".join(evidence_lines)
    prompt = (
        "Check whether each factual claim in the answer is supported by the supplied evidence. "
        "Return a compact JSON object with status (supported, mixed, or unsupported) and issues.\n\n"
        f"ANSWER:\n{answer[:12000]}\n\nEVIDENCE:\n{evidence_text}"
    )
    chunks = []
    try:
        async for token in stream_chat(
            "You are an evidence verification model. Do not use outside knowledge.",
            [{"role": "user", "content": prompt}],
            session_id=f"{session_id}/evidence_verification",
        ):
            chunks.append(token)
            if sum(len(chunk) for chunk in chunks) > 8000:
                break
        return {"mode": "semantic_model", "status": "completed", "result": "".join(chunks).strip()}
    except Exception as exc:
        return {"mode": "structural_only", "status": "semantic_unavailable", "detail": str(exc)[:300]}


@router.post("/chat/stream")
async def chat_stream(data: ChatRequest, current_user: str = Depends(get_current_user)):
    session_id = data.session_id
    session = require_session_owner(session_id, current_user)
    from services.processing_policy import ensure_processing_allowed, provider_is_local
    ensure_processing_allowed(session, "chat")

    latest_question = data.messages[-1].content if data.messages else ""
    screen = data.screen_context
    viewer_mode = bool(screen and screen.mode == "viewer") or (screen is None and data.current_page is not None)
    current_page = ((screen.page_num or data.current_page) if screen else data.current_page) if viewer_mode else None
    pages = session.get("pages", [])
    total_pages = max((int(page.get("page_num") or 0) for page in pages), default=0)
    if current_page and current_page > total_pages:
        raise HTTPException(status_code=400, detail={
            "code": "screen_page_out_of_range",
            "params": {"page_num": current_page, "total_pages": total_pages},
            "fallback": "The requested viewer page is outside this document.",
        })
    enforce_rate_limit("chat", current_user)
    from time import perf_counter
    from services.context_retrieval import retrieve_context
    retrieval_started = perf_counter()
    context_result = retrieve_context(
        session_id, pages, latest_question, current_page=current_page,
        selected_text=data.selected_text,
        content_revision=int(session.get("content_revision") or 1),
    )
    paper_text = context_result.text
    from services.observability import record_document_mode_event
    document_mode = session.get("document_mode", "research")
    document_type = session.get("document_type", "research_paper")
    record_document_mode_event(
        current_user, "chat_retrieval", document_mode, document_type,
        duration_ms=round((perf_counter() - retrieval_started) * 1000),
        numeric_value=context_result.retrieval_count, status=context_result.strategy,
    )

    from config import get_chat_model, get_chat_provider
    provider = get_chat_provider()
    model = get_chat_model()
    visual_requested = bool(screen and screen.include_visual is True)
    visual_auto = bool(screen and screen.include_visual is None and _VISUAL_QUESTION_RE.search(latest_question))
    should_attach_visual = viewer_mode and bool(current_page) and (visual_requested or visual_auto)
    page_image = data.image_base64
    visual_included = bool(page_image)
    visual_reason = "quoted_image" if page_image else None
    if should_attach_visual and not page_image:
        if not _provider_supports_vision(provider, model):
            visual_reason = "vision_not_supported"
        else:
            from services.pdf_parser import render_page_image_base64
            rendered = await asyncio.to_thread(
                render_page_image_base64, session["pdf_path"], int(current_page), 1.25,
            )
            if rendered and len(rendered) <= _MAX_RENDERED_PAGE_IMAGE_CHARS:
                page_image = rendered
                visual_included = True
                visual_reason = "manual" if visual_requested else "visual_question"
            else:
                visual_reason = "image_too_large" if rendered else "render_failed"

    from services.document_policy import build_assistant_prompt
    filename = session.get("filename", "알 수 없음")
    system_prompt = build_assistant_prompt(document_mode, document_type, filename, paper_text)
    system_prompt += (
        "\n\n[EVIDENCE CITATION RULES]\n"
        "Every factual claim based on the document must cite one or more supplied evidence IDs exactly as [E:ev_...]. "
        "Never invent an evidence ID. Numeric claims always require a citation. If evidence is insufficient, say so."
    )
    history_messages = [{"role": msg.role, "content": msg.content} for msg in data.messages]

    question_chat_id = None
    if data.messages:
        latest_msg = data.messages[-1]
        question_chat_id = db_save_chat_message(session_id, latest_msg.role, latest_msg.content)
        if data.image_base64:
            marker_match = _QUOTE_IMAGE_MARKER_RE.match(latest_msg.content)
            if marker_match:
                try:
                    save_chat_quote_image(session_id, marker_match.group(1), data.image_base64)
                except Exception as exc:
                    print(f"[chat_stream] quoted image save failed ({session_id}): {exc}")

    async def event_generator():
        context_payload = {
            "mode": "viewer" if viewer_mode else "standalone",
            "page_num": current_page,
            "current_page_text_included": bool(viewer_mode and current_page in context_result.evidence_pages),
            "visual_included": visual_included,
            "visual_reason": visual_reason,
            "provider": provider,
            "evidence_count": len(context_result.evidence),
        }
        yield _sse("context", context_payload)
        try:
            full_response = []
            async for token in stream_chat(
                system_prompt, history_messages, session_id=session_id, page_image_b64=page_image,
            ):
                full_response.append(token)
            from services.context_retrieval import validate_evidence_citations
            assistant_content, cited_evidence, verification = validate_evidence_citations(
                "".join(full_response).strip(), context_result.evidence,
            )
            for item in cited_evidence:
                translated_page = db_get_translation(
                    session_id, int(item["page_num"]), fallback=True,
                    content_revision=int(item["content_revision"]),
                )
                if translated_page:
                    item["translation_quote"] = translated_page.strip()[:800]
            verify_requested = data.verify_evidence or bool(verification["risks"]) or bool(
                re.search(r"근거\s*검증|verify\s+(?:the\s+)?evidence", latest_question, re.IGNORECASE)
            )
            if verify_requested:
                local_only = session.get("processing_policy") == "local_only"
                if local_only and (not provider_is_local(provider) or not model):
                    verification["semantic"] = {
                        "mode": "structural_only",
                        "status": "no_allowed_local_verifier",
                    }
                else:
                    verification["semantic"] = await _semantic_verify_answer(
                        assistant_content, cited_evidence, session_id,
                    )
            else:
                verification["semantic"] = {"mode": "not_run", "status": "not_required"}
            record_document_mode_event(
                current_user, "chat_citation", document_mode, document_type,
                status=verification["status"], numeric_value=len(verification["risks"]),
            )
            for offset in range(0, len(assistant_content), 240):
                yield _sse("answer", {"delta": assistant_content[offset:offset + 240]})
            answer_chat_id = None
            if assistant_content:
                answer_chat_id = db_save_chat_message(session_id, "assistant", assistant_content)
                if answer_chat_id is not None:
                    db_save_chat_verification(answer_chat_id, verification)
                    db_save_chat_evidence(answer_chat_id, session_id, cited_evidence, verification)
                if question_chat_id is not None and document_mode == "research":
                    from services.knowledge_graph import sync_question_for_graph
                    asyncio.create_task(sync_question_for_graph(question_chat_id, session_id, latest_msg.content))
            yield _sse("evidence", {"answer_message_id": answer_chat_id, "items": cited_evidence})
            yield _sse("verification", verification)
            yield _sse("done", {"answer_message_id": answer_chat_id})
        except Exception as exc:
            yield _sse("error", {"code": "chat_stream_failed", "message": str(exc)})
            yield _sse("done", {"failed": True})

    return StreamingResponse(
        event_generator(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@router.post("/chat/suggestions")
async def chat_suggestions(data: ChatRequest, current_user: str = Depends(get_current_user)):
    """직전 어시스턴트 답변과 논문 본문을 참고해 후속 질문 3개를 추천합니다. 채팅
    기록(chats 테이블)에는 남기지 않는 보조 UI(추천 질문 칩) 전용 엔드포인트입니다."""
    session_id = data.session_id
    session = require_session_owner(session_id, current_user)
    from services.processing_policy import ensure_processing_allowed
    ensure_processing_allowed(session, "chat")
    enforce_rate_limit("chat", current_user)

    pages = session.get("pages", [])
    history_messages = [{"role": msg.role, "content": msg.content} for msg in data.messages]
    latest_question = data.messages[-1].content if data.messages else ""
    from services.context_retrieval import retrieve_context
    paper_text = retrieve_context(
        session_id, pages, latest_question, current_page=data.current_page,
        selected_text=data.selected_text, budget=6000, max_chunks=5,
    ).text

    filename = session.get("filename", "알 수 없음")

    try:
        questions = await generate_suggested_questions(
            paper_text, history_messages, doc_title=filename, session_id=session_id,
            document_mode=session.get("document_mode", "research"),
            document_type=session.get("document_type", "research_paper"),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"추천 질문 생성 실패: {str(e)}")

    return {"questions": questions}


# 아래 두 엔드포인트(/chat/compare/*)는 "/chat/{session_id}/history"보다
# 반드시 먼저 등록해야 한다 - 그렇지 않으면 "compare"가 session_id 경로
# 파라미터로 잡아먹혀 이 라우트에 절대 도달하지 못한다.
@router.post("/chat/compare/stream")
async def chat_compare_stream(data: CompareChatRequest, current_user: str = Depends(get_current_user)):
    """여러 논문을 함께 컨텍스트로 제공해, 논문 간 비교/종합 질문에 답하는
    스트리밍 채팅입니다.
    """
    doc_ids = _dedupe_preserve_order(data.doc_ids)
    if len(doc_ids) < MIN_COMPARE_DOCS or len(doc_ids) > MAX_COMPARE_DOCS:
        raise HTTPException(
            status_code=400,
            detail=f"비교 채팅은 논문을 {MIN_COMPARE_DOCS}~{MAX_COMPARE_DOCS}편 선택해야 합니다.",
        )

    docs = require_owned_documents(doc_ids, current_user)
    from services.processing_policy import ensure_documents_processing_allowed
    ensure_documents_processing_allowed(docs, "chat")
    enforce_rate_limit("chat", current_user)

    per_doc_budget = COMPARE_TOTAL_CONTEXT_CHARS // len(doc_ids)
    paper_blocks = []
    titles = []
    for idx, (doc_id, doc) in enumerate(zip(doc_ids, docs), start=1):
        if not ensure_session(doc_id):
            raise HTTPException(status_code=404, detail=f"'{doc.get('filename')}' 문서를 불러올 수 없습니다.")

        title = (doc.get("metadata") or {}).get("title") or doc.get("filename", "제목 없음")
        titles.append(title)

        pages = sessions[doc_id].get("pages", [])
        paper_text = ""
        for p in pages:
            page_text = (p.get("text", "") or "").strip()
            if page_text:
                paper_text += f"\n\n--- Page {p.get('page_num', 0)} ---\n{page_text}"
        if len(paper_text) > per_doc_budget:
            paper_text = paper_text[:per_doc_budget] + "\n\n[이하 본문 생략]"

        paper_blocks.append(f"\n\n===== 논문 {idx}: {title} =====\n{paper_text}")

    compare_id = _build_compare_id(doc_ids)
    db_upsert_compare_session(compare_id, current_user, doc_ids)
    titles_list = "\n".join(f"- 논문 {i}: {t}" for i, t in enumerate(titles, start=1))
    combined_context = "".join(paper_blocks)

    system_prompt = f"""당신은 여러 학술 논문을 비교 분석하는 세계 최고 권위 전문가(Expert Assistant)입니다.
아래에 서로 다른 {len(doc_ids)}편의 논문 본문이 순서대로 제공됩니다.

[비교 대상 논문 목록]
{titles_list}

[논문 본문 컨텍스트]
{combined_context}

[답변 가이드라인]
1. 여러 논문에 걸친 질문에는 반드시 "논문 1", "논문 2"처럼 번호로 어느 논문의 내용인지 명시하며 비교/대조하세요.
2. 제공된 논문 본문에 없는 내용이라면 그렇게 명시하고, 일반적인 AI 지식으로 부가 설명을 덧붙이세요.
3. 한국어로 답변하되, 전문 학술 용어는 원어와 번역을 함께 병기하세요(예: 심층 학습(Deep Learning)).
4. 수식이나 기호가 포함된 경우 Markdown 수식(LaTeX: $ 또는 $$) 형식으로 명확히 표현하세요.
5. 친절하고 신뢰감 있는 학술 전문가 톤앤매너로 답변하세요.
"""

    history_messages = [{"role": msg.role, "content": msg.content} for msg in data.messages]

    question_chat_id = None
    if data.messages:
        latest_msg = data.messages[-1]
        question_chat_id = db_save_chat_message(compare_id, latest_msg.role, latest_msg.content)

    async def event_generator():
        yield " "
        full_response = []
        try:
            async for token in stream_chat(system_prompt, history_messages, session_id=compare_id):
                full_response.append(token)
                yield token

            assistant_content = "".join(full_response).strip()
            if assistant_content:
                db_save_chat_message(compare_id, "assistant", assistant_content)
                if question_chat_id is not None:
                    from services.knowledge_graph import sync_question_for_graph
                    asyncio.create_task(
                        sync_question_for_graph(question_chat_id, compare_id, latest_msg.content)
                    )
        except Exception as e:
            yield f"\n[오류 발생: {str(e)}]"

    return StreamingResponse(
        event_generator(),
        media_type="text/plain",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        }
    )


@router.get("/chat/compare/history")
async def get_compare_chat_history(doc_ids: str, current_user: str = Depends(get_current_user)):
    """콤마로 구분된 문서 ID 조합에 대한 비교 채팅 히스토리를 반환합니다."""
    ids = _dedupe_preserve_order([d.strip() for d in doc_ids.split(",") if d.strip()])
    if len(ids) < MIN_COMPARE_DOCS or len(ids) > MAX_COMPARE_DOCS:
        raise HTTPException(
            status_code=400,
            detail=f"비교 채팅은 논문을 {MIN_COMPARE_DOCS}~{MAX_COMPARE_DOCS}편 선택해야 합니다.",
        )
    require_owned_documents(ids, current_user)
    compare_id = _build_compare_id(ids)
    history = db_get_chat_history(compare_id)
    return {"history": history, "compare_id": compare_id}


@router.get("/chat/sessions")
async def get_chat_sessions(document_mode: Optional[str] = None, current_user: str = Depends(get_current_user)):
    """현재 사용자가 AI 어시스턴트(단일 논문) 기능으로 나눈 채팅 세션 목록을
    최근 대화 순으로 반환합니다."""
    sessions = db_list_assistant_chat_sessions(current_user, document_mode=document_mode)
    return {"sessions": sessions}


@router.get("/chat/compare-sessions")
async def get_compare_chat_sessions(current_user: str = Depends(get_current_user)):
    """현재 사용자가 논문 비교 기능으로 나눈 채팅 세션 목록을 최근 대화 순으로
    반환합니다."""
    sessions = db_list_compare_chat_sessions(current_user)
    return {"sessions": sessions}


@router.get("/chat/{session_id}/history")
async def get_chat_history(session_id: str, current_user: str = Depends(get_current_user)):
    """특정 문서의 이전 채팅 히스토리를 반환합니다."""
    require_session_owner(session_id, current_user)
    history = db_get_chat_history(session_id, include_revision=True)
    return {"history": history}
