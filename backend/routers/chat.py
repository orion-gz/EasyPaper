import asyncio
import hashlib
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Optional

from routers.upload import sessions, ensure_session, require_session_owner
from services.llm_client import stream_chat, generate_suggested_questions
from services.db import (
    db_save_chat_message,
    db_get_chat_history,
    db_list_assistant_chat_sessions,
    db_upsert_compare_session,
    db_list_compare_chat_sessions,
)
from services.library import get_document as lib_get_document
from services.auth import get_current_user

router = APIRouter()

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    session_id: str
    messages: List[ChatMessage]
    # 캡처 모드로 첨부한 이미지의 raw base64(PNG, data URL 접두사 없음). 있으면
    # 이번 질문(messages의 마지막 user 메시지)에 실제로 첨부해 vision 지원
    # provider(openai/gemini/claude)가 캡처 영역을 직접 보고 답할 수 있게 한다.
    image_base64: Optional[str] = None

# ── 여러 논문 간 비교 채팅 ──────────────────────────────
MIN_COMPARE_DOCS = 2
MAX_COMPARE_DOCS = 5
# 논문 한 편당 컨텍스트가 너무 짧아지지 않도록, 전체 예산을 문서 수로 나눈다
# (단일 논문 채팅의 40,000자 예산보다 넉넉하게 잡되 무한정 늘리지는 않는다).
COMPARE_TOTAL_CONTEXT_CHARS = 60000

class CompareChatRequest(BaseModel):
    doc_ids: List[str]
    messages: List[ChatMessage]


def _build_compare_id(doc_ids: List[str]) -> str:
    """문서 ID 조합에서 결정론적인 비교 세션 ID를 만든다 - 같은 조합을 어떤
    순서로 선택하든 동일한 채팅 기록/CLI 대화 세션을 재사용하기 위함."""
    key = ":".join(sorted(doc_ids))
    return "cmp_" + hashlib.sha256(key.encode()).hexdigest()[:20]


def _require_owned_documents(doc_ids: List[str], current_user: str) -> List[dict]:
    """모든 문서가 존재하고 현재 사용자 소유인지 확인한다. 하나라도 아니면
    (다른 사용자 문서인지, 존재하지 않는지 구분하지 않고) 404로 응답한다."""
    docs = []
    for doc_id in doc_ids:
        doc = lib_get_document(doc_id)
        if not doc or doc.get("username") != current_user:
            raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다.")
        docs.append(doc)
    return docs


def _dedupe_preserve_order(items: List[str]) -> List[str]:
    return list(dict.fromkeys(items))

@router.post("/chat/stream")
async def chat_stream(data: ChatRequest, current_user: str = Depends(get_current_user)):
    """
    논문 내용을 기반으로 AI 전문가와 챗을 진행하고 실시간 스트리밍 답변을 반환합니다.
    """
    session_id = data.session_id
    session = require_session_owner(session_id, current_user)

    # 세션 내의 모든 페이지에서 텍스트 수집
    pages = session.get("pages", [])
    paper_text = ""
    for p in pages:
        page_num = p.get("page_num", 0)
        page_text = p.get("text", "").strip()
        if page_text:
            paper_text += f"\n\n--- Page {page_num} ---\n{page_text}"

    # 컨텍스트 길이 제약 (최대 40,000자, 약 8,000~10,000 토큰 내외로 유지)
    if len(paper_text) > 40000:
        paper_text = paper_text[:40000] + "\n\n[이하 본문 생략]"

    filename = session.get("filename", "알 수 없음")

    system_prompt = f"""당신은 업로드된 학술 논문 연구 분야의 세계 최고 권위 전문가(Expert Assistant)입니다. 
당신에게는 해당 논문의 전체 또는 핵심 텍스트 내용이 컨텍스트로 제공됩니다.

[논문 제목: {filename}]

[논문 본문 컨텍스트]
{paper_text}

[답변 가이드라인]
1. 반드시 제공된 [논문 본문 컨텍스트]에 기반하여 질문에 답변하세요.
2. 만약 제공된 정보에 없는 내용이라면, 논문 내용에 없다고 명시적으로 언급하고 일반적인 AI 지식으로 부가 설명을 덧붙이세요.
3. 한국어로 번역 또는 설명하되, 전문 학술 용어는 원어(영어 등)와 번역을 함께 병기하여(예: 심층 학습(Deep Learning)) 설명의 정확도를 높이세요.
4. 수식이나 기호가 포함된 경우 Markdown 수식(LaTeX: $ 또는 $$) 형식으로 명확히 표현하세요.
5. 친절하고 신뢰감 있는 학술 전문가 톤앤매너로 대답해주세요.
"""

    history_messages = [{"role": msg.role, "content": msg.content} for msg in data.messages]

    # Save user message to database
    question_chat_id = None
    if data.messages:
        latest_msg = data.messages[-1]
        question_chat_id = db_save_chat_message(session_id, latest_msg.role, latest_msg.content)

    async def event_generator():
        yield " "
        full_response = []
        try:
            async for token in stream_chat(
                system_prompt, history_messages, session_id=session_id,
                page_image_b64=data.image_base64
            ):
                full_response.append(token)
                yield token

            # Save assistant response to database
            assistant_content = "".join(full_response).strip()
            if assistant_content:
                db_save_chat_message(session_id, "assistant", assistant_content)
                # 지식 그래프: 이 질문을 논문의 기존 개념과 연결한다(fire-and-forget -
                # 실패해도 채팅 응답 자체에는 영향 없음).
                if question_chat_id is not None:
                    from services.knowledge_graph import sync_question_for_graph
                    asyncio.create_task(
                        sync_question_for_graph(question_chat_id, session_id, latest_msg.content)
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


@router.post("/chat/suggestions")
async def chat_suggestions(data: ChatRequest, current_user: str = Depends(get_current_user)):
    """직전 어시스턴트 답변과 논문 본문을 참고해 후속 질문 3개를 추천합니다. 채팅
    기록(chats 테이블)에는 남기지 않는 보조 UI(추천 질문 칩) 전용 엔드포인트입니다."""
    session_id = data.session_id
    session = require_session_owner(session_id, current_user)

    pages = session.get("pages", [])
    paper_text = ""
    for p in pages:
        page_text = (p.get("text", "") or "").strip()
        if page_text:
            paper_text += f"\n\n{page_text}"
            if len(paper_text) > 6000:
                break

    filename = session.get("filename", "알 수 없음")
    history_messages = [{"role": msg.role, "content": msg.content} for msg in data.messages]

    try:
        questions = await generate_suggested_questions(
            paper_text, history_messages, doc_title=filename, session_id=session_id
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

    docs = _require_owned_documents(doc_ids, current_user)

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
    _require_owned_documents(ids, current_user)
    compare_id = _build_compare_id(ids)
    history = db_get_chat_history(compare_id)
    return {"history": history, "compare_id": compare_id}


@router.get("/chat/sessions")
async def get_chat_sessions(current_user: str = Depends(get_current_user)):
    """현재 사용자가 AI 어시스턴트(단일 논문) 기능으로 나눈 채팅 세션 목록을
    최근 대화 순으로 반환합니다."""
    sessions = db_list_assistant_chat_sessions(current_user)
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
    history = db_get_chat_history(session_id)
    return {"history": history}
