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

from config import LIBRARY_DIR
from services.chunker import split_into_chunks
from services.llm_client import stream_translation
from services.library import save_translation, get_translation, get_document

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
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(job, f, ensure_ascii=False, indent=2)


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
    ignore_refs: bool = False
) -> dict:
    """
    백그라운드 번역 잡을 시작합니다.
    이미 진행 중이거나 완료된 잡이 있으면 기존 상태를 반환합니다.
    """
    existing = _load_job(session_id)

    # 이미 동일한 옵션으로 완료된 잡이면 재시작하지 않음
    if existing and existing.get("status") == "completed":
        opts = existing.get("options", {})
        if (opts.get("target_lang") == target_lang and
            opts.get("style") == style and
            opts.get("ignore_math") == ignore_math and
            opts.get("ignore_table") == ignore_table and
            opts.get("ignore_refs") == ignore_refs):
            return existing

    # 아직 실행 중인 태스크가 있으면 먼저 취소(Restart 대응)
    if session_id in _running_tasks:
        _running_tasks[session_id].cancel()

    # 새 잡 세팅
    job = {
        "session_id": session_id,
        "status": "running",
        "total_pages": len(pages),
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

    suffix = f"{target_lang}_{style}_math{int(ignore_math)}_table{int(ignore_table)}_refs{int(ignore_refs)}"

    # 문서 제목 정보 가져오기
    doc_title = ""
    try:
        doc = get_document(session_id)
        if doc:
            doc_title = doc.get("metadata", {}).get("title") or doc.get("filename", "")
    except Exception as e:
        print(f"[Job {session_id}] Failed to get document title: {e}")

    # 이미 완료된 페이지들을 루프 돌기 전 한 번에 스캔하여 저장
    scanned_any = False
    for page_data in pages:
        page_num = page_data["page_num"]
        if get_translation(session_id, page_num, suffix) is not None:
            if page_num not in job["completed_pages"]:
                job["completed_pages"].append(page_num)
                scanned_any = True

    if scanned_any:
        job["updated_at"] = datetime.now(timezone.utc).isoformat()
        _save_job(session_id, job)

    try:
        for page_data in pages:
            page_num = page_data["page_num"]

            # 이미 완료된 페이지는 스킵 (동일 옵션의 영구 저장 확인)
            if get_translation(session_id, page_num, suffix) is not None:
                if page_num not in job["completed_pages"]:
                    job["completed_pages"].append(page_num)
                    _save_job(session_id, job)
                continue

            text = page_data.get("text", "").strip()

            # 이전 페이지 번역 가져오기
            prev_context = ""
            if page_num > 1:
                try:
                    prev_context = get_translation(session_id, page_num - 1, suffix) or ""
                except Exception:
                    pass

            try:
                translation = await _translate_page(
                    text,
                    target_lang=target_lang,
                    style=style,
                    ignore_math=ignore_math,
                    ignore_table=ignore_table,
                    ignore_refs=ignore_refs,
                    doc_title=doc_title,
                    prev_context=prev_context
                )
                # 라이브러리 JSON + MD 저장
                save_translation(session_id, page_num, translation, suffix)
                _save_page_md(session_id, page_num, translation, suffix)

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

        # 전체 MD 파일 생성
        _build_full_md(session_id, pages, suffix)

        # 카테고리 분석 실행 (번역 완료 후)
        try:
            combined_text = ""
            for p in pages[:2]:
                combined_text += p.get("text", "") + "\n"
            
            from services.llm_client import classify_paper_category
            from services.library import update_document_metadata
            
            tags = await classify_paper_category(doc_title, combined_text)
            if tags:
                doc = get_document(session_id)
                if doc:
                    meta = doc.get("metadata", {})
                    meta["categories"] = tags
                    update_document_metadata(session_id, meta)
                    print(f"[Job {session_id}] Classified categories: {tags}")
        except Exception as ex:
            print(f"[Job {session_id}] Category classification failed: {ex}")

    except asyncio.CancelledError:
        job["status"] = "cancelled"
        _save_job(session_id, job)
    except Exception as e:
        job["status"] = "failed"
        job["error"] = str(e)
        _save_job(session_id, job)
    finally:
        _running_tasks.pop(session_id, None)


async def _translate_page(
    text: str,
    target_lang: str,
    style: str,
    ignore_math: bool,
    ignore_table: bool,
    ignore_refs: bool,
    doc_title: str = "",
    prev_context: str = ""
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
            prev_context=current_prev
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
        translation = get_translation(session_id, page_num, suffix)
        if translation:
            parts.append(f"## {page_num}페이지\n\n{translation}")

    suffix_part = f"_{suffix}" if suffix else ""
    full_path = os.path.join(LIBRARY_DIR, session_id, f"translation{suffix_part}.md")
    with open(full_path, "w", encoding="utf-8") as f:
        f.write("\n\n---\n\n".join(parts))


def get_full_md_path(session_id: str, suffix: str = "") -> Optional[str]:
    """전체 MD 파일 경로를 반환합니다."""
    suffix_part = f"_{suffix}" if suffix else ""
    path = os.path.join(LIBRARY_DIR, session_id, f"translation{suffix_part}.md")
    if os.path.exists(path):
        return path
    
    # Fallback: Find any translation_*.md file
    import glob
    files = glob.glob(os.path.join(LIBRARY_DIR, session_id, "translation_*.md"))
    if files:
        files.sort(key=os.path.getmtime, reverse=True)
        return files[0]
    return None


def get_page_md(session_id: str, page_num: int, suffix: str = "") -> Optional[str]:
    """페이지 MD 파일 내용을 반환합니다."""
    suffix_part = f"_{suffix}" if suffix else ""
    path = os.path.join(LIBRARY_DIR, session_id, "md", f"page_{page_num}{suffix_part}.md")
    if not os.path.exists(path):
        # Fallback 1: Try database translation cache
        from services.library import get_translation as lib_get_translation
        db_text = lib_get_translation(session_id, page_num, suffix)
        if db_text:
            return db_text
            
        # Fallback 2: Try any page MD file
        md_dir = os.path.join(LIBRARY_DIR, session_id, "md")
        if os.path.exists(md_dir):
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

