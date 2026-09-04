import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest


def _doc(isolated_dirs, doc_id="task-doc", username="testuser"):
    isolated_dirs["db"].db_save_document(doc_id, username, "paper.pdf", "/x.pdf", 3, {})
    return doc_id


def test_task_page_checkpoints_and_partial_failure(isolated_dirs):
    from services.document_tasks import create_task, finish_from_pages, update_page

    doc_id = _doc(isolated_dirs)
    task = create_task(doc_id, "translate", {"target_lang": "ko"}, [1, 2, 3])
    assert task["status"] == "queued"
    update_page(task["id"], 1, "succeeded")
    update_page(task["id"], 2, "failed", last_error_code="authentication_failed")
    result = finish_from_pages(task["id"])
    assert result["status"] == "partial_failed"
    assert result["completed_pages"] == [1]
    assert result["failed_pages"] == [2]


def test_cancel_and_retry_reset_only_incomplete_pages(isolated_dirs):
    from services.document_tasks import create_task, get_task, request_cancel, reset_failed, update_page

    task = create_task(_doc(isolated_dirs), "summary", {}, [1, 2])
    update_page(task["id"], 1, "succeeded")
    cancelled = request_cancel(task["id"])
    assert cancelled["status"] == "cancelled"
    reset = reset_failed(task["id"])
    assert reset["status"] == "queued"
    pages = {page["page_num"]: page["status"] for page in reset["pages"]}
    assert pages == {1: "succeeded", 2: "queued"}


@pytest.mark.asyncio
async def test_transient_errors_retry_with_backoff_then_succeed():
    from services.document_tasks import retry_async

    calls = 0
    sleeps = []
    retries = []

    async def operation():
        nonlocal calls
        calls += 1
        if calls < 3:
            raise httpx.ReadTimeout("slow")
        return "ok"

    async def fake_sleep(delay):
        sleeps.append(delay)

    result = await retry_async(operation, sleep=fake_sleep, jitter=lambda: 0.25,
                               on_retry=lambda *args: retries.append(args))
    assert result == "ok"
    assert calls == 3
    assert sleeps == [2.25, 10.25]
    assert [item[1] for item in retries] == ["timeout", "timeout"]


@pytest.mark.asyncio
async def test_permanent_error_fails_without_retry():
    from services.document_tasks import retry_async

    calls = 0

    async def operation():
        nonlocal calls
        calls += 1
        raise RuntimeError("invalid model: unsupported model")

    with pytest.raises(RuntimeError) as exc_info:
        await retry_async(operation, sleep=lambda _delay: asyncio.sleep(0))
    assert calls == 1
    assert exc_info.value.document_task_error_code == "unsupported_model"


def test_legacy_translation_json_migrates_once(isolated_dirs, monkeypatch):
    from services import translation_job
    from services.document_tasks import list_tasks

    doc_id = _doc(isolated_dirs, "legacy-task")
    library_dir = Path(isolated_dirs["library_dir"])
    task_dir = library_dir / doc_id
    task_dir.mkdir()
    (task_dir / "job_status.json").write_text(json.dumps({
        "session_id": doc_id, "status": "completed", "total_pages": 3,
        "target_pages": [1, 2, 3], "completed_pages": [1, 2], "failed_pages": [3],
        "options": {"target_lang": "ko"},
    }), encoding="utf-8")
    monkeypatch.setattr(translation_job, "LIBRARY_DIR", str(library_dir))

    first = translation_job.get_job_status(doc_id)
    second = translation_job.get_job_status(doc_id)
    assert first["task_status"] == "partial_failed"
    assert first["status"] == "completed_with_errors"
    assert first["failed_pages"] == [3]
    assert second["task_id"] == first["task_id"]
    assert len(list_tasks(doc_id)) == 1


def test_task_api_scopes_to_document_owner(test_client, isolated_dirs):
    from services.document_tasks import create_task

    own = create_task(_doc(isolated_dirs, "task-own"), "translate", {}, [1])
    other = create_task(_doc(isolated_dirs, "task-other", "otheruser"), "summary", {}, [1])

    response = test_client.get("/api/tasks", params={"doc_id": "task-own"})
    assert response.status_code == 200
    assert [task["id"] for task in response.json()["tasks"]] == [own["id"]]
    assert test_client.get(f"/api/tasks/{other['id']}").status_code == 404


def test_empty_task_finishes_successfully(isolated_dirs):
    from services.document_tasks import create_task, finish_from_pages

    task = create_task(_doc(isolated_dirs, "empty-task"), "summary", {}, [])
    assert finish_from_pages(task["id"])["status"] == "succeeded"


@pytest.mark.asyncio
async def test_recovered_task_waits_for_persisted_retry_deadline(isolated_dirs):
    from services.document_tasks import create_task, update_task, wait_for_retry

    task = create_task(_doc(isolated_dirs, "retry-deadline"), "primer")
    retry_at = (datetime.now(timezone.utc) + timedelta(seconds=20)).isoformat()
    update_task(task["id"], status="retry_wait", next_retry_at=retry_at)
    sleeps = []

    async def fake_sleep(delay):
        sleeps.append(delay)

    assert await wait_for_retry(task["id"], sleep=fake_sleep) is True
    assert len(sleeps) == 1
    assert 18 <= sleeps[0] <= 20


def test_unsupported_retry_does_not_mutate_task(test_client, isolated_dirs):
    from services.document_tasks import create_task, get_task, update_task

    task = create_task(_doc(isolated_dirs, "parse-retry"), "parse")
    update_task(task["id"], status="failed", last_error_code="invalid_input")
    response = test_client.post(f"/api/tasks/{task["id"]}/retry")
    assert response.status_code == 409
    current = get_task(task["id"])
    assert current["status"] == "failed"
    assert current["last_error_code"] == "invalid_input"


@pytest.mark.asyncio
async def test_orphaned_parse_task_rebuilds_document_after_restart(isolated_dirs, monkeypatch):
    from services import parse_job, pdf_parser
    from services.document_tasks import create_task, get_task, recover_document_tasks
    from services.library import get_document

    doc_id = "recover-upload"
    source_dir = isolated_dirs["upload_dir"] / doc_id
    source_dir.mkdir()
    source_path = source_dir / "document.pdf"
    source_path.write_bytes(b"server-owned-pdf")
    monkeypatch.setattr(parse_job, "UPLOAD_DIR", str(isolated_dirs["upload_dir"]))
    monkeypatch.setattr(pdf_parser, "get_pdf_metadata", lambda _path: {"title": "Recovered"})
    monkeypatch.setattr(
        pdf_parser, "extract_pages",
        lambda _path: [{"page_num": 1, "text": "A recoverable English document."}],
    )
    monkeypatch.setattr(pdf_parser, "extract_pdf_images", lambda *_args: [])
    task = create_task(doc_id, "parse", {
        "filename": "recovered.pdf",
        "username": "testuser",
        "translation_mode": "scroll",
        "document_mode": "general",
        "document_type": "report",
        "source_lang": "en",
        "target_lang": "ko",
    }, status="running")

    sessions = {}
    recover_document_tasks(sessions)
    for _ in range(100):
        if get_task(task["id"])["status"] not in {"queued", "running", "retry_wait"}:
            break
        await asyncio.sleep(0.01)

    recovered = get_task(task["id"])
    assert recovered["status"] == "succeeded", (recovered["last_error_code"], recovered["options"])
    assert recovered["attempt_count"] == 1
    assert get_document(doc_id)["total_pages"] == 1
    assert sessions[doc_id]["metadata"]["title"] == "Recovered"
    assert sessions[doc_id]["pages"][0]["text"].startswith("A recoverable")


@pytest.mark.asyncio
async def test_parse_recovery_rejects_task_path_outside_upload_root(isolated_dirs, monkeypatch):
    from services import parse_job
    from services.document_tasks import create_task, get_task

    outside = isolated_dirs["upload_dir"].parent / "outside.pdf"
    outside.write_bytes(b"not-owned")
    monkeypatch.setattr(parse_job, "UPLOAD_DIR", str(isolated_dirs["upload_dir"]))
    task = create_task("path-tamper", "parse", {
        "pdf_path": str(outside), "filename": "outside.pdf", "username": "testuser",
    })

    with pytest.raises(ValueError, match="invalid_parse_source_path"):
        await parse_job.execute_parse_task(task["id"], {}, upload_root=str(isolated_dirs["upload_dir"]))
    current = get_task(task["id"])
    assert current["status"] == "failed"
    assert current["last_error_code"] == "invalid_parse_source_path"


def test_translation_retry_api_runs_only_failed_pages(test_client, isolated_dirs, monkeypatch):
    from routers import upload
    from services import translation_job
    from services.document_tasks import create_task, finish_from_pages, get_task, update_page

    doc_id = _doc(isolated_dirs, "retry-failed-translation")
    upload.sessions[doc_id] = {
        "username": "testuser",
        "pages": [
            {"page_num": 1, "text": "done"},
            {"page_num": 2, "text": "retry"},
            {"page_num": 3, "text": "done"},
        ],
        "metadata": {}, "filename": "paper.pdf",
        "document_mode": "research", "document_type": "research_paper",
    }
    task = create_task(doc_id, "translate", {"target_lang": "ko"}, [1, 2, 3])
    update_page(task["id"], 1, "succeeded")
    update_page(task["id"], 2, "failed", last_error_code="generation_failed")
    update_page(task["id"], 3, "succeeded")
    finish_from_pages(task["id"])
    starts = []
    monkeypatch.setattr(translation_job, "start_job", lambda *args, **kwargs: starts.append((args, kwargs)))

    try:
        response = test_client.post(f"/api/tasks/{task['id']}/retry")
        assert response.status_code == 200
        assert starts[0][1]["page_numbers"] == [2]
        assert starts[0][1]["durable_task_id"] == task["id"]
        pages = {page["page_num"]: page["status"] for page in get_task(task["id"])["pages"]}
        assert pages == {1: "succeeded", 2: "queued", 3: "succeeded"}
    finally:
        upload.sessions.pop(doc_id, None)


@pytest.mark.asyncio
async def test_recovered_parse_finalization_preserves_existing_results(isolated_dirs, monkeypatch):
    from services import parse_job, pdf_parser
    from services.document_tasks import create_task, update_task
    from services.library import get_translation, save_translation

    doc_id = "recover-finalize"
    source_dir = isolated_dirs["upload_dir"] / doc_id
    source_dir.mkdir()
    (source_dir / "document.pdf").write_bytes(b"server-owned-pdf")
    monkeypatch.setattr(parse_job, "UPLOAD_DIR", str(isolated_dirs["upload_dir"]))
    monkeypatch.setattr(pdf_parser, "extract_pdf_images", lambda *_args: [])
    task = create_task(doc_id, "parse", {
        "filename": "recover.pdf", "username": "testuser",
        "translation_mode": "auto", "document_mode": "general",
        "document_type": "report", "source_lang": "en", "target_lang": "ko",
    })
    translation_starts = []

    def start_translation(*_args, **_kwargs):
        translation_starts.append(1)
        create_task(doc_id, "translate", {"target_lang": "ko"}, [1], status="running")

    dependencies = {
        "page_extractor": lambda _path: [{"page_num": 1, "text": "First parse."}],
        "metadata_reader": lambda _path: {"title": "First"},
        "translation_starter": start_translation,
        "primer_starter": lambda *_args, **_kwargs: None,
        "keyword_starter": lambda *_args, **_kwargs: None,
        "summary_starter": lambda *_args, **_kwargs: None,
        "upload_root": str(isolated_dirs["upload_dir"]),
    }
    await parse_job.execute_parse_task(task["id"], {}, **dependencies)
    save_translation(doc_id, 1, "preserved", "test")
    update_task(task["id"], status="running")
    dependencies["metadata_reader"] = lambda _path: {"title": "Recovered"}

    await parse_job.execute_parse_task(task["id"], {}, **dependencies)
    assert get_translation(doc_id, 1, "test", fallback=False) == "preserved"
    assert translation_starts == []  # deferred until classification confirmation
    with isolated_dirs["db"].get_db() as conn:
        metric_count = conn.execute(
            "SELECT COUNT(*) AS count FROM document_mode_metrics WHERE event = 'upload'"
        ).fetchone()["count"]
    assert metric_count == 1
