from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import FileResponse
from services.auth import get_current_user
from services.library import (
    list_documents, get_document, delete_document,
    get_translation, get_pdf_path
)

router = APIRouter()


from typing import Optional

@router.get("/library")
async def get_library(
    target_lang: Optional[str] = None,
    style: Optional[str] = None,
    ignore_math: Optional[bool] = None,
    ignore_table: Optional[bool] = None,
    ignore_refs: Optional[bool] = None,
    current_user: str = Depends(get_current_user)
):
    """라이브러리의 모든 문서 목록을 반환합니다."""
    docs = list_documents(current_user, target_lang, style, ignore_math, ignore_table, ignore_refs)
    return {"documents": docs, "total": len(docs)}


@router.get("/library/{doc_id}")
async def get_library_document(
    doc_id: str,
    target_lang: Optional[str] = None,
    style: Optional[str] = None,
    ignore_math: Optional[bool] = None,
    ignore_table: Optional[bool] = None,
    ignore_refs: Optional[bool] = None
):
    """특정 문서의 메타데이터와 번역 완료 페이지 목록을 반환합니다."""
    doc = get_document(doc_id, target_lang, style, ignore_math, ignore_table, ignore_refs)
    if not doc:
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다.")
    return doc


@router.get("/library/{doc_id}/translation/{page_num}")
async def get_library_translation(
    doc_id: str,
    page_num: int,
    target_lang: Optional[str] = None,
    style: Optional[str] = None,
    ignore_math: Optional[bool] = None,
    ignore_table: Optional[bool] = None,
    ignore_refs: Optional[bool] = None
):
    """라이브러리에서 특정 페이지 번역을 가져옵니다."""
    suffix = ""
    if target_lang is not None and style is not None:
        suffix = f"{target_lang}_{style}_math{int(ignore_math)}_table{int(ignore_table)}_refs{int(ignore_refs)}"
    translation = get_translation(doc_id, page_num, suffix)
    if translation is None:
        raise HTTPException(status_code=404, detail="번역이 없습니다.")
    return {"page": page_num, "translation": translation}


@router.get("/library/{doc_id}/pdf")
async def get_library_pdf(doc_id: str):
    """라이브러리 PDF 파일을 서빙합니다."""
    pdf_path = get_pdf_path(doc_id)
    if not pdf_path:
        raise HTTPException(status_code=404, detail="PDF 파일을 찾을 수 없습니다.")
    return FileResponse(pdf_path, media_type="application/pdf")


@router.delete("/library/{doc_id}")
async def delete_library_document(doc_id: str):
    """라이브러리에서 문서를 삭제합니다."""
    if not delete_document(doc_id):
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다.")
    return {"message": "문서가 삭제되었습니다."}
