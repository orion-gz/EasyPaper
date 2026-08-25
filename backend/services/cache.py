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


def _pages_cache_path(doc_id: str, content_revision: int = 1) -> str:
    revision = max(1, int(content_revision))
    revision_part = "" if revision == 1 else f"_revision_{revision}"
    return os.path.join(CACHE_DIR, f"{doc_id}{revision_part}{_PAGES_CACHE_SUFFIX}")


def _document_content_revision(doc_id: str, content_revision: int | None) -> int:
    if content_revision is not None:
        return max(1, int(content_revision))
    try:
        from services.db import db_get_document
        doc = db_get_document(doc_id)
        if doc:
            return max(1, int(doc.get("content_revision") or 1))
    except Exception:
        pass
    return 1



def _document_parser_identity(doc_id: str, engine: str | None,
                              version: str | None) -> tuple[str, str]:
    if engine is None:
        try:
            from services.db import db_get_document
            doc = db_get_document(doc_id)
            if doc:
                engine = doc.get("parser_engine") or "pymupdf"
                if version is None:
                    version = doc.get("parser_version")
        except Exception:
            pass
    from services.pdf_diagnostics import parser_identity
    resolved_engine, resolved_version = parser_identity(engine)
    return resolved_engine, version if version is not None else resolved_version


def get_cached_pages(doc_id: str, pdf_path: str, engine: str | None = None,
                     version: str | None = None,
                     content_revision: int | None = None) -> Optional[list]:
    """Return cached pages only when PDF, parser, version, revision, and schema match."""
    revision = _document_content_revision(doc_id, content_revision)
    path = _pages_cache_path(doc_id, revision)
    if not os.path.exists(path):
        return None
    try:
        from services.pdf_diagnostics import (
            PAGES_CACHE_SCHEMA_VERSION, parser_identity, pdf_fingerprint,
        )
        expected_engine, expected_version = _document_parser_identity(doc_id, engine, version)
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if (
            data.get("cache_schema_version") != PAGES_CACHE_SCHEMA_VERSION
            or int(data.get("content_revision") or 1) != revision
            or data.get("pdf_fingerprint") != pdf_fingerprint(pdf_path)
            or data.get("parser_engine") != expected_engine
            or data.get("parser_version") != expected_version
        ):
            return None
        return data.get("pages")
    except Exception:
        return None


def save_pages_cache(doc_id: str, pdf_path: str, pages: list, engine: str | None = None,
                     version: str | None = None, content_revision: int | None = None,
                     strict: bool = False) -> None:
    """Persist parser- and revision-aware page extraction output."""
    try:
        revision = _document_content_revision(doc_id, content_revision)
        from services.pdf_diagnostics import (
            PAGES_CACHE_SCHEMA_VERSION, parser_identity, pdf_fingerprint,
        )
        actual_engine = engine or next(
            (str(page.get("parser_engine")) for page in pages if page.get("parser_engine")), None
        )
        actual_engine, actual_version = parser_identity(actual_engine)
        if version is not None:
            actual_version = version
        atomic_write_text(_pages_cache_path(doc_id, revision), json.dumps({
            "cache_schema_version": PAGES_CACHE_SCHEMA_VERSION,
            "content_revision": revision,
            "pdf_fingerprint": pdf_fingerprint(pdf_path),
            "parser_engine": actual_engine,
            "parser_version": actual_version,
            "pages": pages,
        }, ensure_ascii=False))
    except Exception:
        if strict:
            raise


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


def _images_cache_path(doc_id: str, content_revision: int = 1) -> str:
    revision = max(1, int(content_revision))
    revision_part = "" if revision == 1 else f"_revision_{revision}"
    return os.path.join(CACHE_DIR, f"{doc_id}{revision_part}{_IMAGES_CACHE_SUFFIX}")


def get_cached_images(doc_id: str, pdf_path: str, engine: str | None = None,
                      version: str | None = None,
                      content_revision: int | None = None) -> Optional[list]:
    """Return cached visual regions only for the matching parser identity and revision."""
    revision = _document_content_revision(doc_id, content_revision)
    path = _images_cache_path(doc_id, revision)
    if not os.path.exists(path):
        return None
    try:
        from services.pdf_diagnostics import (
            PAGES_CACHE_SCHEMA_VERSION, parser_identity, pdf_fingerprint,
        )
        expected_engine, expected_version = _document_parser_identity(doc_id, engine, version)
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if (
            data.get("cache_schema_version") != PAGES_CACHE_SCHEMA_VERSION
            or int(data.get("content_revision") or 1) != revision
            or data.get("pdf_fingerprint") != pdf_fingerprint(pdf_path)
            or data.get("parser_engine") != expected_engine
            or data.get("parser_version") != expected_version
        ):
            return None
        return data.get("images")
    except Exception:
        return None


def save_images_cache(doc_id: str, pdf_path: str, images: list, engine: str | None = None,
                      version: str | None = None, content_revision: int | None = None,
                      strict: bool = False) -> None:
    """Persist parser- and revision-aware image/table coordinates."""
    try:
        revision = _document_content_revision(doc_id, content_revision)
        from services.pdf_diagnostics import (
            PAGES_CACHE_SCHEMA_VERSION, parser_identity, pdf_fingerprint,
        )
        actual_engine, actual_version = parser_identity(engine)
        if version is not None:
            actual_version = version
        atomic_write_text(_images_cache_path(doc_id, revision), json.dumps({
            "cache_schema_version": PAGES_CACHE_SCHEMA_VERSION,
            "content_revision": revision,
            "pdf_fingerprint": pdf_fingerprint(pdf_path),
            "parser_engine": actual_engine,
            "parser_version": actual_version,
            "images": images,
        }, ensure_ascii=False))
    except Exception:
        if strict:
            raise


def clear_parser_revision_cache(doc_id: str, content_revision: int) -> None:
    """Remove only the parser caches staged for one content revision."""
    for path in (
        _pages_cache_path(doc_id, content_revision),
        _images_cache_path(doc_id, content_revision),
    ):
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass


def stage_parser_revision_caches(
    doc_id: str, pdf_path: str, pages: list, images: list,
    engine: str, version: str, content_revision: int,
) -> None:
    """Write and verify an inactive parser cache revision before DB activation."""
    revision = max(2, int(content_revision))
    clear_parser_revision_cache(doc_id, revision)
    try:
        save_pages_cache(
            doc_id, pdf_path, pages, engine, version,
            content_revision=revision, strict=True,
        )
        save_images_cache(
            doc_id, pdf_path, images, engine, version,
            content_revision=revision, strict=True,
        )
        if get_cached_pages(
            doc_id, pdf_path, engine, version, content_revision=revision,
        ) != pages:
            raise RuntimeError("staged_pages_cache_verification_failed")
        if get_cached_images(
            doc_id, pdf_path, engine, version, content_revision=revision,
        ) != images:
            raise RuntimeError("staged_images_cache_verification_failed")
    except Exception:
        clear_parser_revision_cache(doc_id, revision)
        raise


def clear_stale_parser_caches(doc_id: str, keep_revision: int) -> None:
    """Best-effort cleanup after the DB points at the verified revision."""
    keep = {
        _pages_cache_path(doc_id, keep_revision),
        _images_cache_path(doc_id, keep_revision),
    }
    prefix = f"{doc_id}_"
    for fname in os.listdir(CACHE_DIR):
        path = os.path.join(CACHE_DIR, fname)
        if (
            fname.startswith(prefix)
            and fname.endswith((_PAGES_CACHE_SUFFIX, _IMAGES_CACHE_SUFFIX))
            and path not in keep
        ):
            try:
                os.remove(path)
            except OSError:
                pass


def clear_derived_session_cache(doc_id: str) -> None:
    """Drop stale translation caches without deleting active parser revision data."""
    prefix = f"{doc_id}_"
    for fname in os.listdir(CACHE_DIR):
        if not fname.startswith(prefix):
            continue
        if fname.endswith((_PAGES_CACHE_SUFFIX, _IMAGES_CACHE_SUFFIX)):
            continue
        try:
            os.remove(os.path.join(CACHE_DIR, fname))
        except OSError:
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
    """Delete every parser cache revision for one document."""
    count = 0
    freed_bytes = 0
    prefix = f"{doc_id}_"
    for fname in os.listdir(CACHE_DIR):
        if not (
            fname.startswith(prefix)
            and fname.endswith((_PAGES_CACHE_SUFFIX, _IMAGES_CACHE_SUFFIX))
        ):
            continue
        path = os.path.join(CACHE_DIR, fname)
        try:
            freed_bytes += os.path.getsize(path)
            os.remove(path)
            count += 1
        except OSError:
            pass
    return count, freed_bytes

