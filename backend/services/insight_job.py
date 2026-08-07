"""자동 페이지 인사이트 작업 관리자.

번역 작업과 독립적으로 키워드·단어 설명과 페이지 요약을 생성해 기존
page_insights 캐시에 저장한다. 자동 생성 여부는 이 모듈에서만 설정값을 읽는다.
"""

import asyncio

from services.library import get_page_insight, save_page_insight
from services.llm_client import stream_page_insight


_running_tasks: dict[tuple[str, str], asyncio.Task] = {}


def start_keyword_job(
    session_id: str,
    pages: list,
    target_lang: str,
    doc_title: str,
) -> None:
    """페이지별 키워드·단어 자동 생성 작업을 시작한다."""
    _start_insight_job(session_id, pages, target_lang, doc_title, "keywords")


def start_summary_job(
    session_id: str,
    pages: list,
    target_lang: str,
    doc_title: str,
) -> None:
    """페이지별 요약 자동 생성 작업을 시작한다."""
    _start_insight_job(session_id, pages, target_lang, doc_title, "summary")


def _start_insight_job(
    session_id: str,
    pages: list,
    target_lang: str,
    doc_title: str,
    kind: str,
) -> None:
    task_key = (session_id, kind)
    previous_task = _running_tasks.get(task_key)
    if previous_task:
        previous_task.cancel()

    task = asyncio.create_task(
        _run_insight_job(session_id, pages, target_lang, doc_title, kind, task_key)
    )
    _running_tasks[task_key] = task


async def _run_insight_job(
    session_id: str,
    pages: list,
    target_lang: str,
    doc_title: str,
    kind: str,
    task_key: tuple[str, str],
) -> None:
    """한 종류의 인사이트를 페이지별로 순차 생성한다."""
    try:
        for page_data in pages:
            page_num = page_data["page_num"]
            text = page_data.get("text", "").strip()
            if not text:
                continue

            if get_page_insight(session_id, page_num, kind, target_lang):
                continue
            try:
                result = []
                async for token in stream_page_insight(
                    kind,
                    text,
                    target_lang=target_lang,
                    doc_title=doc_title,
                    session_id=session_id,
                ):
                    result.append(token)
                content = "".join(result).strip()
                if content:
                    save_page_insight(session_id, page_num, kind, content, target_lang)
            except Exception as exc:
                # 한 페이지 실패가 해당 종류의 나머지 생성을 막지 않는다.
                print(f"[Insight {session_id}] {kind} generation failed on page {page_num}: {exc}")
    except asyncio.CancelledError:
        raise
    finally:
        if _running_tasks.get(task_key) is asyncio.current_task():
            _running_tasks.pop(task_key, None)
