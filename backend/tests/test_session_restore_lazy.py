"""routers.upload.restore_sessions_from_library()의 지연 복원 동작 테스트.

서버 재시작 시 라이브러리의 모든 문서를 미리 세션으로 복원하면(각 PDF를
extract_pages()로 재추출) 문서 수에 비례해 부팅 시간이 늘어나는 문제가
있었다. 이제는 진행 중인 번역 잡이 있는 문서만 즉시 복원하고, 나머지는
ensure_session()이 실제로 열람될 때 지연 복원하도록 바뀌었다 - 이 선택
로직만 검증한다(잡 재개 자체의 비동기 실행은 기존 resume_incomplete_jobs의
책임이라 범위 밖).
"""

import json
import os
import asyncio

import fitz
import pytest

import routers.upload as upload_module
from services.translation_job import _job_path


@pytest.fixture(autouse=True)
def _cleanup_fake_sessions():
    """routers.upload.sessions는 프로세스 전역 dict라 테스트 간 오염을 막기
    위해 테스트 후 반드시 정리한다."""
    yield
    upload_module.sessions.clear()


def _create_doc(isolated_dirs, doc_id, monkeypatch):
    """isolated_dirs 위에 최소한의 실제 PDF 문서를 라이브러리에 저장한다."""
    import services.translation_job as translation_job

    # translation_job.py는 config.LIBRARY_DIR를 자기 모듈 전역으로 직접
    # 바인딩해 쓰므로(services.library.LIBRARY_DIR와는 별개 심볼),
    # job_status.json 경로가 isolated_dirs와 일치하도록 별도로 패치해야 한다.
    monkeypatch.setattr(translation_job, "LIBRARY_DIR", str(isolated_dirs["library_dir"]))

    tmp_pdf = isolated_dirs["upload_dir"] / f"{doc_id}.pdf"
    doc = fitz.open()
    doc.new_page(width=595, height=842)
    doc.save(str(tmp_pdf))
    doc.close()

    isolated_dirs["library"].save_document(
        doc_id, f"{doc_id}.pdf", str(tmp_pdf), 1, {}, username="testuser"
    )


def _write_job_status(doc_id, status, isolated_dirs):
    path = _job_path(doc_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"status": status, "options": {}}, f)


def test_only_documents_with_running_job_are_restored_eagerly(isolated_dirs, monkeypatch):
    _create_doc(isolated_dirs, "doc-running", monkeypatch)
    _create_doc(isolated_dirs, "doc-idle", monkeypatch)
    _write_job_status("doc-running", "running", isolated_dirs)
    _write_job_status("doc-idle", "completed", isolated_dirs)

    # resume_incomplete_jobs 자체(비동기 태스크 스케줄링, LLM 스트리밍)는
    # 이 테스트의 범위가 아니므로 no-op으로 대체하고 호출 여부/인자만 확인한다.
    calls = []
    monkeypatch.setattr(
        upload_module, "resume_incomplete_jobs", lambda sessions: calls.append(dict(sessions))
    )

    asyncio.run(upload_module.restore_sessions_from_library())

    assert "doc-running" in upload_module.sessions, "진행 중인 잡이 있는 문서는 즉시 복원되어야 함"
    assert upload_module.sessions["doc-running"]["pages"], "복원된 세션에는 추출된 페이지가 있어야 함"
    assert "doc-idle" not in upload_module.sessions, (
        "완료된 잡만 있는 문서는 부팅 시 미리 복원되면 안 됨(열람 시 지연 복원)"
    )

    assert len(calls) == 1
    assert list(calls[0].keys()) == ["doc-running"]


def test_document_without_any_job_status_is_not_restored_eagerly(isolated_dirs, monkeypatch):
    _create_doc(isolated_dirs, "doc-untouched", monkeypatch)
    # job_status.json 자체가 없는 경우 (번역을 한 번도 시작하지 않은 문서)

    monkeypatch.setattr(upload_module, "resume_incomplete_jobs", lambda sessions: None)

    asyncio.run(upload_module.restore_sessions_from_library())

    assert "doc-untouched" not in upload_module.sessions


def test_ensure_session_still_lazily_restores_idle_document_on_demand(isolated_dirs, monkeypatch):
    """restore_sessions_from_library()가 건너뛴 문서도, 실제로 열람되면
    ensure_session()을 통해 정상적으로(지연) 복원되어야 한다."""
    _create_doc(isolated_dirs, "doc-idle", monkeypatch)
    _write_job_status("doc-idle", "completed", isolated_dirs)

    monkeypatch.setattr(upload_module, "resume_incomplete_jobs", lambda sessions: None)
    asyncio.run(upload_module.restore_sessions_from_library())
    assert "doc-idle" not in upload_module.sessions

    assert upload_module.ensure_session("doc-idle") is True
    assert "doc-idle" in upload_module.sessions


def test_ensure_session_reuses_disk_cache_across_simulated_restart(isolated_dirs, monkeypatch):
    """재부팅(프로세스 재시작)해도 디스크 캐시가 있으면 PDF를 다시 파싱하지
    않아야 한다. 인메모리 sessions dict를 비워 재부팅을 흉내낸 뒤, extract_pages를
    호출하면 실패하도록 만들어 캐시가 실제로 재사용되는지 검증한다."""
    _create_doc(isolated_dirs, "doc-idle", monkeypatch)

    assert upload_module.ensure_session("doc-idle") is True
    cached_pages = upload_module.sessions["doc-idle"]["pages"]

    # 재부팅 시뮬레이션: 인메모리 세션만 사라지고, 디스크 캐시는 남아있음
    upload_module.sessions.clear()

    def _fail_if_called(pdf_path):
        raise AssertionError("디스크 캐시가 있는데도 extract_pages()가 다시 호출됨")

    monkeypatch.setattr(upload_module, "extract_pages", _fail_if_called)

    assert upload_module.ensure_session("doc-idle") is True
    assert upload_module.sessions["doc-idle"]["pages"] == cached_pages


def test_recovery_preserves_session_opened_while_parsing(isolated_dirs, monkeypatch):
    _create_doc(isolated_dirs, "doc-race", monkeypatch)
    original_extract = upload_module.extract_pages
    live_session = {"pages": [], "user_edit": "keep"}

    def extract(*args, **kwargs):
        pages = original_extract(*args, **kwargs)
        upload_module.sessions["doc-race"] = live_session
        return pages

    monkeypatch.setattr(upload_module, "extract_pages", extract)
    assert upload_module.ensure_session("doc-race")
    assert upload_module.sessions["doc-race"] is live_session
