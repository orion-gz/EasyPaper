from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List

from routers.upload import sessions, ensure_session
from services.llm_client import stream_chat
from services.db import db_save_chat_message, db_get_chat_history

router = APIRouter()

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    session_id: str
    messages: List[ChatMessage]

@router.post("/chat/stream")
async def chat_stream(data: ChatRequest):
    """
    논문 내용을 기반으로 AI 전문가와 챗을 진행하고 실시간 스트리밍 답변을 반환합니다.
    """
    session_id = data.session_id
    if not ensure_session(session_id):
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다.")

    session = sessions[session_id]
    
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
    if data.messages:
        latest_msg = data.messages[-1]
        db_save_chat_message(session_id, latest_msg.role, latest_msg.content)

    async def event_generator():
        yield " "
        full_response = []
        try:
            async for token in stream_chat(system_prompt, history_messages):
                full_response.append(token)
                yield token
            
            # Save assistant response to database
            assistant_content = "".join(full_response).strip()
            if assistant_content:
                db_save_chat_message(session_id, "assistant", assistant_content)
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


@router.get("/chat/{session_id}/history")
async def get_chat_history(session_id: str):
    """특정 문서의 이전 채팅 히스토리를 반환합니다."""
    if not ensure_session(session_id):
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다.")
    history = db_get_chat_history(session_id)
    return {"history": history}
