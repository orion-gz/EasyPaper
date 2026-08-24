import routers.jobs as jobs_module
import routers.upload as upload_module


def _session(page_count=5):
    return {
        "pages": [{"page_num": page, "text": f"page {page}"} for page in range(1, page_count + 1)],
        "username": "testuser",
        "total_pages": page_count,
        "source_language": "en",
        "detected_source_language": "en",
    }


def test_restart_job_accepts_explicit_page_scope(test_client, monkeypatch):
    session_id = "scope-explicit"
    upload_module.sessions[session_id] = _session()
    captured = {}

    def fake_start_job(*args, **kwargs):
        captured.update(kwargs)
        return {"status": "running", "target_pages": kwargs["page_numbers"]}

    monkeypatch.setattr(jobs_module, "start_job", fake_start_job)
    try:
        response = test_client.post(
            f"/api/jobs/{session_id}/restart",
            json={"page_numbers": [2, 3, 4]},
        )
    finally:
        upload_module.sessions.pop(session_id, None)

    assert response.status_code == 200
    assert captured["page_numbers"] == [2, 3, 4]


def test_restart_job_resumes_previous_page_scope(test_client, monkeypatch):
    session_id = "scope-resume"
    upload_module.sessions[session_id] = _session()
    captured = {}

    monkeypatch.setattr(
        jobs_module, "get_job_status",
        lambda _session_id: {"status": "cancelled", "target_pages": [3, 4, 5]},
    )

    def fake_start_job(*args, **kwargs):
        captured.update(kwargs)
        return {"status": "running", "target_pages": kwargs["page_numbers"]}

    monkeypatch.setattr(jobs_module, "start_job", fake_start_job)
    try:
        response = test_client.post(
            f"/api/jobs/{session_id}/restart",
            json={"resume_scope": True},
        )
    finally:
        upload_module.sessions.pop(session_id, None)

    assert response.status_code == 200
    assert captured["page_numbers"] == [3, 4, 5]


def test_start_job_persists_only_requested_pages(monkeypatch):
    from services import translation_job

    saved = {}

    class DummyTask:
        def cancel(self):
            return None

    def fake_create_task(coro):
        coro.close()
        return DummyTask()

    monkeypatch.setattr(translation_job, "_load_job", lambda _session_id: None)
    monkeypatch.setattr(translation_job, "_save_job", lambda _session_id, job: saved.update(job))
    monkeypatch.setattr(translation_job.asyncio, "create_task", fake_create_task)
    translation_job._running_tasks.clear()

    pages = [{"page_num": page, "text": str(page)} for page in range(1, 6)]
    job = translation_job.start_job("scope-service", pages, page_numbers=[2, 4, 99])

    assert job["target_pages"] == [2, 4]
    assert job["total_pages"] == 2
    assert saved["target_pages"] == [2, 4]
    translation_job._running_tasks.clear()
