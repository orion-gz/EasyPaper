from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import FileResponse
from services.auth import get_current_user
from services.library import (
    list_documents, search_documents, get_document, permanently_delete_document,
    soft_delete_document, restore_document, empty_trash,
    get_translation, get_pdf_path, get_cover_path, update_document_metadata
)
from pydantic import BaseModel
import json

router = APIRouter()


from typing import Optional


def _require_owned_document(doc_id: str, current_user: str, doc: Optional[dict] = None) -> dict:
    """문서가 존재하고 현재 로그인한 사용자 소유인지 확인한다.

    다른 사용자의 문서는 존재 여부조차 알려주지 않도록, 존재하지 않는 경우와
    동일하게 404로 응답한다(문서는 있지만 권한이 없다는 403은 doc_id가
    실제로 존재한다는 사실 자체를 노출하게 됨).
    """
    if doc is None:
        doc = get_document(doc_id)
    if not doc or doc.get("username") != current_user:
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다.")
    return doc

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


@router.get("/library/trash")
async def get_library_trash(
    target_lang: Optional[str] = None,
    style: Optional[str] = None,
    ignore_math: Optional[bool] = None,
    ignore_table: Optional[bool] = None,
    ignore_refs: Optional[bool] = None,
    current_user: str = Depends(get_current_user)
):
    """휴지통에 보관 중인 문서 목록을 반환합니다."""
    docs = list_documents(current_user, target_lang, style, ignore_math, ignore_table, ignore_refs, only_trash=True)
    return {"documents": docs, "total": len(docs)}


@router.delete("/library/trash/empty")
async def empty_library_trash(current_user: str = Depends(get_current_user)):
    """휴지통을 완전히 비웁니다(영구 삭제)."""
    if not empty_trash(current_user):
        raise HTTPException(status_code=500, detail="휴지통 비우기에 실패했습니다.")
    return {"message": "휴지통이 비워졌습니다."}


@router.get("/library/search")
async def search_library(q: str = "", current_user: str = Depends(get_current_user)):
    """파일명/제목·카테고리와 번역된 본문 텍스트를 가로질러 검색합니다.

    /library/{doc_id}보다 먼저 등록해야 한다 - 그렇지 않으면 "search"가
    doc_id 경로 파라미터로 잘못 매칭된다.
    """
    docs = search_documents(current_user, q)
    return {"documents": docs, "total": len(docs)}


@router.get("/library/graph")
async def get_library_graph(current_user: str = Depends(get_current_user)):
    """개인 지식 그래프(논문/개념 노드 + 인용/카테고리 엣지)를 반환합니다.

    /library/{doc_id}보다 먼저 등록해야 한다 - /library/search와 동일한
    이유로, 그렇지 않으면 "graph"가 doc_id 경로 파라미터로 잘못 매칭된다.
    """
    from services.knowledge_graph import get_graph_data
    return await get_graph_data(current_user)


@router.get("/library/{doc_id}")
async def get_library_document(
    doc_id: str,
    target_lang: Optional[str] = None,
    style: Optional[str] = None,
    ignore_math: Optional[bool] = None,
    ignore_table: Optional[bool] = None,
    ignore_refs: Optional[bool] = None,
    current_user: str = Depends(get_current_user)
):
    """특정 문서의 메타데이터와 번역 완료 페이지 목록을 반환합니다."""
    doc = get_document(doc_id, target_lang, style, ignore_math, ignore_table, ignore_refs)
    _require_owned_document(doc_id, current_user, doc)
    return doc


@router.get("/library/{doc_id}/translation/{page_num}")
async def get_library_translation(
    doc_id: str,
    page_num: int,
    target_lang: Optional[str] = None,
    style: Optional[str] = None,
    ignore_math: Optional[bool] = None,
    ignore_table: Optional[bool] = None,
    ignore_refs: Optional[bool] = None,
    current_user: str = Depends(get_current_user)
):
    """라이브러리에서 특정 페이지 번역을 가져옵니다."""
    _require_owned_document(doc_id, current_user)
    suffix = ""
    if target_lang is not None and style is not None:
        suffix = f"{target_lang}_{style}_math{int(ignore_math)}_table{int(ignore_table)}_refs{int(ignore_refs)}"
        
    from services.library import get_translation_full
    full_cached = get_translation_full(doc_id, page_num, suffix)
    if not full_cached.get("translation"):
        raise HTTPException(status_code=404, detail="번역이 없습니다.")
    return {
        "page": page_num,
        "translation": full_cached["translation"],
        "sentences": full_cached.get("sentences", [])
    }


class UpdateTranslationPayload(BaseModel):
    translation: str
    sentences: list[dict]


@router.put("/library/{doc_id}/translation/{page_num}")
async def update_library_translation(
    doc_id: str,
    page_num: int,
    payload: UpdateTranslationPayload,
    target_lang: Optional[str] = None,
    style: Optional[str] = None,
    ignore_math: Optional[bool] = None,
    ignore_table: Optional[bool] = None,
    ignore_refs: Optional[bool] = None,
    current_user: str = Depends(get_current_user)
):
    """라이브러리의 특정 페이지 번역 데이터를 수정하여 캐시 및 DB에 저장합니다."""
    _require_owned_document(doc_id, current_user)
    suffix = ""
    if target_lang is not None and style is not None:
        suffix = f"{target_lang}_{style}_math{int(ignore_math)}_table{int(ignore_table)}_refs{int(ignore_refs)}"

    from services.library import save_translation
    from services.cache import save_translation_cache

    payload_dict = {
        "translation": payload.translation,
        "sentences": payload.sentences
    }
    payload_json = json.dumps(payload_dict, ensure_ascii=False)

    # DB에 영구 저장
    save_translation(doc_id, page_num, payload_json, suffix)
    # 메모리 캐시 최신화
    save_translation_cache(doc_id, page_num, payload_json, suffix)

    return {"status": "success"}


@router.get("/library/{doc_id}/pdf")
async def get_library_pdf(doc_id: str, current_user: str = Depends(get_current_user)):
    """라이브러리 PDF 파일을 서빙합니다."""
    _require_owned_document(doc_id, current_user)
    pdf_path = get_pdf_path(doc_id)
    if not pdf_path:
        raise HTTPException(status_code=404, detail="PDF 파일을 찾을 수 없습니다.")
    return FileResponse(pdf_path, media_type="application/pdf")


class ExportPdfRequest(BaseModel):
    annotations: dict = {}
    memos: dict = {}
    target_lang: Optional[str] = None
    style: Optional[str] = None
    ignore_math: Optional[bool] = None
    ignore_table: Optional[bool] = None
    ignore_refs: Optional[bool] = None


@router.post("/library/{doc_id}/export-pdf")
async def export_annotated_pdf(
    doc_id: str,
    payload: ExportPdfRequest,
    current_user: str = Depends(get_current_user)
):
    """번역/하이라이트/밑줄/메모가 반영된 PDF를 생성해 반환합니다.

    하이라이트·밑줄·메모는 브라우저 localStorage에만 있으므로 요청 본문으로
    전달받는다(서버는 이 데이터를 저장하지 않고 즉시 PDF 생성에만 사용).
    """
    doc = _require_owned_document(doc_id, current_user)
    pdf_path = get_pdf_path(doc_id)
    if not pdf_path:
        raise HTTPException(status_code=404, detail="PDF 파일을 찾을 수 없습니다.")

    suffix = ""
    if payload.target_lang is not None and payload.style is not None:
        suffix = f"{payload.target_lang}_{payload.style}_math{int(payload.ignore_math)}_table{int(payload.ignore_table)}_refs{int(payload.ignore_refs)}"

    from services.library import get_translation_full
    total_pages = doc.get("total_pages", 0) or 0
    translations = {}
    for page_num in range(1, total_pages + 1):
        full = get_translation_full(doc_id, page_num, suffix)
        text = (full or {}).get("translation")
        if text:
            translations[str(page_num)] = text

    try:
        from services.pdf_export import generate_annotated_pdf
        pdf_bytes = generate_annotated_pdf(
            pdf_path, payload.annotations, translations, payload.memos
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PDF 생성 실패: {str(e)}")

    from fastapi.responses import Response
    from urllib.parse import quote
    base_filename = (doc.get("filename") or "document").rsplit(".", 1)[0]
    export_filename = f"{base_filename}_번역_주석.pdf"
    encoded_filename = quote(export_filename)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"attachment; filename=\"export.pdf\"; filename*=UTF-8''{encoded_filename}"
        }
    )


@router.get("/library/{doc_id}/cover")
async def get_library_cover(doc_id: str, current_user: str = Depends(get_current_user)):
    """라이브러리 카드 미리보기용 1페이지 상단(제목+abstract) 캡쳐 이미지를 서빙합니다.

    최초 1회만 PyMuPDF로 렌더링하고 이후엔 파일만 서빙하지만(get_cover_path
    내부에서 이미 캐싱), 그 최초 렌더링 자체가 동기 CPU 작업이라 이벤트
    루프를 블로킹하지 않도록 스레드로 넘긴다."""
    import asyncio
    _require_owned_document(doc_id, current_user)
    cover_path = await asyncio.to_thread(get_cover_path, doc_id)
    if not cover_path:
        raise HTTPException(status_code=404, detail="미리보기 이미지를 생성할 수 없습니다.")
    return FileResponse(cover_path, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})


@router.delete("/library/{doc_id}")
async def delete_library_document(doc_id: str, current_user: str = Depends(get_current_user)):
    """라이브러리 문서를 휴지통으로 이동(Soft Delete)합니다."""
    _require_owned_document(doc_id, current_user)
    if not soft_delete_document(doc_id):
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다.")
    return {"message": "문서가 휴지통으로 이동되었습니다."}

@router.post("/library/{doc_id}/restore")
async def restore_library_document(doc_id: str, current_user: str = Depends(get_current_user)):
    """휴지통에서 문서를 복원합니다."""
    _require_owned_document(doc_id, current_user)
    if not restore_document(doc_id):
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다.")
    return {"message": "문서가 성공적으로 복원되었습니다."}

@router.delete("/library/{doc_id}/permanent")
async def delete_library_document_permanently(doc_id: str, current_user: str = Depends(get_current_user)):
    """라이브러리에서 문서를 영구히 삭제(Hard Delete)합니다."""
    _require_owned_document(doc_id, current_user)
    if not permanently_delete_document(doc_id):
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다.")
    return {"message": "문서가 영구적으로 삭제되었습니다."}


@router.get("/library/{doc_id}/images")
async def get_library_document_images(doc_id: str, current_user: str = Depends(get_current_user)):
    """특정 문서의 모든 페이지에서 이미지/Figure 좌표 정보(백분율) 목록을 반환합니다.

    find_tables()/get_drawings() 등을 페이지마다 두 차례 훑는 무거운 연산이라,
    extract_pages()와 동일하게 디스크에 캐싱해 서버 재시작 이후에도 문서를
    다시 열 때마다 재계산하지 않게 한다. 또한 이 연산은 완전히 동기
    CPU-bound(PyMuPDF, GIL 점유)라 캐시 미스 시 asyncio 이벤트 루프를 그대로
    블로킹하면 그동안 다른 요청(라이브러리 목록 등)이 전부 멈추므로,
    별도 스레드로 넘긴다."""
    import asyncio
    from services.cache import get_cached_images, save_images_cache

    _require_owned_document(doc_id, current_user)
    pdf_path = get_pdf_path(doc_id)
    if not pdf_path:
        raise HTTPException(status_code=404, detail="PDF 파일을 찾을 수 없습니다.")

    images = get_cached_images(doc_id, pdf_path)
    if images is not None:
        return {"images": images}

    try:
        from services.pdf_parser import extract_pdf_images
        images = await asyncio.to_thread(extract_pdf_images, pdf_path)
        save_images_cache(doc_id, pdf_path, images)
        return {"images": images}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"이미지 좌표 추출 실패: {str(e)}")


@router.get("/library/{doc_id}/references")
async def get_library_references(doc_id: str, current_user: str = Depends(get_current_user)):
    """참고문헌 목록(번호 -> 원문 텍스트)을 반환합니다.

    외부 API 호출 없이 PDF 텍스트만 파싱한다 - 실제 외부 링크 조회는
    사용자가 본문에서 특정 인용 표기를 클릭했을 때만
    (/library/{doc_id}/references/{ref_num}) 그때그때 수행한다. 논문 한 편에
    참고문헌이 수십~백여 개인 경우가 흔한데, 열 때마다 전부 미리 조회하면
    외부 API 레이트리밋에 바로 걸리고 대부분은 클릭되지도 않아 낭비다.
    """
    _require_owned_document(doc_id, current_user)

    from services.library import get_page_insight, save_page_insight

    cached = get_page_insight(doc_id, 0, "reference_list")
    if cached is not None:
        try:
            return {"references": json.loads(cached)}
        except Exception:
            pass

    pdf_path = get_pdf_path(doc_id)
    if not pdf_path:
        raise HTTPException(status_code=404, detail="PDF 파일을 찾을 수 없습니다.")

    import asyncio
    from services.cache import get_cached_pages, save_pages_cache
    from services.pdf_parser import extract_pages
    from services.reference_parser import extract_reference_list
    try:
        # ensure_session()/get_cached_pages()와 같은 디스크 캐시를 공유한다 -
        # 그렇지 않으면 세션이 아직 복원되지 않은 상태(서버 재시작 직후 첫
        # 열람)에서 텍스트를 한 번 더 처음부터 추출하게 된다.
        pages = get_cached_pages(doc_id, pdf_path)
        if pages is None:
            pages = await asyncio.to_thread(extract_pages, pdf_path)
            save_pages_cache(doc_id, pdf_path, pages)
        references = extract_reference_list(pages)
    except Exception:
        references = {}

    save_page_insight(doc_id, 0, "reference_list", json.dumps(references, ensure_ascii=False))
    return {"references": references}


@router.get("/library/{doc_id}/references/{ref_num}")
async def resolve_library_reference(doc_id: str, ref_num: str, current_user: str = Depends(get_current_user)):
    """특정 번호의 참고문헌을 외부(OpenAlex, 가능하면 arXiv)에서
    검색해 링크를 반환합니다. 결과(성공/실패 모두)는 캐시해 같은 항목을
    반복 조회하지 않습니다."""
    _require_owned_document(doc_id, current_user)

    from services.library import get_page_insight, save_page_insight

    cached = get_page_insight(doc_id, 0, "reference_url", suffix=ref_num)
    if cached is not None:
        try:
            data = json.loads(cached)
        except Exception:
            data = {}
        if not data:
            raise HTTPException(status_code=404, detail="외부에서 일치하는 논문을 찾지 못했습니다.")
        return data

    ref_list_cached = get_page_insight(doc_id, 0, "reference_list")
    references = {}
    if ref_list_cached:
        try:
            references = json.loads(ref_list_cached)
        except Exception:
            references = {}

    ref_text = references.get(ref_num)
    if not ref_text:
        raise HTTPException(status_code=404, detail="해당 번호의 참고문헌을 찾을 수 없습니다.")

    from services.reference_linker import resolve_reference
    result = await resolve_reference(ref_text)
    save_page_insight(doc_id, 0, "reference_url", json.dumps(result or {}, ensure_ascii=False), suffix=ref_num)

    if not result:
        raise HTTPException(status_code=404, detail="외부에서 일치하는 논문을 찾지 못했습니다.")
    return result


@router.get("/library/{doc_id}/annotations")
async def get_library_annotations(doc_id: str, current_user: str = Depends(get_current_user)):
    """문서의 하이라이트/주석 서버 미러 데이터를 반환합니다.

    localStorage가 원본(source of truth)이며 이 데이터는 다중 기기 동기화를
    위한 best-effort 백업일 뿐이다. 저장된 적이 없으면 빈 데이터를 반환한다.
    """
    _require_owned_document(doc_id, current_user)
    from services.db import db_get_annotations
    result = db_get_annotations(doc_id)
    return result or {"data": {}, "updated_at": None}


@router.put("/library/{doc_id}/annotations")
async def put_library_annotations(doc_id: str, payload: dict, current_user: str = Depends(get_current_user)):
    """하이라이트/주석 서버 미러를 통째로 덮어씁니다(전체 블롭 upsert)."""
    _require_owned_document(doc_id, current_user)
    from services.db import db_put_annotations
    db_put_annotations(doc_id, payload.get("data", {}))
    return {"status": "ok"}


@router.get("/library/{doc_id}/memos")
async def get_library_memos(doc_id: str, current_user: str = Depends(get_current_user)):
    """문서의 메모 서버 미러 데이터를 반환합니다. (annotations와 동일한 성격)"""
    _require_owned_document(doc_id, current_user)
    from services.db import db_get_memos
    result = db_get_memos(doc_id)
    return result or {"data": {}, "updated_at": None}


@router.put("/library/{doc_id}/memos")
async def put_library_memos(doc_id: str, payload: dict, current_user: str = Depends(get_current_user)):
    """메모 서버 미러를 통째로 덮어씁니다(전체 블롭 upsert)."""
    _require_owned_document(doc_id, current_user)
    from services.db import db_put_memos
    db_put_memos(doc_id, payload.get("data", {}))
    return {"status": "ok"}


@router.put("/library/{doc_id}/metadata")
async def update_doc_metadata(
    doc_id: str,
    payload: dict,
    current_user: str = Depends(get_current_user)
):
    """문서의 메타데이터(예: 제목 등)를 업데이트합니다."""
    doc = _require_owned_document(doc_id, current_user)

    meta = doc.get("metadata") or {}
    meta.update(payload)
    
    update_document_metadata(doc_id, meta)
    
    # 활성 메모리 세션도 업데이트하여 정합성 유지
    from routers.upload import sessions
    if doc_id in sessions:
        sessions[doc_id]["metadata"] = meta
        
    return {"status": "success", "metadata": meta}

