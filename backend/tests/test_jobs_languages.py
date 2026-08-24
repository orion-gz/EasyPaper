import pytest

import routers.jobs as jobs_router


@pytest.fixture()
def session(monkeypatch):
    value = {
        "pages": [{"page_num": 1, "text": "Document text."}],
        "document_mode": "research", "document_type": "research_paper",
        "detected_source_language": "en",
    }
    monkeypatch.setattr(jobs_router, "require_session_owner", lambda *_: value)
    return value


def test_get_and_download_separate_target_and_source_errors(test_client, session):
    target = test_client.get("/api/jobs/doc/page/1?target_lang=xx&source_lang=en")
    assert target.status_code == 400
    assert target.json()["code"] == "unsupported_target_language"
    source = test_client.get("/api/jobs/doc/download?target_lang=fr&source_lang=xx")
    assert source.status_code == 400
    assert source.json()["code"] == "unsupported_source_language"


def test_restart_blocks_unresolved_and_multiple_detected_sources(test_client, session):
    for detected in ("und", "mul", "af"):
        session["detected_source_language"] = detected
        response = test_client.post("/api/jobs/doc/restart", json={
            "target_lang": "fr", "source_lang": "auto",
        })
        assert response.status_code == 409
        assert response.json()["code"] == "source_language_not_translatable"
        assert response.json()["params"] == {"language": detected}


def test_restart_accepts_any_allowlisted_target(test_client, session, monkeypatch):
    session["detected_source_language"] = "de"
    monkeypatch.setattr(jobs_router, "start_job", lambda *args, **kwargs: kwargs)
    response = test_client.post("/api/jobs/doc/restart", json={
        "target_lang": "fr", "source_lang": "auto",
    })
    assert response.status_code == 200
    assert response.json()["job"]["source_lang"] == "de"
    assert response.json()["job"]["target_lang"] == "fr"
