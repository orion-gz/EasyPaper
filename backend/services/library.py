import os
import shutil
from typing import Optional, List
from config import LIBRARY_DIR
from services.db import (
    db_save_document,
    db_get_document,
    db_list_documents,
    db_delete_document,
    db_save_translation,
    db_get_translation,
    db_clear_translations,
    db_update_document_metadata,
    get_db
)

def _pdf_path(doc_id: str) -> str:
    return os.path.join(LIBRARY_DIR, doc_id, "document.pdf")


# ── 문서 저장 ─────────────────────────────────────────────────────────────────

def save_document(doc_id: str, filename: str, pdf_src_path: str,
                  total_pages: int, metadata: dict, username: str = "admin") -> dict:
    """PDF를 라이브러리에 영구 저장하고 데이터베이스에 기록합니다."""
    doc_dir = os.path.join(LIBRARY_DIR, doc_id)
    os.makedirs(os.path.join(doc_dir, "translations"), exist_ok=True)

    # PDF 파일 복사
    shutil.copy2(pdf_src_path, _pdf_path(doc_id))

    # 데이터베이스에 저장
    doc_meta = db_save_document(doc_id, username, filename, _pdf_path(doc_id), total_pages, metadata)
    doc_meta["translated_pages"] = []
    return doc_meta


def get_document(
    doc_id: str,
    target_lang: Optional[str] = None,
    style: Optional[str] = None,
    ignore_math: Optional[bool] = None,
    ignore_table: Optional[bool] = None,
    ignore_refs: Optional[bool] = None
) -> Optional[dict]:
    """라이브러리에서 문서 메타데이터를 가져옵니다."""
    doc = db_get_document(doc_id)
    if doc:
        suffix = None
        if target_lang is not None and style is not None:
            suffix = f"{target_lang}_{style}_math{int(ignore_math)}_table{int(ignore_table)}_refs{int(ignore_refs)}"
            
        with get_db() as conn:
            cursor = conn.cursor()
            pages = []
            if suffix:
                cursor.execute(
                    "SELECT DISTINCT page_num FROM translations WHERE doc_id = ? AND suffix = ? ORDER BY page_num ASC",
                    (doc_id, suffix)
                )
                pages = [r["page_num"] for r in cursor.fetchall()]
            
            if not pages:
                # Fallback to the most recent suffix's pages
                cursor.execute(
                    "SELECT suffix FROM translations WHERE doc_id = ? ORDER BY saved_at DESC LIMIT 1",
                    (doc_id,)
                )
                row = cursor.fetchone()
                if row:
                    fallback_suffix = row["suffix"]
                    cursor.execute(
                        "SELECT DISTINCT page_num FROM translations WHERE doc_id = ? AND suffix = ? ORDER BY page_num ASC",
                        (doc_id, fallback_suffix)
                    )
                    pages = [r["page_num"] for r in cursor.fetchall()]
                else:
                    # If no suffix found, query any pages
                    cursor.execute(
                        "SELECT DISTINCT page_num FROM translations WHERE doc_id = ? ORDER BY page_num ASC",
                        (doc_id,)
                    )
                    pages = [r["page_num"] for r in cursor.fetchall()]
        doc["translated_pages"] = pages
        return doc
    return None


def list_documents(
    username: Optional[str] = None,
    target_lang: Optional[str] = None,
    style: Optional[str] = None,
    ignore_math: Optional[bool] = None,
    ignore_table: Optional[bool] = None,
    ignore_refs: Optional[bool] = None
) -> list:
    """라이브러리의 문서를 최신순으로 반환합니다 (필터링 가능)."""
    docs = db_list_documents(username)
    
    suffix = None
    if target_lang is not None and style is not None:
        suffix = f"{target_lang}_{style}_math{int(ignore_math)}_table{int(ignore_table)}_refs{int(ignore_refs)}"

    for doc in docs:
        with get_db() as conn:
            cursor = conn.cursor()
            pages = []
            if suffix:
                cursor.execute(
                    "SELECT DISTINCT page_num FROM translations WHERE doc_id = ? AND suffix = ? ORDER BY page_num ASC",
                    (doc["id"], suffix)
                )
                pages = [r["page_num"] for r in cursor.fetchall()]
            
            if not pages:
                # Fallback to the most recent suffix's pages
                cursor.execute(
                    "SELECT suffix FROM translations WHERE doc_id = ? ORDER BY saved_at DESC LIMIT 1",
                    (doc["id"],)
                )
                row = cursor.fetchone()
                if row:
                    fallback_suffix = row["suffix"]
                    cursor.execute(
                        "SELECT DISTINCT page_num FROM translations WHERE doc_id = ? AND suffix = ? ORDER BY page_num ASC",
                        (doc["id"], fallback_suffix)
                    )
                    pages = [r["page_num"] for r in cursor.fetchall()]
                else:
                    # If no suffix found, query any pages
                    cursor.execute(
                        "SELECT DISTINCT page_num FROM translations WHERE doc_id = ? ORDER BY page_num ASC",
                        (doc["id"],)
                    )
                    pages = [r["page_num"] for r in cursor.fetchall()]
        doc["translated_pages"] = pages
    return docs


def delete_document(doc_id: str) -> bool:
    """라이브러리에서 문서 파일 및 데이터베이스 레코드를 삭제합니다."""
    doc_dir = os.path.join(LIBRARY_DIR, doc_id)
    # 1. 파일 삭제
    if os.path.exists(doc_dir):
        shutil.rmtree(doc_dir, ignore_errors=True)
    # 2. DB 삭제
    return db_delete_document(doc_id)


# ── 번역 저장/조회 ─────────────────────────────────────────────────────────────

def save_translation(doc_id: str, page_num: int, translation: str, suffix: str = "") -> None:
    """번역 결과를 데이터베이스에 저장합니다."""
    db_save_translation(doc_id, page_num, translation, suffix)


def get_translation(doc_id: str, page_num: int, suffix: str = "", fallback: bool = True) -> Optional[str]:
    """데이터베이스에서 번역 결과를 가져옵니다."""
    return db_get_translation(doc_id, page_num, suffix, fallback)


def clear_translations(doc_id: str) -> None:
    """데이터베이스에서 모든 번역 데이터를 지웁니다."""
    db_clear_translations(doc_id)


def get_pdf_path(doc_id: str) -> Optional[str]:
    """라이브러리 PDF 파일 경로를 반환합니다."""
    path = _pdf_path(doc_id)
    return path if os.path.exists(path) else None

def update_document_metadata(doc_id: str, metadata: dict) -> None:
    """문서 메타데이터를 업데이트합니다."""
    db_update_document_metadata(doc_id, metadata)
