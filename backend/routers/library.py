from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import FileResponse, Response
from services.auth import get_current_user
from services.library import (
    list_documents, search_documents, get_document, permanently_delete_document,
    soft_delete_document, restore_document, empty_trash,
    get_translation, get_pdf_path, get_cover_path, update_document_metadata,
    get_chat_quote_image_path
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
    """개인 지식 그래프(논문/개념/메모 노드 + 인용/카테고리/개념보유/유사개념 엣지)를 반환합니다.

    /library/{doc_id}보다 먼저 등록해야 한다 - /library/search와 동일한
    이유로, 그렇지 않으면 "graph"가 doc_id 경로 파라미터로 잘못 매칭된다.
    """
    from services.knowledge_graph import get_graph_data
    return await get_graph_data(current_user)


@router.get("/library/graph/questions")
async def get_library_graph_questions(node_id: str, current_user: str = Depends(get_current_user)):
    """지식 그래프의 Concept/Paper 노드 클릭 시 상세 패널에 보여줄 관련 질문
    목록을 반환합니다. node_id는 "concept:{id}" 또는 "paper:{doc_id}" 형태."""
    from services.knowledge_graph import get_related_questions
    return {"questions": await get_related_questions(current_user, node_id)}


@router.get("/library/graph/search")
async def search_library_graph(q: str = "", current_user: str = Depends(get_current_user)):
    """지식 그래프 탭 전용 통합 검색(논문/개념/메모/질문)입니다. 질문은
    그래프 노드가 아니므로 매칭되면 그 질문이 연결된 concept/paper 노드로
    대체 매핑됩니다."""
    from services.knowledge_graph import search_graph_nodes
    return await search_graph_nodes(current_user, q)


@router.get("/library/graph/recommendations")
async def get_library_reading_recommendations(force: bool = False, current_user: str = Depends(get_current_user)):
    """읽은 논문들을 근거로 다음에 읽으면 좋을 논문을 추천합니다. LLM+OpenAlex
    호출이 여러 번 들어가는 무거운 작업이라 프론트에서 사용자가 명시적으로
    요청했을 때만 호출해야 합니다(그래프 조회 시 자동 호출 안 함).
    force=true면 유효한 캐시가 있어도 무시하고 새로 생성합니다(대시보드의
    "다시 받기" 버튼용).

    /library/{doc_id}보다 먼저 등록해야 한다 - /library/search와 동일한
    이유로, 그렇지 않으면 "graph"가 doc_id 경로 파라미터로 잘못 매칭된다.
    """
    from services.knowledge_graph import get_reading_recommendations
    return {"recommendations": await get_reading_recommendations(current_user, force=force)}


@router.get("/library/graph/recommendations/cached")
async def get_library_reading_recommendations_cached(current_user: str = Depends(get_current_user)):
    """대시보드 진입 시 호출하는 가벼운 버전입니다. 유효한 캐시가 있으면 그대로
    반환하고, 없거나 만료됐으면 LLM+OpenAlex를 호출해 새로 생성하지 않고
    recommendations: null을 반환합니다(대시보드를 열 때마다 무거운 재계산이
    도는 것을 방지 - 새로 생성은 여전히 "추천 받기" 버튼을 눌렀을 때만 함).

    /library/{doc_id}보다 먼저 등록해야 한다 - /library/search와 동일한
    이유로, 그렇지 않으면 "graph"가 doc_id 경로 파라미터로 잘못 매칭된다.
    """
    from services.knowledge_graph import get_cached_reading_recommendations
    return {"recommendations": await get_cached_reading_recommendations(current_user)}


@router.get("/library/timeline")
async def get_library_timeline(current_user: str = Depends(get_current_user)):
    """업로드/읽음/질문/메모를 시간순으로 병합한 개인 활동 타임라인을 반환합니다.

    /library/{doc_id}보다 먼저 등록해야 한다 - /library/search와 동일한
    이유로, 그렇지 않으면 "timeline"이 doc_id 경로 파라미터로 잘못 매칭된다.
    """
    from services.knowledge_graph import get_activity_timeline
    return {"events": await get_activity_timeline(current_user)}


@router.get("/library/graph/heatmap")
async def get_library_concept_heatmap(current_user: str = Depends(get_current_user)):
    """개념별 논문 수/질문 수를 활동량 순으로 반환합니다(Concept Heatmap).

    /library/{doc_id}보다 먼저 등록해야 한다 - /library/search와 동일한
    이유로, 그렇지 않으면 "graph"가 doc_id 경로 파라미터로 잘못 매칭된다.
    """
    from services.knowledge_graph import get_concept_heatmap
    return {"heatmap": await get_concept_heatmap(current_user)}


@router.get("/library/graph/gaps")
async def get_library_knowledge_gaps(current_user: str = Depends(get_current_user)):
    """질문이 거의 없는 개념, 메모 없이 읽음 표시된 논문 등 격차를 감지합니다
    (Knowledge Gap Detection, 순수 규칙 기반 - LLM 호출 없음).

    /library/{doc_id}보다 먼저 등록해야 한다.
    """
    from services.knowledge_graph import get_knowledge_gaps
    return {"gaps": await get_knowledge_gaps(current_user)}


@router.get("/library/dashboard")
async def get_library_dashboard(current_user: str = Depends(get_current_user)):
    """지식 그래프 탭의 "대시보드" 뷰에 필요한 통계/히트맵/격차/최근 활동을
    한 번에 반환합니다.

    /library/{doc_id}보다 먼저 등록해야 한다 - /library/search와 동일한
    이유로, 그렇지 않으면 "dashboard"가 doc_id 경로 파라미터로 잘못 매칭된다.
    """
    from services.knowledge_graph import get_dashboard_summary
    return await get_dashboard_summary(current_user)


class ReadingHeartbeatRequest(BaseModel):
    seconds: int
    category: str = "reading"


@router.get("/library/reading-stats")
async def get_library_reading_stats(since_days: Optional[int] = None, current_user: str = Depends(get_current_user)):
    """Reading History 페이지의 "읽은 시간" 관련 위젯(총 읽기 시간, 카테고리별
    시간 분포, 논문별 읽기 시간 랭킹)에 쓰이는 실측 집계를 반환합니다. 프론트가
    뷰어/비교 화면에서 보낸 하트비트(POST /library/{doc_id}/reading-heartbeat)를
    누적한 값이며, since_days를 주면 최근 N일로 제한합니다.

    /library/{doc_id}보다 먼저 등록해야 한다 - /library/search와 동일한
    이유로, 그렇지 않으면 "reading-stats"가 doc_id 경로 파라미터로 잘못 매칭된다.
    """
    from services.db import db_get_reading_time_stats
    return db_get_reading_time_stats(current_user, since_days)


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


@router.get("/library/{doc_id}/chat-image/{quote_id}")
async def get_library_chat_quote_image(doc_id: str, quote_id: str, current_user: str = Depends(get_current_user)):
    """채팅에서 인용한 이미지를 서빙합니다. 채팅을 보낸 브라우저의 localStorage에
    이미지가 있으면 프론트는 이 엔드포인트를 거치지 않고 그걸 우선 쓰고, 없을
    때(다른 기기/브라우저에서 히스토리를 열었을 때)만 여기서 복원합니다."""
    _require_owned_document(doc_id, current_user)
    image_path = get_chat_quote_image_path(doc_id, quote_id)
    if not image_path:
        raise HTTPException(status_code=404, detail="인용 이미지를 찾을 수 없습니다.")
    return FileResponse(image_path, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@router.delete("/library/{doc_id}")
async def delete_library_document(doc_id: str, current_user: str = Depends(get_current_user)):
    """라이브러리 문서를 휴지통으로 이동(Soft Delete)합니다."""
    _require_owned_document(doc_id, current_user)
    if not soft_delete_document(doc_id):
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다.")
    return {"message": "문서가 휴지통으로 이동되었습니다."}

@router.post("/library/{doc_id}/reading-heartbeat")
async def post_reading_heartbeat(doc_id: str, body: ReadingHeartbeatRequest, current_user: str = Depends(get_current_user)):
    """뷰어/비교 화면이 보이고 포커스된 동안 프론트가 주기적으로 보내는 경과
    시간(초)을 누적합니다. category는 'reading'(뷰어 기본) / 'chat'(채팅
    사이드바가 열려있는 동안) / 'compare'(논문 비교 채팅 화면) 중 하나입니다.
    한 번의 하트비트 간격(예: 20초) 이상을 보내는 조작을 막기 위해 상한을 둡니다."""
    _require_owned_document(doc_id, current_user)
    if body.category not in ("reading", "chat", "compare"):
        raise HTTPException(status_code=400, detail="알 수 없는 category입니다.")
    seconds = max(0, min(body.seconds, 120))
    from services.db import db_add_reading_time
    db_add_reading_time(doc_id, current_user, body.category, seconds)
    return {"message": "ok"}


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


@router.get("/library/{doc_id}/figure-image/{index}")
async def get_library_figure_image(doc_id: str, index: int, current_user: str = Depends(get_current_user)):
    """지식 그래프의 Figure/Table 노드 상세보기에서 실제 그림/표 영역을 PNG로
    크롭해 서빙합니다. 좌표는 클라이언트가 아니라 서버에 캐시된 좌표
    (get_cached_images)에서만 가져와, 신뢰할 수 없는 클라이언트 입력으로
    임의 좌표를 렌더링하지 않습니다."""
    from services.cache import get_cached_images
    from services.pdf_parser import render_image_crop_bytes

    _require_owned_document(doc_id, current_user)
    pdf_path = get_pdf_path(doc_id)
    if not pdf_path:
        raise HTTPException(status_code=404, detail="PDF 파일을 찾을 수 없습니다.")

    images = get_cached_images(doc_id, pdf_path)
    if images is None or index < 0 or index >= len(images):
        raise HTTPException(status_code=404, detail="Figure 정보를 찾을 수 없습니다.")

    img = images[index]
    # min_output_width: 상세 패널이 이미지를 패널 폭에 맞춰 확대 표시하므로,
    # 수식처럼 원본 영역이 작은 크롭도 최소 해상도를 보장해 흐려 보이지 않게 한다.
    png_bytes = render_image_crop_bytes(pdf_path, img["page"], img, min_output_width=900)
    if png_bytes is None:
        raise HTTPException(status_code=404, detail="Figure 이미지를 생성할 수 없습니다.")
    return Response(content=png_bytes, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


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


@router.get("/library/{doc_id}/bibliography")
async def get_library_bibliography(doc_id: str, current_user: str = Depends(get_current_user)):
    """Library 상세 패널 Quick Info의 Venue/DOI/ArXiv/Citations를 채운다. 논문
    자체의 서지 정보는 데이터베이스에 없으므로, 제목으로 OpenAlex를 검색해서
    찾는다(참고문헌 링크 연결과 동일한 무료/키 불필요 API - services/
    reference_linker.py). 첫 조회 때만 실제로 검색하고 결과를(못 찾은 경우도
    포함해서) documents.metadata.bibliography에 캐시해, 상세 패널을 열 때마다
    매번 외부 API를 다시 호출하지 않는다."""
    doc = _require_owned_document(doc_id, current_user)
    meta = doc.get("metadata") or {}

    cached = meta.get("bibliography")
    if cached:
        return cached

    from services.reference_linker import resolve_paper_metadata
    title = meta.get("title") or doc.get("filename") or ""
    result = await resolve_paper_metadata(title)

    bibliography = result or {"venue": None, "doi": None, "arxiv_id": None, "citation_count": None}
    meta["bibliography"] = bibliography
    update_document_metadata(doc_id, meta)
    return bibliography


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

