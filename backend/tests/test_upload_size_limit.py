"""POST /api/upload의 파일 크기 제한이 스트리밍 도중에(전체를 메모리에
읽어들이기 전에) 적용되는지 확인하는 회귀 테스트.

이전에는 await file.read()로 전체 파일을 먼저 메모리에 다 올린 "다음"에야
MAX_FILE_SIZE_MB를 검사해서, 한도를 아무리 작게 잡아도 큰 업로드가 메모리를
전부 소비한 뒤에야 거부되는 DoS 벡터였다.
"""

import time


def _await_upload(test_client, response):
    assert response.status_code == 202
    session_id = response.json()["session_id"]
    for _ in range(200):
        status = test_client.get(f"/api/upload/{session_id}/status")
        assert status.status_code == 200
        body = status.json()
        if body["status"] == "succeeded":
            return body["result"]
        assert body["status"] not in {"failed", "partial_failed", "cancelled"}, body
        time.sleep(0.01)
    raise AssertionError("upload parsing did not finish")

import fitz
import uuid
import routers.upload as upload_module
import routers.primer as primer_router


def _minimal_pdf_bytes() -> bytes:
    doc = fitz.open()
    doc.new_page()
    return doc.tobytes()


def test_upload_rejects_oversized_file_without_buffering_it_all(test_client, isolated_dirs, monkeypatch):
    upload_dir = isolated_dirs["upload_dir"]
    monkeypatch.setattr(upload_module, "UPLOAD_DIR", str(upload_dir))
    # 한도를 아주 작게(약 1KB) 잡아, 몇 KB짜리 업로드도 초과하도록 만든다
    monkeypatch.setattr(upload_module, "MAX_FILE_SIZE_MB", 0.001)

    oversized_content = b"%PDF-1.4\n" + (b"A" * 20_000)

    res = test_client.post(
        "/api/upload",
        files={"file": ("big.pdf", oversized_content, "application/pdf")},
    )

    assert res.status_code == 413
    # 거부된 업로드는 세션 디렉토리를 남기지 않아야 한다
    assert list(upload_dir.iterdir()) == []


def test_upload_accepts_file_within_size_limit(test_client, isolated_dirs, monkeypatch):
    upload_dir = isolated_dirs["upload_dir"]
    monkeypatch.setattr(upload_module, "UPLOAD_DIR", str(upload_dir))
    monkeypatch.setattr(upload_module, "MAX_FILE_SIZE_MB", 50)

    res = test_client.post(
        "/api/upload?translation_mode=scroll",
        files={"file": ("small.pdf", _minimal_pdf_bytes(), "application/pdf")},
    )

    body = _await_upload(test_client, res)
    assert body["filename"] == "small.pdf"
    assert body["session_id"] in upload_module.sessions


def test_upload_uses_valid_client_upload_id(test_client, isolated_dirs, monkeypatch):
    upload_dir = isolated_dirs["upload_dir"]
    monkeypatch.setattr(upload_module, "UPLOAD_DIR", str(upload_dir))
    monkeypatch.setattr(upload_module, "MAX_FILE_SIZE_MB", 50)
    upload_id = str(uuid.uuid4())

    response = test_client.post(
        f"/api/upload?translation_mode=scroll&upload_id={upload_id}",
        files={"file": ("identified.pdf", _minimal_pdf_bytes(), "application/pdf")},
    )

    body = _await_upload(test_client, response)
    assert body["session_id"] == upload_id


def test_upload_rejects_invalid_client_upload_id(test_client):
    response = test_client.post(
        "/api/upload?upload_id=not-a-uuid",
        files={"file": ("invalid.pdf", _minimal_pdf_bytes(), "application/pdf")},
    )

    assert response.status_code == 400


def test_upload_rejects_client_id_with_existing_directory(test_client, isolated_dirs, monkeypatch):
    upload_dir = isolated_dirs["upload_dir"]
    monkeypatch.setattr(upload_module, "UPLOAD_DIR", str(upload_dir))
    upload_id = str(uuid.uuid4())
    reserved_dir = upload_dir / upload_id
    reserved_dir.mkdir()
    marker = reserved_dir / "document.pdf"
    marker.write_bytes(b"existing upload")

    response = test_client.post(
        f"/api/upload?upload_id={upload_id}",
        files={"file": ("duplicate.pdf", _minimal_pdf_bytes(), "application/pdf")},
    )

    assert response.status_code == 409
    assert marker.read_bytes() == b"existing upload"


def test_auto_ai_jobs_wait_for_classification_confirmation(test_client, isolated_dirs, monkeypatch):
    """No translation or briefing starts before classification is confirmed."""
    upload_dir = isolated_dirs["upload_dir"]
    monkeypatch.setattr(upload_module, "UPLOAD_DIR", str(upload_dir))
    monkeypatch.setattr(upload_module, "MAX_FILE_SIZE_MB", 50)

    events = []

    def fake_start_job(*args, **kwargs):
        events.append("translation")
        return {"status": "running"}

    def fake_generate_primer(*args, **kwargs):
        events.append("primer")
        assert events[0] == "translation"
        return {}

    monkeypatch.setattr(upload_module, "start_job", fake_start_job)
    monkeypatch.setattr(primer_router, "_ensure_generation_started", fake_generate_primer)

    res = test_client.post(
        "/api/upload?translation_mode=auto&source_lang=en",
        files={"file": ("paper.pdf", _minimal_pdf_bytes(), "application/pdf")},
    )

    body = _await_upload(test_client, res)
    assert events == []
    assert upload_module.sessions[body["session_id"]]["classification_status"] == "pending"


def test_auto_translation_skips_full_job_at_fifty_pages(test_client, isolated_dirs, monkeypatch):
    upload_dir = isolated_dirs["upload_dir"]
    monkeypatch.setattr(upload_module, "UPLOAD_DIR", str(upload_dir))
    monkeypatch.setattr(upload_module, "MAX_FILE_SIZE_MB", 50)
    monkeypatch.setattr(
        upload_module, "extract_pages",
        lambda _path: [{"page_num": page, "text": ""} for page in range(1, 51)],
    )

    starts = []

    def fake_start_job(*args, **kwargs):
        starts.append((args, kwargs))
        return {"status": "running"}

    def fake_generate_primer(*args, **kwargs):
        return {}

    monkeypatch.setattr(upload_module, "start_job", fake_start_job)
    monkeypatch.setattr(primer_router, "_ensure_generation_started", fake_generate_primer)

    response = test_client.post(
        "/api/upload?translation_mode=auto",
        files={"file": ("long.pdf", _minimal_pdf_bytes(), "application/pdf")},
    )

    body = _await_upload(test_client, response)
    assert body["total_pages"] == 50
    assert starts == []
    upload_module.sessions.pop(body["session_id"], None)


def test_auto_translation_does_not_start_for_undetermined_source(test_client, isolated_dirs, monkeypatch):
    upload_dir = isolated_dirs["upload_dir"]
    monkeypatch.setattr(upload_module, "UPLOAD_DIR", str(upload_dir))
    monkeypatch.setattr(upload_module, "MAX_FILE_SIZE_MB", 50)
    starts = []
    monkeypatch.setattr(upload_module, "start_job", lambda *args, **kwargs: starts.append(kwargs))

    def no_primer(*args, **kwargs):
        return {}

    monkeypatch.setattr(primer_router, "_ensure_generation_started", no_primer)
    response = test_client.post(
        "/api/upload?translation_mode=auto",
        files={"file": ("empty.pdf", _minimal_pdf_bytes(), "application/pdf")},
    )
    body = _await_upload(test_client, response)
    assert body["detected_source_language"] == "und"
    assert body["translation_skipped_reason"] == "unsupported_source_language"
    assert starts == []
    upload_module.sessions.pop(body["session_id"], None)
