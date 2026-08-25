import os
import re
import shutil
import json
import base64
from typing import Optional, List
from config import LIBRARY_DIR, UPLOAD_DIR
from services.cache import clear_session_cache
from services.db import (
    db_save_document,
    db_get_document,
    db_list_documents,
    db_search_documents,
    db_delete_document,
    db_soft_delete_document,
    db_restore_document,
    db_save_translation,
    db_get_translation,
    db_clear_translations,
    db_save_page_insight,
    db_get_page_insight,
    db_clear_page_insights,
    db_delete_page_insight,
    db_update_document_metadata,
    db_patch_document_metadata,
    db_bulk_translation_rows,
    db_list_folders, db_get_folder, db_create_folder, db_update_folder, db_delete_folder,
    db_get_document_folder_map, db_move_documents_to_folder,
)


def _attach_processing_status(doc: dict) -> dict:
    from services.processing_policy import document_processing_status
    doc["processing"] = document_processing_status(doc)
    return doc


def _translation_suffix_for_doc(doc: dict, target_lang: Optional[str], style: Optional[str], ignore_math: Optional[bool], ignore_table: Optional[bool], ignore_refs: Optional[bool]) -> Optional[str]:
    if target_lang is None or style is None:
        return None
    from services.document_policy import translation_cache_suffix
    return translation_cache_suffix(
        doc.get("document_mode", "research"),
        doc.get("document_type", "research_paper"),
        target_lang, style, bool(ignore_math), bool(ignore_table), bool(ignore_refs),
    )


def _resolve_translated_pages(rows: list, suffix: Optional[str]) -> list:
    """(page_num, suffix, saved_at) 행 목록에서 문서 하나의 "번역 완료 페이지"
    목록을 계산합니다. 요청한 suffix로 번역된 페이지가 있으면 그걸 쓰고,
    없으면 가장 최근에 저장된 suffix의 페이지로 대체합니다(예전 설정으로
    번역해둔 문서를 다른 target_lang/style로 열어도 목록이 비어 보이지
    않도록). 원래 services/db.py의 db_get_translation()과 동일한 fallback
    규칙이다."""
    if not rows:
        return []
    if suffix:
        pages = sorted({r[0] for r in rows if r[1] == suffix})
        if pages:
            return pages
    fallback_suffix = max(rows, key=lambda r: r[2])[1]
    return sorted({r[0] for r in rows if r[1] == fallback_suffix})

def _pdf_path(doc_id: str) -> str:
    return os.path.join(LIBRARY_DIR, doc_id, "document.pdf")

def _cover_path(doc_id: str) -> str:
    return os.path.join(LIBRARY_DIR, doc_id, "cover.jpg")

def _primer_figure_path(doc_id: str) -> str:
    return os.path.join(LIBRARY_DIR, doc_id, "primer_figure.png")

# 프론트에서 생성하는 quoteId(예: qimg_1700000000000_ab12cd) 형식만 허용해
# 파일 경로로 그대로 써도 경로 순회(path traversal)가 불가능하게 한다.
_CHAT_QUOTE_IMAGE_ID_RE = re.compile(r'^[A-Za-z0-9_]+$')

def _chat_quote_image_path(doc_id: str, quote_id: str) -> Optional[str]:
    if not _CHAT_QUOTE_IMAGE_ID_RE.match(quote_id):
        return None
    return os.path.join(LIBRARY_DIR, doc_id, "chat_images", f"{quote_id}.png")


# ── 문서 저장 ─────────────────────────────────────────────────────────────────

def save_document(doc_id: str, filename: str, pdf_src_path: str,
                  total_pages: int, metadata: dict, username: str = "admin",
                  document_mode: str = "research", document_type: str = "research_paper",
                  source_language: str = "auto", detected_source_language: str = "und",
                  source_language_confidence: Optional[float] = None,
                  preferred_target_language: Optional[str] = None,
                  content_revision: int = 1, parser_engine: str = "pymupdf",
                  parser_version: Optional[str] = None) -> dict:
    """PDF를 라이브러리에 영구 저장하고 데이터베이스에 기록합니다."""
    doc_dir = os.path.join(LIBRARY_DIR, doc_id)
    os.makedirs(os.path.join(doc_dir, "translations"), exist_ok=True)

    # PDF 파일 복사
    shutil.copy2(pdf_src_path, _pdf_path(doc_id))

    # 데이터베이스에 저장
    doc_meta = db_save_document(
        doc_id, username, filename, _pdf_path(doc_id), total_pages, metadata,
        document_mode=document_mode, document_type=document_type,
        source_language=source_language, detected_source_language=detected_source_language,
        source_language_confidence=source_language_confidence,
        preferred_target_language=preferred_target_language,
        content_revision=content_revision, parser_engine=parser_engine,
        parser_version=parser_version,
    )
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
        suffix = _translation_suffix_for_doc(
            doc, target_lang, style, ignore_math, ignore_table, ignore_refs,
        )

        rows = db_bulk_translation_rows([doc_id]).get(doc_id, [])
        doc["translated_pages"] = _resolve_translated_pages(rows, suffix)
        _attach_processing_status(doc)
        return doc
    return None


def list_documents(
    username: Optional[str] = None,
    target_lang: Optional[str] = None,
    style: Optional[str] = None,
    ignore_math: Optional[bool] = None,
    ignore_table: Optional[bool] = None,
    ignore_refs: Optional[bool] = None,
    only_trash: bool = False,
    include_deleted: bool = False,
    document_mode: Optional[str] = None,
) -> list:
    """라이브러리의 문서를 최신순으로 반환합니다 (필터링 가능).

    예전에는 문서마다 새 SQLite 커넥션을 열어 최대 3개의 쿼리를 던졌다(N+1).
    문서 수와 4초 주기 폴링이 곱해지며 라이브러리 화면 자체가 느려지는
    주 원인이었던 부분 - 이제 전체 문서의 번역 행을 한 번의 커넥션으로 모아
    메모리에서 매칭한다."""
    docs = db_list_documents(username, only_trash=only_trash, include_deleted=include_deleted, document_mode=document_mode)
    if not docs:
        return docs

    rows_by_doc = db_bulk_translation_rows([doc["id"] for doc in docs])
    folder_map = db_get_document_folder_map(username) if username else {}
    for doc in docs:
        suffix = _translation_suffix_for_doc(
            doc, target_lang, style, ignore_math, ignore_table, ignore_refs,
        )
        doc["translated_pages"] = _resolve_translated_pages(rows_by_doc.get(doc["id"], []), suffix)
        doc["folder_id"] = folder_map.get(doc["id"])
        _attach_processing_status(doc)
    return docs


def search_documents(username: str, query: str, only_trash: bool = False, document_mode: Optional[str] = None) -> list:
    """파일명/제목·카테고리와 번역된 텍스트를 가로질러 검색어와 매칭되는
    문서 목록을 최신순으로 반환합니다."""
    query = (query or "").strip()
    if not query:
        return []
    docs = db_search_documents(username, query, only_trash=only_trash, document_mode=document_mode)
    if not docs:
        return docs

    rows_by_doc = db_bulk_translation_rows([doc["id"] for doc in docs])
    folder_map = db_get_document_folder_map(username) if username else {}
    for doc in docs:
        doc["folder_id"] = folder_map.get(doc["id"])
        pages = sorted({r[0] for r in rows_by_doc.get(doc["id"], [])})
        doc["translated_pages"] = pages
        _attach_processing_status(doc)
    return docs


# ── 라이브러리 폴더 ───────────────────────────────────────────────────────────

def list_folders(username: str) -> list:
    return db_list_folders(username)

def create_folder(username: str, folder_id: str, name: str, parent_id: Optional[str], color: str) -> dict:
    if parent_id and not db_get_folder(parent_id, username):
        raise ValueError("상위 폴더를 찾을 수 없습니다.")
    return db_create_folder(folder_id, username, name, parent_id, color)

def _is_descendant(folder_id: str, parent_id: Optional[str], username: str) -> bool:
    current = parent_id
    while current:
        if current == folder_id:
            return True
        folder = db_get_folder(current, username)
        current = folder.get("parent_id") if folder else None
    return False

def update_folder(username: str, folder_id: str, name: Optional[str] = None, color: Optional[str] = None, parent_id: Optional[str] = None, move: bool = False) -> bool:
    folder = db_get_folder(folder_id, username)
    if not folder:
        raise ValueError("폴더를 찾을 수 없습니다.")
    updates = {}
    if name is not None: updates["name"] = name
    if color is not None: updates["color"] = color
    if move:
        if parent_id and not db_get_folder(parent_id, username):
            raise ValueError("대상 폴더를 찾을 수 없습니다.")
        if parent_id == folder_id or _is_descendant(folder_id, parent_id, username):
            raise ValueError("폴더를 자기 자신 또는 하위 폴더로 옮길 수 없습니다.")
        updates["parent_id"] = parent_id
    return db_update_folder(folder_id, username, **updates)

def delete_folder(username: str, folder_id: str, delete_papers: bool = False) -> bool:
    return db_delete_folder(folder_id, username, delete_papers)

def move_documents_to_folder(username: str, doc_ids: List[str], folder_id: Optional[str]) -> int:
    if folder_id and not db_get_folder(folder_id, username):
        raise ValueError("대상 폴더를 찾을 수 없습니다.")
    return db_move_documents_to_folder(doc_ids, username, folder_id)


def delete_chat_sessions(doc_id: str) -> None:
    """논문 삭제 시 연동된 Claude Code 및 Antigravity 채팅 세션을 삭제합니다."""
    # 1. Claude Code 세션 캐시 디렉터리 삭제
    cache_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cache")
    claude_home = os.path.join(cache_dir, f"claude_home_{doc_id}")
    if os.path.exists(claude_home):
        try:
            shutil.rmtree(claude_home, ignore_errors=True)
            print(f"[delete_chat_sessions] Deleted Claude Code session directory: {claude_home}")
        except Exception as e:
            print(f"[delete_chat_sessions Claude Code Error] {e}")

    # 2. Antigravity 세션 삭제 (신규 ai_session.json 우선, 예전 conversation_id.txt는 폴백)
    conv_id = None
    meta_path = os.path.join(LIBRARY_DIR, doc_id, "ai_session.json")
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            providers = meta.get("providers")
            if isinstance(providers, dict):
                antigravity_meta = providers.get("antigravity")
                if isinstance(antigravity_meta, dict):
                    conv_id = antigravity_meta.get("conversation_id")
            elif meta.get("provider") == "antigravity":
                # ai_session.json provider별 구조 전환 전의 기존 파일 지원
                conv_id = meta.get("conversation_id")
        except Exception as e:
            print(f"[delete_chat_sessions Antigravity Error] {e}")
    if not conv_id:
        conv_txt_path = os.path.join(LIBRARY_DIR, doc_id, "conversation_id.txt")
        if os.path.exists(conv_txt_path):
            try:
                with open(conv_txt_path, "r", encoding="utf-8") as f:
                    conv_id = f.read().strip()
            except Exception as e:
                print(f"[delete_chat_sessions Antigravity Error] {e}")
    if conv_id:
        try:
            # conversations/<conv_id>.db 파일 삭제
            db_path = os.path.expanduser(f"~/.gemini/antigravity-cli/conversations/{conv_id}.db")
            if os.path.exists(db_path):
                os.remove(db_path)
                print(f"[delete_chat_sessions] Deleted Antigravity conversation db: {db_path}")
            # brain/<conv_id>/ 디렉터리 삭제
            brain_dir = os.path.expanduser(f"~/.gemini/antigravity-cli/brain/{conv_id}")
            if os.path.exists(brain_dir):
                shutil.rmtree(brain_dir, ignore_errors=True)
                print(f"[delete_chat_sessions] Deleted Antigravity brain directory: {brain_dir}")
        except Exception as e:
            print(f"[delete_chat_sessions Antigravity Error] {e}")


def permanently_delete_document(doc_id: str) -> bool:
    """라이브러리에서 문서 파일 및 데이터베이스 레코드를 영구히 삭제합니다.

    doc_id는 업로드 당시의 session_id와 동일한 값이다 - 업로드 시
    UPLOAD_DIR/{doc_id}/document.pdf에 원본이 저장되고, 라이브러리에 저장될
    때 LIBRARY_DIR/{doc_id}/document.pdf로 "복사"만 될 뿐 원본은 그대로
    남는다. 예전에는 LIBRARY_DIR만 지우고 UPLOAD_DIR의 원본과 CACHE_DIR의
    페이지별 번역 캐시 파일은 전혀 지우지 않아, 문서를 영구 삭제해도 그
    파일들이 디스크에 계속 쌓이는 문제가 있었다.
    """
    doc_dir = os.path.join(LIBRARY_DIR, doc_id)
    upload_dir = os.path.join(UPLOAD_DIR, doc_id)

    # 1. 채팅 세션 삭제
    delete_chat_sessions(doc_id)
    # 2. 라이브러리 보관 파일 삭제 (PDF 사본, 커버 이미지, MD 등)
    if os.path.exists(doc_dir):
        shutil.rmtree(doc_dir, ignore_errors=True)
    # 3. 업로드 당시 원본 파일 삭제
    if os.path.exists(upload_dir):
        shutil.rmtree(upload_dir, ignore_errors=True)
    # 4. 페이지별 번역 캐시 파일 삭제
    clear_session_cache(doc_id)
    # 5. 메모리에 남아있는 활성 업로드 세션도 정리 (있다면)
    try:
        from routers.upload import sessions
        sessions.pop(doc_id, None)
    except Exception:
        pass
    # 6. DB 삭제
    return db_delete_document(doc_id)

def soft_delete_document(doc_id: str) -> bool:
    """라이브러리 문서를 휴지통으로 이동(Soft Delete)시킵니다."""
    return db_soft_delete_document(doc_id)

def restore_document(doc_id: str) -> bool:
    """휴지통의 문서를 복원합니다."""
    return db_restore_document(doc_id)

def empty_trash(username: str = "admin") -> bool:
    """휴지통에 있는 모든 문서를 영구 삭제(하드 딜리트)합니다."""
    trashed_docs = db_list_documents(username, only_trash=True)
    for doc in trashed_docs:
        permanently_delete_document(doc["id"])
    return True


# ── 번역 저장/조회 ─────────────────────────────────────────────────────────────

def save_translation(doc_id: str, page_num: int, translation: str, suffix: str = "") -> None:
    """번역 결과를 데이터베이스에 저장합니다."""
    db_save_translation(doc_id, page_num, translation, suffix)


def get_translation(doc_id: str, page_num: int, suffix: str = "", fallback: bool = True) -> Optional[str]:
    """데이터베이스에서 번역 결과를 가져옵니다."""
    val = db_get_translation(doc_id, page_num, suffix, fallback)
    if val and val.startswith("{"):
        try:
            data = json.loads(val)
            if isinstance(data, dict) and "translation" in data:
                return data["translation"]
        except Exception:
            pass
    return val


def get_translation_full(doc_id: str, page_num: int, suffix: str = "", fallback: bool = True) -> dict:
    """데이터베이스에서 번역 결과와 문장 매핑 데이터를 통째로 가져옵니다."""
    val = db_get_translation(doc_id, page_num, suffix, fallback)
    if val and val.startswith("{"):
        try:
            data = json.loads(val)
            if isinstance(data, dict) and "translation" in data:
                return data
        except Exception:
            pass
    return {"translation": val or "", "sentences": []}


def clear_translations(doc_id: str) -> None:
    """데이터베이스에서 모든 번역 데이터를 지웁니다."""
    db_clear_translations(doc_id)


# ── 페이지 인사이트 (키워드/단어, 요약) ─────────────────────────────────────────

def save_page_insight(doc_id: str, page_num: int, kind: str, content: str, suffix: str = "") -> None:
    """키워드/단어 설명 또는 요약 결과를 데이터베이스에 저장합니다."""
    db_save_page_insight(doc_id, page_num, kind, content, suffix)


def get_page_insight(doc_id: str, page_num: int, kind: str, suffix: str = "") -> Optional[str]:
    """데이터베이스에서 키워드/단어 설명 또는 요약 결과를 가져옵니다."""
    return db_get_page_insight(doc_id, page_num, kind, suffix)


def clear_page_insights(doc_id: str) -> None:
    """데이터베이스에서 모든 페이지 인사이트(키워드/요약) 데이터를 지웁니다."""
    db_clear_page_insights(doc_id)


def delete_page_insight(doc_id: str, page_num: int, kind: str, suffix: str = "") -> None:
    """특정 kind/suffix 하나의 페이지 인사이트만 지웁니다."""
    db_delete_page_insight(doc_id, page_num, kind, suffix)


def get_pdf_path(doc_id: str) -> Optional[str]:
    """라이브러리 PDF 파일 경로를 반환합니다."""
    path = _pdf_path(doc_id)
    return path if os.path.exists(path) else None

def get_cover_path(doc_id: str) -> Optional[str]:
    """1페이지 상단(제목+abstract) 미리보기 이미지 경로를 반환합니다. 아직 생성되지
    않았다면 이 시점에 만들어 캐시합니다(문서당 최초 1회만 렌더링 비용 발생)."""
    pdf_path = get_pdf_path(doc_id)
    if not pdf_path:
        return None
    cover_path = _cover_path(doc_id)
    if not os.path.exists(cover_path):
        from services.pdf_parser import render_cover_image
        try:
            if not render_cover_image(pdf_path, cover_path):
                return None
        except Exception as e:
            print(f"[get_cover_path] 표지 이미지 생성 실패 ({doc_id}): {e}")
            return None
    return cover_path

def get_primer_figure_path(doc_id: str) -> Optional[str]:
    """읽기 전 브리핑에 쓰이는 대표 Figure 크롭 이미지 경로를 반환합니다. primer 생성
    파이프라인(save_primer_figure)에서만 생성되므로, 아직 생성되지 않았다면 None."""
    path = _primer_figure_path(doc_id)
    return path if os.path.exists(path) else None


def save_chat_quote_image(doc_id: str, quote_id: str, image_base64: str) -> None:
    """채팅에서 인용한 이미지를 문서별 디렉터리에 PNG로 저장한다. 기존에는
    브라우저 localStorage에만 저장돼 다른 기기/브라우저로 접속하면 이미지가
    사라지고 텍스트 placeholder만 남았는데, 여기(document.pdf/cover.jpg와
    같은 문서별 디렉터리)에도 남겨 어디서든 복원할 수 있게 한다."""
    path = _chat_quote_image_path(doc_id, quote_id)
    if not path:
        raise ValueError("잘못된 quote_id입니다.")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(base64.b64decode(image_base64))


def get_chat_quote_image_path(doc_id: str, quote_id: str) -> Optional[str]:
    """서버에 저장된 인용 이미지 경로를 반환한다. 저장된 적이 없다면(이번 기능
    추가 이전 메시지이거나 저장에 실패했던 경우) None."""
    path = _chat_quote_image_path(doc_id, quote_id)
    return path if path and os.path.exists(path) else None


def save_primer_figure(doc_id: str, pdf_path: str, page_num: int, bbox_percent: dict) -> bool:
    """primer 생성 파이프라인에서 대표 Figure 영역을 크롭해 캐시합니다."""
    from services.pdf_parser import render_image_crop
    try:
        return render_image_crop(pdf_path, page_num, bbox_percent, _primer_figure_path(doc_id))
    except Exception as e:
        print(f"[save_primer_figure] Figure 크롭 실패 ({doc_id}): {e}")
        return False


def update_document_metadata(doc_id: str, metadata: dict) -> None:
    """문서 메타데이터를 업데이트합니다."""
    db_update_document_metadata(doc_id, metadata)


def patch_document_metadata(
    doc_id: str,
    updates: dict,
    remove_keys: tuple[str, ...] = (),
) -> Optional[dict]:
    """Atomically merge metadata fields and return the persisted metadata."""
    return db_patch_document_metadata(doc_id, updates, remove_keys)


def get_reference_start_page(doc: dict) -> Optional[int]:
    """문서에서 참고문헌 섹션이 시작하는 페이지 번호(1-based)를 반환합니다
    ("읽은 페이지 수"를 계산할 때 참고문헌 페이지를 본문에서 제외하는 데
    씀). metadata.reference_start_page에 이미 계산된 값(참고문헌을 못 찾은
    경우는 None)이 있으면 그대로 쓰고, 아직 계산한 적이 없으면(키 자체가
    없음) 캐시된 페이지 텍스트가 있을 때만 계산해 metadata에 영구 저장합니다
    - 페이지 텍스트가 아직 캐시되지 않은 문서(처리 중/실패)까지 이 함수
    때문에 PDF를 새로 파싱하지는 않고, 다음에 캐시가 생기면 그때 계산합니다.
    doc는 list_documents()/get_document()가 반환하는 dict(“metadata” 포함)여야
    하며, 계산 결과는 그 자리에서 doc["metadata"]에도 반영됩니다(같은 요청
    안에서 곧바로 다시 읽어도 최신 값을 보게 하기 위함)."""
    meta = doc.get("metadata")
    if meta is None:
        meta = {}
        doc["metadata"] = meta
    if "reference_start_page" in meta:
        return meta["reference_start_page"]

    pdf_path = doc.get("pdf_path")
    if not pdf_path:
        return None
    from services.cache import get_cached_pages
    pages = get_cached_pages(doc["id"], pdf_path)
    if pages is None:
        return None  # 아직 캐시가 없다 - 계산은 다음 기회로 미루고 지금은 저장하지 않는다

    from services.reference_parser import find_reference_start_page_index
    idx = find_reference_start_page_index(pages)
    start_page = (idx + 1) if idx is not None else None  # 0-based 인덱스 -> 1-based 페이지 번호

    meta["reference_start_page"] = start_page
    patch_document_metadata(doc["id"], {"reference_start_page": start_page})
    return start_page


def read_page_count(doc: dict) -> int:
    """이 문서에서 실제로 "읽은" 것으로 볼 수 있는 페이지 수를 계산합니다:
    완독 표시(metadata.read)된 문서는 참고문헌을 제외한 본문 페이지 수
    전체를, 읽던 중인 문서(metadata.last_page만 있음)는 그 진행률(참고문헌
    페이지를 넘지 않게 상한)을, 둘 다 아니면 0을 반환합니다. 대시보드/Reading
    History의 "읽은 페이지" 계열 통계가 전부 이 함수를 공유합니다."""
    meta = doc.get("metadata") or {}
    total = doc.get("total_pages") or 0
    ref_start = get_reference_start_page(doc)
    content_pages = (ref_start - 1) if isinstance(ref_start, int) and 1 < ref_start <= total else total

    if meta.get("read") is True:
        return content_pages
    last_page = meta.get("last_page")
    if isinstance(last_page, int):
        return min(last_page, content_pages)
    return 0
