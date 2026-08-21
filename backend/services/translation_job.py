"""
백그라운드 번역 잡 매니저

업로드 직후 asyncio 태스크로 전 페이지를 순차 번역합니다.
서버를 종료해도 library/ 에 진행상황이 저장되어 재시작 시 이어서 할 수 있습니다.
"""

import asyncio
import json
import os
from datetime import datetime, timezone
from typing import Optional

from config import LIBRARY_DIR, get_trans_provider
from services.atomic_io import atomic_write_text
from services.chunker import split_into_chunks, align_sentences, tag_source_text, parse_tagged_translation
from services.llm_client import stream_translation
from services.library import save_translation, get_translation, get_translation_full, get_document, get_pdf_path
from services.pdf_parser import render_page_image_base64

# 수식(LaTeX) 번역 정확도를 위해 페이지 이미지를 함께 첨부할 수 있는 provider.
# CLI 기반 provider(antigravity/claude_code/codex)와 로컬 ollama는 이 코드베이스의
# 추상화 계층에서 아직 이미지 첨부를 지원하지 않는다.
_VISION_CAPABLE_PROVIDERS = ("openai", "gemini", "claude")

# 메모리 내 활성 잡 ( session_id → asyncio.Task )
_running_tasks: dict[str, asyncio.Task] = {}


# ─────────────────────────────────────────────────────────
#  잡 상태 파일
# ─────────────────────────────────────────────────────────

def _job_path(session_id: str) -> str:
    return os.path.join(LIBRARY_DIR, session_id, "job_status.json")


def _load_job(session_id: str) -> Optional[dict]:
    path = _job_path(session_id)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_job(session_id: str, job: dict) -> None:
    path = _job_path(session_id)
    atomic_write_text(path, json.dumps(job, ensure_ascii=False, indent=2))


# ─────────────────────────────────────────────────────────
#  퍼블릭 API
# ─────────────────────────────────────────────────────────

def get_job_status(session_id: str) -> Optional[dict]:
    """잡 상태를 반환합니다."""
    return _load_job(session_id)


def start_job(
    session_id: str,
    pages: list,
    target_lang: str = "한국어",
    style: str = "academic",
    ignore_math: bool = False,
    ignore_table: bool = True,
    ignore_refs: bool = False,
    page_numbers: Optional[list[int]] = None,
) -> dict:
    """
    백그라운드 번역 잡을 시작합니다.
    이미 진행 중이거나 완료된 잡이 있으면 기존 상태를 반환합니다.
    """
    existing = _load_job(session_id)
    available_pages = {page["page_num"] for page in pages}
    target_pages = sorted(
        available_pages if page_numbers is None
        else available_pages.intersection(page_numbers)
    )
    if not target_pages:
        raise ValueError("번역할 페이지가 없습니다.")

    # 이미 동일한 옵션으로 완료된 잡이면 재시작하지 않음
    if existing and existing.get("status") == "completed":
        opts = existing.get("options", {})
        if (opts.get("target_lang") == target_lang and
            opts.get("style") == style and
            opts.get("ignore_math") == ignore_math and
            opts.get("ignore_table") == ignore_table and
            opts.get("ignore_refs") == ignore_refs and
            existing.get("target_pages", sorted(available_pages)) == target_pages):
            return existing

    # 아직 실행 중인 태스크가 있으면 먼저 취소(Restart 대응)
    if session_id in _running_tasks:
        _running_tasks[session_id].cancel()

    # 새 잡 세팅
    job = {
        "session_id": session_id,
        "status": "running",
        "total_pages": len(target_pages),
        "target_pages": target_pages,
        "completed_pages": [],
        "failed_pages": [],
        "options": {
            "target_lang": target_lang,
            "style": style,
            "ignore_math": ignore_math,
            "ignore_table": ignore_table,
            "ignore_refs": ignore_refs,
        },
        "started_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    _save_job(session_id, job)

    task = asyncio.create_task(_run_job(session_id, pages, job))
    _running_tasks[session_id] = task
    return job


def cancel_job(session_id: str) -> bool:
    """진행 중인 잡이 있으면 취소합니다."""
    cancelled = False
    if session_id in _running_tasks:
        _running_tasks[session_id].cancel()
        cancelled = True
    
    # status 파일 상에서도 cancelled 로 마킹
    job = _load_job(session_id)
    if job and job.get("status") == "running":
        job["status"] = "cancelled"
        _save_job(session_id, job)
        cancelled = True
        
    return cancelled


def resume_incomplete_jobs(sessions: dict) -> None:
    """
    서버 시작 시 미완료 잡을 재개합니다.
    upload.py 의 restore_sessions_from_library() 이후 호출됩니다.
    """
    for session_id, session in sessions.items():
        job = _load_job(session_id)
        if job and job.get("status") == "running":
            pages = session.get("pages", [])
            if pages:
                task = asyncio.create_task(_run_job(session_id, pages, job))
                _running_tasks[session_id] = task


# ─────────────────────────────────────────────────────────
#  내부 번역 루프
# ─────────────────────────────────────────────────────────

async def _run_job(session_id: str, pages: list, job: dict) -> None:
    """모든 페이지를 순차적으로 번역합니다."""
    options = job.get("options", {})
    target_lang = options.get("target_lang", "한국어")
    style = options.get("style", "academic")
    ignore_math = options.get("ignore_math", False)
    ignore_table = options.get("ignore_table", True)
    ignore_refs = options.get("ignore_refs", False)

    # 저장된 분류가 번역 정책과 캐시 키의 유일한 기준이다.
    doc_title = ""
    document_mode = "research"
    document_type = "research_paper"
    try:
        doc = get_document(session_id)
        if doc:
            doc_title = doc.get("metadata", {}).get("title") or doc.get("filename", "")
            document_mode = doc.get("document_mode", "research")
            document_type = doc.get("document_type", "research_paper")
    except Exception as e:
        print(f"[Job {session_id}] Failed to get document title: {e}")

    from services.document_policy import translation_cache_candidates
    suffix_candidates = translation_cache_candidates(
        document_mode, document_type, target_lang, style,
        ignore_math, ignore_table, ignore_refs,
    )
    suffix = suffix_candidates[0]
    target_page_numbers = set(job.get("target_pages") or [page["page_num"] for page in pages])
    job_pages = [page for page in pages if page["page_num"] in target_page_numbers]
    job["target_pages"] = sorted(target_page_numbers)

    # vision을 지원하는 provider면 페이지별로 원본 이미지를 함께 보내 수식(LaTeX)
    # 재현 정확도를 높인다 - ignore_math면 애초에 수식을 생략하므로 렌더링하지 않는다.
    pdf_path = get_pdf_path(session_id) if (get_trans_provider() in _VISION_CAPABLE_PROVIDERS and not ignore_math) else None

    # 이미 완료된 페이지들을 루프 돌기 전 한 번에 스캔하여 저장
    scanned_any = False
    for page_data in job_pages:
        page_num = page_data["page_num"]
        cached = None
        cached_suffix = suffix
        for candidate_suffix in suffix_candidates:
            candidate = get_translation_full(
                session_id, page_num, candidate_suffix, fallback=False,
            )
            if candidate.get("translation"):
                cached = candidate
                cached_suffix = candidate_suffix
                break
        if cached is not None:
            # 기존 연구 문서의 구버전 캐시는 한 번만 새 정책 키로 승격해 이후
            # 페이지 조회·전체 MD 생성도 정확한 키만 사용하게 한다.
            if cached_suffix != suffix:
                save_translation(
                    session_id, page_num,
                    json.dumps(cached, ensure_ascii=False), suffix,
                )
                _save_page_md(session_id, page_num, cached["translation"], suffix)
            if page_num not in job["completed_pages"]:
                job["completed_pages"].append(page_num)
                scanned_any = True

    if scanned_any:
        job["updated_at"] = datetime.now(timezone.utc).isoformat()
        _save_job(session_id, job)

    try:
        for page_data in job_pages:
            page_num = page_data["page_num"]

            # 이미 완료된 페이지는 스킵 (동일 옵션의 영구 저장 확인)
            if get_translation(session_id, page_num, suffix, fallback=False) is not None:
                if page_num not in job["completed_pages"]:
                    job["completed_pages"].append(page_num)
                    _save_job(session_id, job)
                continue

            text = page_data.get("text", "").strip()

            # 이전 페이지 번역 가져오기
            prev_context = ""
            if page_num > 1:
                try:
                    prev_context = get_translation(session_id, page_num - 1, suffix, fallback=False) or ""
                except Exception:
                    pass

            # 페이지 원본 이미지 렌더링 (vision 지원 provider + 수식 번역 대상인 경우만)
            page_image_b64 = None
            if pdf_path:
                try:
                    page_image_b64 = render_page_image_base64(pdf_path, page_num)
                except Exception as e:
                    print(f"[Job {session_id}] page {page_num} 이미지 렌더링 실패(텍스트만 사용): {e}")

            try:
                # 원문 태깅 처리
                tagged_text, src_sentences = tag_source_text(text)

                translation = await _translate_page(
                    tagged_text,
                    target_lang=target_lang,
                    style=style,
                    ignore_math=ignore_math,
                    ignore_table=ignore_table,
                    ignore_refs=ignore_refs,
                    doc_title=doc_title,
                    prev_context=prev_context,
                    session_id=session_id,
                    page_num=page_num,
                    document_mode=document_mode,
                    document_type=document_type,
                    page_image_b64=page_image_b64
                )
                # 태그 분석 및 매핑 생성
                cleaned_translation, sentences = parse_tagged_translation(translation, src_sentences)
                if document_mode == "general":
                    from services.translation_quality import assert_translation_integrity
                    assert_translation_integrity(text, cleaned_translation)
                payload_data = {
                    "translation": cleaned_translation,
                    "sentences": sentences
                }
                payload_json = json.dumps(payload_data, ensure_ascii=False)

                # 라이브러리 JSON + MD 저장
                save_translation(session_id, page_num, payload_json, suffix)
                _save_page_md(session_id, page_num, cleaned_translation, suffix)

                if page_num not in job["completed_pages"]:
                    job["completed_pages"].append(page_num)
            except Exception as e:
                print(f"[Job {session_id}] page {page_num} failed: {e}")
                if page_num not in job["failed_pages"]:
                    job["failed_pages"].append(page_num)

            job["updated_at"] = datetime.now(timezone.utc).isoformat()
            _save_job(session_id, job)

        job["status"] = "completed"
        job["completed_at"] = datetime.now(timezone.utc).isoformat()
        _save_job(session_id, job)

        # 범위 잡이 문서의 마지막 미번역 구간까지 채운 경우에만 전체 산출물과
        # 연구 후처리를 생성한다. 부분 범위 완료를 전체 문서 완료로 오인하지 않는다.
        all_pages_completed = all(
            get_translation(session_id, page["page_num"], suffix, fallback=False) is not None
            for page in pages
        )
        if all_pages_completed:
            _build_full_md(session_id, pages, suffix)

        # 학술 태그와 지식 그래프는 연구 문서 전용 후처리다. 일반 문서에는
        # 연구 분류·인용 관계를 억지로 생성하지 않고 번역 완료로 끝낸다.
        if document_mode == "research" and all_pages_completed:
            try:
                from services.paper_tags import classify_and_store_paper_tags
                paper_tags = await classify_and_store_paper_tags(
                    session_id, pages, doc_title, force=False
                )
                if paper_tags:
                    print(f"[Job {session_id}] Classified structured paper tags")
            except Exception as ex:
                print(f"[Job {session_id}] Structured tag classification failed: {ex}")

            try:
                from services.knowledge_graph import sync_document_for_graph
                await sync_document_for_graph(session_id, pages, doc_title)
            except Exception as ex:
                print(f"[Job {session_id}] Knowledge graph sync failed: {ex}")

    except asyncio.CancelledError:
        job["status"] = "cancelled"
        _save_job(session_id, job)
    except Exception as e:
        job["status"] = "failed"
        job["error"] = str(e)
        _save_job(session_id, job)
    finally:
        # 취소된 이전 잡(Restart로 대체된 구 태스크)이 뒤늦게 여기 도달하면,
        # 이미 새로 등록된 최신 태스크의 항목을 그냥 pop(key)로 지워버려서
        # cancel_job()이나 진행 상태 확인이 "실행 중인 잡 없음"으로 잘못
        # 판단하게 되는 문제가 있었다. 지금 _running_tasks에 등록된 태스크가
        # 정확히 "나 자신"일 때만 제거한다.
        if _running_tasks.get(session_id) is asyncio.current_task():
            _running_tasks.pop(session_id, None)


async def _translate_page(
    text: str,
    target_lang: str,
    style: str,
    ignore_math: bool,
    ignore_table: bool,
    ignore_refs: bool,
    doc_title: str = "",
    prev_context: str = "",
    session_id: str = None,
    page_num: int = None,
    page_image_b64: str = None,
    document_mode: str = "research",
    document_type: str = "research_paper",
) -> str:
    """단일 페이지 텍스트를 번역합니다."""
    if not text:
        return ""
    chunks = split_into_chunks(text)
    results = []
    for chunk_idx, chunk in enumerate(chunks):
        # 첫 청크면 이전 페이지 번역 결과 사용, 그 외에는 페이지 내 이전 청크들의 누적 번역 사용
        current_prev = prev_context if chunk_idx == 0 else "\n\n".join(results)

        tokens: list[str] = []
        async for token in stream_translation(
            chunk,
            target_lang=target_lang,
            style=style,
            ignore_math=ignore_math,
            ignore_table=ignore_table,
            ignore_refs=ignore_refs,
            doc_title=doc_title,
            prev_context=current_prev,
            page_image_b64=page_image_b64,
            document_mode=document_mode,
            document_type=document_type,
            session_id=session_id,
            page_num=page_num
        ):
            tokens.append(token)
        results.append("".join(tokens))
    return "\n\n".join(results)


# ─────────────────────────────────────────────────────────
#  MD 파일 저장
# ─────────────────────────────────────────────────────────

def _save_page_md(session_id: str, page_num: int, translation: str, suffix: str = "") -> None:
    """개별 페이지 MD 파일을 저장합니다."""
    dir_path = os.path.join(LIBRARY_DIR, session_id, "md")
    os.makedirs(dir_path, exist_ok=True)
    suffix_part = f"_{suffix}" if suffix else ""
    path = os.path.join(dir_path, f"page_{page_num}{suffix_part}.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"## {page_num}페이지\n\n{translation}\n")


def _build_full_md(session_id: str, pages: list, suffix: str = "") -> None:
    """번역 완료 후 전체 MD 파일을 생성합니다."""
    doc = get_document(session_id)
    title = doc.get("filename", session_id) if doc else session_id

    parts = [f"# {title}\n\n> EasyPaper 번역본 · {datetime.now(timezone.utc).strftime('%Y-%m-%d')}\n"]

    for page_data in sorted(pages, key=lambda p: p["page_num"]):
        page_num = page_data["page_num"]
        translation = get_translation(session_id, page_num, suffix, fallback=False)
        if translation:
            parts.append(f"## {page_num}페이지\n\n{translation}")

    suffix_part = f"_{suffix}" if suffix else ""
    full_path = os.path.join(LIBRARY_DIR, session_id, f"translation{suffix_part}.md")
    with open(full_path, "w", encoding="utf-8") as f:
        f.write("\n\n---\n\n".join(parts))


def get_full_md_path(session_id: str, suffix: str = "", fallback: bool = True) -> Optional[str]:
    """전체 MD 파일 경로를 반환합니다."""
    suffix_part = f"_{suffix}" if suffix else ""
    path = os.path.join(LIBRARY_DIR, session_id, f"translation{suffix_part}.md")
    if os.path.exists(path):
        return path
    
    # 명시적 정책 키 조회에서는 다른 모드/옵션의 파일을 재사용하지 않는다.
    if fallback:
        import glob
        files = glob.glob(os.path.join(LIBRARY_DIR, session_id, "translation_*.md"))
        if files:
            files.sort(key=os.path.getmtime, reverse=True)
            return files[0]
    return None


def get_page_md(session_id: str, page_num: int, suffix: str = "", fallback: bool = True) -> Optional[str]:
    """페이지 MD 파일 내용을 반환합니다."""
    suffix_part = f"_{suffix}" if suffix else ""
    path = os.path.join(LIBRARY_DIR, session_id, "md", f"page_{page_num}{suffix_part}.md")
    if not os.path.exists(path):
        # Fallback 1: Try database translation cache
        from services.library import get_translation as lib_get_translation
        db_text = lib_get_translation(session_id, page_num, suffix, fallback=fallback)
        if db_text:
            return db_text
            
        # 명시적 정책 키 조회에서는 다른 모드/옵션의 페이지 파일을 사용하지 않는다.
        md_dir = os.path.join(LIBRARY_DIR, session_id, "md")
        if fallback and os.path.exists(md_dir):
            import glob
            files = glob.glob(os.path.join(md_dir, f"page_{page_num}_*.md"))
            if files:
                files.sort(key=os.path.getmtime, reverse=True)
                path = files[0]
            else:
                return None
        else:
            return None

    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    # 헤더 제거 후 번역 본문만 반환
    lines = content.split("\n")
    body_lines = [l for l in lines if not l.startswith("## ")]
    return "\n".join(body_lines).strip()

