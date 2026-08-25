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
