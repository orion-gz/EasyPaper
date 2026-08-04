import json
import os
from typing import Optional
from config import CACHE_DIR
from services.atomic_io import atomic_write_text


def _cache_path(session_id: str, page_num: int, suffix: str = "") -> str:
    suffix_part = f"_{suffix}" if suffix else ""
    return os.path.join(CACHE_DIR, f"{session_id}_page_{page_num}{suffix_part}.json")


def get_cached_translation(session_id: str, page_num: int, suffix: str = "") -> Optional[str]:
    """캐시된 번역 결과를 반환합니다. 없으면 None."""
    path = _cache_path(session_id, page_num, suffix)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            val = data.get("translation")
            if isinstance(val, str) and val.startswith("{"):
                try:
                    inner = json.loads(val)
                    if isinstance(inner, dict) and "translation" in inner:
                        return inner["translation"]
                except Exception:
                    pass
            return val
    except Exception:
        return None


def get_cached_translation_full(session_id: str, page_num: int, suffix: str = "") -> dict:
    """캐시된 번역 결과와 매핑 데이터를 통째로 반환합니다."""
    path = _cache_path(session_id, page_num, suffix)
    if not os.path.exists(path):
        return {"translation": "", "sentences": []}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            val = data.get("translation")
            if isinstance(val, str) and val.startswith("{"):
                try:
                    inner = json.loads(val)
                    if isinstance(inner, dict) and "translation" in inner:
                        return inner
                except Exception:
                    pass
            if "translation" not in data:
                data["translation"] = ""
            if "sentences" not in data:
                data["sentences"] = []
            return data
    except Exception:
        return {"translation": "", "sentences": []}


def save_translation_cache(session_id: str, page_num: int, translation: str, suffix: str = "") -> None:
    """번역 결과를 파일 캐시에 저장합니다."""
    path = _cache_path(session_id, page_num, suffix)
    if translation.startswith("{"):
        try:
            data = json.loads(translation)
            if isinstance(data, dict) and "translation" in data:
                atomic_write_text(path, json.dumps(data, ensure_ascii=False))
                return
        except Exception:
            pass

    atomic_write_text(path, json.dumps({"translation": translation}, ensure_ascii=False))


def clear_session_cache(session_id: str) -> None:
    """세션의 모든 캐시 파일을 삭제합니다."""
    for fname in os.listdir(CACHE_DIR):
        if fname.startswith(session_id):
            os.remove(os.path.join(CACHE_DIR, fname))


_PAGES_CACHE_SUFFIX = "_pages_extract.json"


def _pages_cache_path(doc_id: str) -> str:
    return os.path.join(CACHE_DIR, f"{doc_id}{_PAGES_CACHE_SUFFIX}")


def get_cached_pages(doc_id: str, pdf_path: str) -> Optional[list]:
    """PDF에서 추출한 페이지 텍스트(extract_pages 결과)의 디스크 캐시를
    반환합니다. 캐시가 없거나, 원본 PDF의 mtime/크기가 캐시 저장 당시와
    달라졌다면(파일이 교체된 경우 등) None을 반환해 재추출을 유도합니다.
    """
    path = _pages_cache_path(doc_id)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        stat = os.stat(pdf_path)
        if data.get("mtime") != stat.st_mtime or data.get("size") != stat.st_size:
            return None
        return data.get("pages")
    except Exception:
        return None


def save_pages_cache(doc_id: str, pdf_path: str, pages: list) -> None:
    """extract_pages() 결과를 디스크에 캐싱해, 다음 서버 재시작 이후
    첫 열람 시에도 PDF를 다시 파싱하지 않고 즉시 불러올 수 있게 합니다."""
    try:
        stat = os.stat(pdf_path)
        atomic_write_text(_pages_cache_path(doc_id), json.dumps({
            "mtime": stat.st_mtime,
            "size": stat.st_size,
            "pages": pages,
        }, ensure_ascii=False))
    except Exception:
        pass


def clear_all_pages_cache() -> "tuple[int, int]":
    """모든 문서의 페이지 추출 캐시 파일을 삭제합니다.
    (삭제한 파일 개수, 확보한 바이트 수)를 반환합니다."""
    count = 0
    freed_bytes = 0
    for fname in os.listdir(CACHE_DIR):
        if fname.endswith(_PAGES_CACHE_SUFFIX):
            path = os.path.join(CACHE_DIR, fname)
            try:
                freed_bytes += os.path.getsize(path)
                os.remove(path)
                count += 1
            except Exception:
                pass
    return count, freed_bytes


_IMAGES_CACHE_SUFFIX = "_images_extract.json"


def _images_cache_path(doc_id: str) -> str:
    return os.path.join(CACHE_DIR, f"{doc_id}{_IMAGES_CACHE_SUFFIX}")


def get_cached_images(doc_id: str, pdf_path: str) -> Optional[list]:
    """extract_pdf_images() 결과(그림/표 좌표)의 디스크 캐시를 반환합니다.
    캐시가 없거나 원본 PDF의 mtime/크기가 저장 당시와 달라졌다면 None을
    반환해 재추출을 유도합니다. get_cached_pages()와 동일한 방식이다 -
    이 함수가 없으면 문서를 열 때마다 매번 PyMuPDF로 페이지별 표/그림
    탐지(find_tables, get_drawings 등 비용이 큰 연산)를 처음부터 다시
    수행하게 되어, 텍스트 추출 캐시가 있어도 열람이 계속 느리다."""
    path = _images_cache_path(doc_id)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        stat = os.stat(pdf_path)
        if data.get("mtime") != stat.st_mtime or data.get("size") != stat.st_size:
            return None
        return data.get("images")
    except Exception:
        return None


def save_images_cache(doc_id: str, pdf_path: str, images: list) -> None:
    """extract_pdf_images() 결과를 디스크에 캐싱합니다."""
    try:
        stat = os.stat(pdf_path)
        atomic_write_text(_images_cache_path(doc_id), json.dumps({
            "mtime": stat.st_mtime,
            "size": stat.st_size,
            "images": images,
        }, ensure_ascii=False))
    except Exception:
        pass


def clear_all_images_cache() -> "tuple[int, int]":
    """모든 문서의 이미지/표 좌표 추출 캐시 파일을 삭제합니다.
    (삭제한 파일 개수, 확보한 바이트 수)를 반환합니다."""
    count = 0
    freed_bytes = 0
    for fname in os.listdir(CACHE_DIR):
        if fname.endswith(_IMAGES_CACHE_SUFFIX):
            path = os.path.join(CACHE_DIR, fname)
            try:
                freed_bytes += os.path.getsize(path)
                os.remove(path)
                count += 1
            except Exception:
                pass
    return count, freed_bytes


def clear_document_cache(doc_id: str) -> "tuple[int, int]":
    """단일 문서의 PDF 텍스트 및 이미지/표 좌표 추출 디스크 캐시를 삭제합니다.
    (삭제한 파일 개수, 확보한 바이트 수)를 반환합니다.
    """
    count = 0
    freed_bytes = 0
    pages_path = _pages_cache_path(doc_id)
    if os.path.exists(pages_path):
        try:
            freed_bytes += os.path.getsize(pages_path)
            os.remove(pages_path)
            count += 1
        except Exception:
            pass

    images_path = _images_cache_path(doc_id)
    if os.path.exists(images_path):
        try:
            freed_bytes += os.path.getsize(images_path)
            os.remove(images_path)
            count += 1
        except Exception:
            pass

    return count, freed_bytes

