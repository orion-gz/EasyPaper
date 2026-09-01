"""Import a directly linked PDF or a readable web article."""
from __future__ import annotations

import asyncio
import os
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from config import LIBRARY_DIR, UPLOAD_DIR
from models.schemas import UploadResponse, UrlImportRequest
from services.auth import get_current_user
from services.rate_limiter import enforce_rate_limit
from services.web_import import WebImportError, extract_article, fetch_url

router = APIRouter()


def _capabilities(kind: str) -> dict:
    common = {"translation": True, "search": True, "annotations": True, "memos": True, "chat": True, "export_pdf": True}
    return {**common, "coordinate_crop": kind == "pdf", "text_anchor_capture": kind == "html_article", "original_site": kind == "html_article"}


def _validate_options(body: UrlImportRequest) -> tuple[str, str]:
    from services.document_policy import feature_enabled, validate_classification
    from services.languages import normalize_document_language
    try:
        validate_classification(body.document_mode, body.document_type, allow_deprecated=False)
        if body.document_mode == "general" and not feature_enabled("general_document_mode"):
            raise ValueError("일반 문서 모드가 아직 활성화되지 않았습니다.")
        target = normalize_document_language(body.target_lang, allow_legacy=True)
        source = normalize_document_language(body.source_lang, allow_auto=True)
        return target, source
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/import-url", response_model=UploadResponse)
async def import_url(body: UrlImportRequest, current_user: str = Depends(get_current_user)):
    enforce_rate_limit("upload", current_user)
    target_lang, source_lang = _validate_options(body)
    try:
        fetched = await asyncio.to_thread(fetch_url, body.url)
    except WebImportError as exc:
        raise HTTPException(status_code=422, detail={"code": exc.code, "message": str(exc)}) from exc

    doc_id = str(uuid.uuid4())
    if fetched.kind == "remote_pdf":
        session_dir = Path(UPLOAD_DIR) / doc_id
        try:
            session_dir.mkdir(parents=True, exist_ok=False)
            pdf_path = session_dir / "document.pdf"
            partial_path = session_dir / "document.pdf.part"
            shutil.copyfile(fetched.temp_path, partial_path)
            with partial_path.open("rb") as source:
                os.fsync(source.fileno())
            os.replace(partial_path, pdf_path)
            downloaded_size = pdf_path.stat().st_size
            fetched.cleanup()
            from services.document_tasks import create_task
            from services.parse_job import execute_parse_task
            from services.pdf_parser import extract_pages, get_pdf_metadata
            from services.translation_job import start_job
            from services.insight_job import start_keyword_job, start_summary_job
            from routers.upload import sessions
            filename = Path(fetched.final_url.split("?", 1)[0]).name or "remote-document.pdf"
            if not filename.lower().endswith(".pdf"):
                filename += ".pdf"
            options = body.model_dump(exclude={"url"}) | {"filename": filename, "username": current_user, "source_lang": source_lang, "target_lang": target_lang, "file_size_mb": downloaded_size / 1048576}
            task = create_task(doc_id, "parse", options, status="queued")
            parsed = await execute_parse_task(task["id"], sessions, page_extractor=extract_pages, metadata_reader=get_pdf_metadata, translation_starter=start_job, keyword_starter=start_keyword_job, summary_starter=start_summary_job, upload_root=UPLOAD_DIR)
            from services.db import get_db
            from datetime import datetime, timezone
            fetched_at = datetime.now(timezone.utc).isoformat()
            with get_db() as conn:
                conn.execute("UPDATE documents SET source_origin='web', source_url=?, canonical_url=?, fetched_at=?, content_unit_count=total_pages WHERE id=?", (body.url, fetched.final_url, fetched_at, doc_id))
                conn.commit()
            parsed.update(file_size_mb=round(downloaded_size / 1048576, 2), source_origin="web", content_kind="pdf", source_url=body.url, canonical_url=fetched.final_url, fetched_at=fetched_at, total_units=parsed["total_pages"], capabilities=_capabilities("pdf"))
            return UploadResponse(**parsed)
        except HTTPException:
            fetched.cleanup()
            shutil.rmtree(session_dir, ignore_errors=True)
            raise
        except Exception as exc:
            fetched.cleanup()
            from services.db import db_delete_document
            db_delete_document(doc_id)
            shutil.rmtree(Path(LIBRARY_DIR) / doc_id, ignore_errors=True)
            shutil.rmtree(session_dir, ignore_errors=True)
            raise HTTPException(status_code=422, detail={"code": "invalid_pdf", "message": f"PDF 처리 실패: {exc}"}) from exc

    staging = Path(LIBRARY_DIR) / f".{doc_id}.importing"
    final_dir = Path(LIBRARY_DIR) / doc_id
    try:
        article_dir = staging / "article"
        try:
            downloaded_size = Path(fetched.temp_path).stat().st_size if fetched.temp_path else len(fetched.content or b"")
            manifest, pages = await asyncio.to_thread(extract_article, fetched, article_dir)
        finally:
            fetched.cleanup()
        (staging / "translations").mkdir(parents=True, exist_ok=True)
        staging.rename(final_dir)
        manifest_path = final_dir / "article" / "article.json"
        from services.languages import detect_document_language
        detection = detect_document_language(pages)
        from services.db import db_save_document
        metadata = {"title": manifest["title"], "source_url": body.url, "canonical_url": manifest["canonical_url"]}
        db_save_document(doc_id, current_user, f"{manifest['title']}.html", str(manifest_path), len(pages), metadata, document_mode=body.document_mode, document_type=body.document_type, source_language=source_lang, detected_source_language=str(detection["language"]), source_language_confidence=float(detection["confidence"]), preferred_target_language=target_lang, parser_engine="readability", parser_version="1", source_origin="web", content_kind="html_article", source_url=body.url, canonical_url=manifest["canonical_url"], fetched_at=manifest["fetched_at"], content_schema_version=1, content_unit_count=len(pages))
        from services.cache import save_pages_cache
        save_pages_cache(doc_id, str(manifest_path), pages, "readability", "1", strict=True)
        from services.context_retrieval import index_document_chunks
        index_document_chunks(doc_id, pages)
        from routers.upload import sessions
        sessions[doc_id] = {"pdf_path": str(manifest_path), "filename": f"{manifest['title']}.html", "pages": pages, "total_pages": len(pages), "metadata": metadata, "from_library": True, "username": current_user, "document_mode": body.document_mode, "document_type": body.document_type, "source_language": source_lang, "detected_source_language": detection["language"], "source_language_confidence": detection["confidence"], "preferred_target_language": target_lang, "processing_policy": "inherit", "content_revision": 1, "parser_engine": "readability", "parser_version": "1", "content_kind": "html_article", "source_origin": "web"}
        if body.translation_mode == "auto" and len(pages) < 50 and (source_lang if source_lang != "auto" else detection["language"]) != target_lang:
            from services.translation_job import start_job
            start_job(doc_id, pages, target_lang=target_lang, source_lang=source_lang if source_lang != "auto" else detection["language"], style=body.style, ignore_math=body.ignore_math, ignore_table=body.ignore_table, ignore_refs=body.ignore_refs)
        return UploadResponse(session_id=doc_id, filename=f"{manifest['title']}.html", total_pages=len(pages), file_size_mb=round(downloaded_size / 1048576, 2), metadata=metadata, document_mode=body.document_mode, document_type=body.document_type, source_language=source_lang, detected_source_language=str(detection["language"]), source_language_confidence=float(detection["confidence"]), preferred_target_language=target_lang, source_origin="web", content_kind="html_article", source_url=body.url, canonical_url=manifest["canonical_url"], fetched_at=manifest["fetched_at"], total_units=len(pages), capabilities=_capabilities("html_article"))
    except WebImportError as exc:
        shutil.rmtree(staging, ignore_errors=True); shutil.rmtree(final_dir, ignore_errors=True)
        raise HTTPException(status_code=422, detail={"code": exc.code, "message": str(exc)}) from exc
    except Exception as exc:
        from services.db import db_delete_document
        db_delete_document(doc_id)
        shutil.rmtree(staging, ignore_errors=True); shutil.rmtree(final_dir, ignore_errors=True)
        raise HTTPException(status_code=422, detail={"code": "article_processing_failed", "message": f"웹 문서 처리 실패: {exc}"}) from exc
