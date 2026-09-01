import uuid
import os
import shutil
from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from fastapi.responses import JSONResponse
import aiofiles
from services.auth import get_current_user

from config import UPLOAD_DIR, MAX_FILE_SIZE_MB
from services.pdf_parser import extract_pages, get_pdf_metadata
from services.library import get_document, get_pdf_path as lib_pdf_path, list_documents
from services.translation_job import start_job, resume_incomplete_jobs, get_job_status
from services.insight_job import start_keyword_job, start_summary_job
from services.rate_limiter import enforce_rate_limit
from models.schemas import UploadResponse

router = APIRouter()

# 메모리 내 세션 저장소
sessions: dict = {}


def ensure_session(session_id: str) -> bool:
    """세션이 메모리에 존재하는지 확인하고, 없다면 DB에서 조회하여 복구합니다."""
    if session_id in sessions:
        return True
    
    from services.db import db_get_document
    doc = db_get_document(session_id)
    if not doc:
        return False
        
    pdf_path = doc["pdf_path"]
    if not os.path.exists(pdf_path):
        pdf_path = lib_pdf_path(session_id)
        if not pdf_path or not os.path.exists(pdf_path):
            return False
            
    try:
        from services.cache import get_cached_pages, save_pages_cache
        parser_engine = doc.get("parser_engine") or "pymupdf"
        parser_version = doc.get("parser_version")
        pages = get_cached_pages(session_id, pdf_path, parser_engine, parser_version)
        if pages is None:
            if doc.get("content_kind") == "html_article":
                from services.web_import import pages_from_manifest
                pages = pages_from_manifest(pdf_path)
                parser_engine = "readability"
                parser_version = str(doc.get("content_schema_version") or 1)
            elif parser_engine in {"marker", "mineru"}:
                from services.reparse import parse_document_isolated
                payload = parse_document_isolated(pdf_path, parser_engine)
                pages = payload["pages"]
                parser_version = payload["parser_version"]
                from services.cache import save_images_cache
                save_images_cache(
                    session_id, pdf_path, payload.get("images") or [],
                    parser_engine, parser_version,
                )
            else:
                pages = extract_pages(pdf_path, engine=parser_engine)
                from services.pdf_diagnostics import parser_version as resolve_parser_version
                parser_version = resolve_parser_version(parser_engine)
            save_pages_cache(session_id, pdf_path, pages, parser_engine, parser_version)
        if doc.get("source_language", "auto") == "auto" and doc.get("detected_source_language", "und") == "und":
            from services.languages import detect_document_language
            detection = detect_document_language(pages)
            doc["detected_source_language"] = detection["language"]
            doc["source_language_confidence"] = detection["confidence"]
            from services.db import db_update_detected_source_language
            db_update_detected_source_language(session_id, str(detection["language"]), float(detection["confidence"]))

        # 기존 문서는 처음 열릴 때 원문 FTS 인덱스를 지연 백필한다.
        from services.context_retrieval import index_document_chunks
        index_document_chunks(session_id, pages)
        sessions[session_id] = {
            "pdf_path": pdf_path,
            "filename": doc["filename"],
            "pages": pages,
            "total_pages": doc["total_pages"],
            "metadata": doc.get("metadata", {}),
            "from_library": True,
            "username": doc.get("username", "admin"),
            "document_mode": doc.get("document_mode", "research"),
            "document_type": doc.get("document_type", "research_paper"),
            "source_language": doc.get("source_language", "auto"),
            "detected_source_language": doc.get("detected_source_language", "und"),
            "source_language_confidence": doc.get("source_language_confidence"),
            "preferred_target_language": doc.get("preferred_target_language"),
            "processing_policy": doc.get("processing_policy", "inherit"),
            "content_revision": int(doc.get("content_revision") or 1),
            "parser_engine": parser_engine,
            "parser_version": parser_version,
            "content_kind": doc.get("content_kind", "pdf"),
            "source_origin": doc.get("source_origin", "local"),
            "source_url": doc.get("source_url"),
        }
        return True
    except Exception:
        return False


def require_session_owner(session_id: str, current_user: str) -> dict:
    """세션이 존재하고 현재 로그인한 사용자 소유인지 확인합니다.

    library.py의 _require_owned_document와 동일한 이유로, 다른 사용자의
    세션은 존재 여부조차 알려주지 않도록(403이 아니라) 존재하지 않는
    경우와 동일하게 404로 응답한다. jobs.py/main.py의 세션 기반
    엔드포인트에서도 재사용한다.
    """
    if not ensure_session(session_id):
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다.")
    session = sessions[session_id]
    if session.get("username") != current_user:
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다.")
    return session


def restore_sessions_from_library():
    """서버 시작 시 미완료 번역 잡이 있는 문서만 세션으로 복원하고 잡을 재개합니다.

    예전에는 라이브러리의 모든 문서를 매번 세션으로 복원했다(각 PDF를
    처음부터 다시 extract_pages()로 텍스트 추출). 이러면 서버 기동 시간이
    문서 수에 비례해 늘어나는데, Tauri 데스크톱 앱은 앱을 켤 때마다
    백엔드 프로세스가 재시작되므로 이 지연을 매번 겪게 되고, 배포 서버도
    문서가 쌓일수록 CI 헬스체크(재시작 후 30초 이내 응답) 타임아웃을
    넘기기 시작했다.

    부팅 시점에 실제로 필요한 건 "재개해야 할 미완료 번역 잡이 있는
    문서"뿐이다 - 그 외 문서는 ensure_session()이 실제로 열람되는 시점에
    그때 한 번만 추출해 캐싱하므로(require_session_owner 경유) 미리
    준비해둘 필요가 없다. job_status.json 존재 여부만 확인하는 건 PDF를
    열지 않는 가벼운 파일 I/O라 문서 수가 많아도 부담이 없다.
    """
    from services.document_tasks import recoverable_tasks
    recoverable_doc_ids = {task["doc_id"] for task in recoverable_tasks()}
    for doc in list_documents():
        doc_id = doc["id"]
        job = get_job_status(doc_id)
        if doc_id in recoverable_doc_ids or (job and job.get("status") == "running"):
            ensure_session(doc_id)

    # 미완료 번역 잡과 나머지 영속 작업 재개
    resume_incomplete_jobs(sessions)
    from services.document_tasks import recover_document_tasks
    recover_document_tasks(sessions)
    from services.reparse import recover_reparse_previews
    recover_reparse_previews()


@router.post("/upload", response_model=UploadResponse)
async def upload_pdf(
    file: UploadFile = File(...),
    upload_id: str | None = None,
    target_lang: str = "ko",
    source_lang: str = "auto",
    style: str = "academic",
    ignore_math: bool = False,
    ignore_table: bool = True,
    ignore_refs: bool = False,
    translation_mode: str = "auto",
    keyword_mode: str = "manual",
    summary_mode: str = "manual",
    document_mode: str = "research",
    document_type: str = "research_paper",
    current_user: str = Depends(get_current_user)
):
    """PDF 파일을 업로드하고 텍스트를 추출합니다."""
    enforce_rate_limit("upload", current_user)

    from services.languages import api_language_error, normalize_document_language
    try:
        target_lang = normalize_document_language(target_lang, allow_legacy=True)
    except ValueError:
        raise HTTPException(status_code=400, detail=api_language_error(target_lang))
    try:
        source_lang = normalize_document_language(source_lang, allow_auto=True)
    except ValueError:
        raise HTTPException(status_code=400, detail=api_language_error(source_lang, source=True))

    from services.document_policy import feature_enabled, validate_classification
    try:
        validate_classification(document_mode, document_type, allow_deprecated=False)
        if document_mode == "general" and not feature_enabled("general_document_mode"):
            raise ValueError("일반 문서 모드가 아직 활성화되지 않았습니다.")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # 파일 검증
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="PDF 파일만 업로드 가능합니다.")

    # 클라이언트가 알고 있는 ID를 사용하면 응답 전송이 끊겨도
    # GET /session/{id}로 실제 저장 성공 여부를 확인할 수 있다.
    if upload_id:
        try:
            session_id = str(uuid.UUID(upload_id))
        except (ValueError, AttributeError):
            raise HTTPException(status_code=400, detail="유효하지 않은 업로드 ID입니다.")
        from services.db import db_get_document
        if session_id in sessions or db_get_document(session_id):
            raise HTTPException(status_code=409, detail="이미 사용된 업로드 ID입니다.")
    else:
        session_id = str(uuid.uuid4())
    session_dir = os.path.join(UPLOAD_DIR, session_id)
    # The directory is the atomic reservation for an upload ID. Checking the
    # in-memory/DB state above is not sufficient because two requests can pass
    # that check before either one persists its session.
    try:
        os.makedirs(session_dir, exist_ok=False)
    except FileExistsError:
        raise HTTPException(status_code=409, detail="이미 사용된 업로드 ID입니다.")
    pdf_path = os.path.join(session_dir, "document.pdf")

    # 파일 저장 (스트리밍) - await file.read()로 전체를 한 번에 읽으면 크기
    # 제한 검사가 이미 전체 파일을 메모리에 다 올린 "다음"에야 이루어져,
    # MAX_FILE_SIZE_MB를 아무리 작게 잡아도 공격자가 매우 큰 파일을 계속
    # 올려 메모리를 고갈시키는 DoS 벡터가 된다. 청크 단위로 읽어 디스크에
    # 바로 쓰면서, 누적 크기가 한도를 넘는 순간 더 읽지 않고 즉시 중단한다.
    CHUNK_SIZE = 1024 * 1024  # 1MB
    max_bytes = MAX_FILE_SIZE_MB * 1024 * 1024
    total_bytes = 0
    try:
        async with aiofiles.open(pdf_path, "wb") as f:
            while True:
                chunk = await file.read(CHUNK_SIZE)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if total_bytes > max_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"파일 크기가 {MAX_FILE_SIZE_MB}MB를 초과합니다."
                    )
                await f.write(chunk)
    except HTTPException:
        shutil.rmtree(session_dir, ignore_errors=True)
        raise

    file_size_mb = total_bytes / (1024 * 1024)

    # 원본 경로와 업로드 옵션을 먼저 영속 작업에 기록한다. 문서 행이 아직
    # 생성되지 않은 시점에 서버가 종료되어도 이 정보만으로 실제 파싱과
    # 라이브러리 최종화를 다시 수행할 수 있다.
    from services.document_tasks import create_task
    parse_options = {
        "filename": file.filename,
        "file_size_mb": file_size_mb,
        "username": current_user,
        "target_lang": target_lang,
        "source_lang": source_lang,
        "style": style,
        "ignore_math": ignore_math,
        "ignore_table": ignore_table,
        "ignore_refs": ignore_refs,
        "translation_mode": translation_mode,
        "keyword_mode": keyword_mode,
        "summary_mode": summary_mode,
        "document_mode": document_mode,
        "document_type": document_type,
    }
    parse_task = create_task(session_id, "parse", parse_options, status="queued")
    from services.parse_job import execute_parse_task
    try:
        parsed = await execute_parse_task(
            parse_task["id"], sessions,
            page_extractor=extract_pages,
            metadata_reader=get_pdf_metadata,
            translation_starter=start_job,
            keyword_starter=start_keyword_job,
            summary_starter=start_summary_job,
            upload_root=UPLOAD_DIR,
        )
    except Exception as exc:
        shutil.rmtree(session_dir, ignore_errors=True)
        raise HTTPException(status_code=422, detail=f"PDF 파싱 실패: {exc}") from exc

    parsed["file_size_mb"] = round(file_size_mb, 2)
    return UploadResponse(**parsed)


@router.get("/session/{session_id}")
async def get_session(session_id: str, current_user: str = Depends(get_current_user)):
    """세션 정보를 반환합니다."""
    session = require_session_owner(session_id, current_user)
    return {
        "session_id": session_id,
        "filename": session["filename"],
        "total_pages": session["total_pages"],
        "metadata": session["metadata"],
        "document_mode": session.get("document_mode", "research"),
        "document_type": session.get("document_type", "research_paper"),
        "source_language": session.get("source_language", "auto"),
        "detected_source_language": session.get("detected_source_language", "und"),
        "source_language_confidence": session.get("source_language_confidence"),
        "preferred_target_language": session.get("preferred_target_language"),
        "source_origin": session.get("source_origin", "local"),
        "content_kind": session.get("content_kind", "pdf"),
        "source_url": session.get("source_url"),
        "total_units": session.get("total_pages", 0),
    }


@router.delete("/session/{session_id}")
async def delete_session(session_id: str, current_user: str = Depends(get_current_user)):
    """세션 및 업로드 파일을 삭제합니다."""
    require_session_owner(session_id, current_user)

    session = sessions.pop(session_id)
    session_dir = os.path.dirname(session["pdf_path"])

    from services.library import delete_chat_sessions
    delete_chat_sessions(session_id)

    shutil.rmtree(session_dir, ignore_errors=True)

    from services.cache import clear_session_cache
    clear_session_cache(session_id)

    return {"message": "세션이 삭제되었습니다."}


@router.get("/pdf/{session_id}")
async def get_pdf_path(session_id: str, current_user: str = Depends(get_current_user)):
    """세션의 PDF 파일 경로를 반환합니다."""
    session = require_session_owner(session_id, current_user)
    return {"pdf_path": session["pdf_path"]}
