import pytest
from fastapi import HTTPException

from services.processing_policy import (
    ensure_processing_allowed,
    is_loopback_ollama_host,
    provider_is_local,
)


@pytest.mark.parametrize("host", [
    "http://localhost:11434", "http://127.0.0.1:11434", "http://[::1]:11434",
])
def test_loopback_ollama_is_local(host):
    assert is_loopback_ollama_host(host)
    assert provider_is_local("ollama", host)


@pytest.mark.parametrize("provider,host", [
    ("openai", "http://127.0.0.1:11434"),
    ("gemini", "http://127.0.0.1:11434"),
    ("claude", "http://127.0.0.1:11434"),
    ("antigravity", "http://127.0.0.1:11434"),
    ("claude_code", "http://127.0.0.1:11434"),
    ("codex", "http://127.0.0.1:11434"),
    ("ollama", "http://192.168.1.20:11434"),
    ("ollama", "https://ollama.example.com"),
])
def test_external_providers_and_remote_ollama_are_not_local(provider, host):
    assert not provider_is_local(provider, host)


def test_local_only_returns_structured_409(monkeypatch):
    monkeypatch.setattr("config.get_chat_provider", lambda: "openai")
    with pytest.raises(HTTPException) as exc_info:
        ensure_processing_allowed({"processing_policy": "local_only"}, "chat")
    assert exc_info.value.status_code == 409
    assert exc_info.value.detail["code"] == "external_processing_blocked"
    assert exc_info.value.detail["params"] == {"provider": "openai", "operation": "chat"}


def test_inherit_keeps_existing_external_behavior(monkeypatch):
    monkeypatch.setattr("config.get_trans_provider", lambda: "gemini")
    status = ensure_processing_allowed({"processing_policy": "inherit"}, "translate")
    assert status["badge"] == "external_transfer"
    assert status["transfer_items"] == ["document_text", "page_image"]


def _create_doc(isolated_dirs, doc_id, username="testuser"):
    isolated_dirs["db"].db_save_document(
        doc_id, username, "paper.pdf", "/x/paper.pdf", 1, {"title": "Paper"},
    )


def test_processing_policy_api_defaults_updates_and_checks_ownership(test_client, isolated_dirs):
    _create_doc(isolated_dirs, "privacy-own")
    _create_doc(isolated_dirs, "privacy-other", "otheruser")

    initial = test_client.get("/api/library/privacy-own/processing-policy")
    assert initial.status_code == 200
    assert initial.json()["processing_policy"] == "inherit"

    updated = test_client.patch(
        "/api/library/privacy-own/processing-policy", json={"processing_policy": "local_only"},
    )
    assert updated.status_code == 200
    assert updated.json()["processing_policy"] == "local_only"
    assert isolated_dirs["db"].db_get_document("privacy-own")["processing_policy"] == "local_only"

    assert test_client.get("/api/library/privacy-other/processing-policy").status_code == 404
    assert test_client.patch(
        "/api/library/privacy-other/processing-policy", json={"processing_policy": "local_only"},
    ).status_code == 404
    assert test_client.patch(
        "/api/library/privacy-own/processing-policy", json={"processing_policy": "cloud"},
    ).status_code == 400


def test_chat_policy_blocks_before_rate_accounting(test_client, monkeypatch):
    import routers.chat as chat_router
    import routers.upload as upload_router

    session_id = "privacy-chat-block"
    upload_router.sessions[session_id] = {
        "pdf_path": "/x.pdf", "filename": "x.pdf", "pages": [{"page_num": 1, "text": "text"}],
        "total_pages": 1, "metadata": {}, "username": "testuser",
        "processing_policy": "local_only",
    }
    monkeypatch.setattr("config.get_chat_provider", lambda: "openai")
    calls = []
    monkeypatch.setattr(chat_router, "enforce_rate_limit", lambda *_args: calls.append(True))
    try:
        response = test_client.post("/api/chat/suggestions", json={
            "session_id": session_id, "messages": [{"role": "user", "content": "question"}],
        })
    finally:
        upload_router.sessions.pop(session_id, None)
    assert response.status_code == 409
    assert response.json()["code"] == "external_processing_blocked"
    assert calls == []


def test_system_settings_never_returns_key_material(test_client, monkeypatch):
    import routers.auth as auth_router

    async def healthy():
        return {"available_models": []}

    monkeypatch.setattr(auth_router, "check_ollama_health", healthy)
    monkeypatch.setattr(auth_router, "get_openai_api_key", lambda: "sk-secret-1234")
    monkeypatch.setattr(auth_router, "get_gemini_api_key", lambda: "gem-secret-5678")
    monkeypatch.setattr(auth_router, "get_claude_api_key", lambda: "claude-secret-9012")
    response = test_client.get("/api/settings/system")
    assert response.status_code == 200
    payload = response.json()
    assert "openai_api_key" not in payload
    assert "gemini_api_key" not in payload
    assert "claude_api_key" not in payload
    assert payload["api_keys"] == {
        "openai": {"configured": True, "masked": "••••1234"},
        "gemini": {"configured": True, "masked": "••••5678"},
        "claude": {"configured": True, "masked": "••••9012"},
    }
    assert "secret" not in response.text


def test_system_settings_empty_keeps_keys_and_delete_flag_removes_one(test_client, monkeypatch):
    import routers.auth as auth_router

    existing = {"openai": "openai-old", "gemini": "gemini-old", "claude": "claude-old"}
    monkeypatch.setattr(auth_router, "get_openai_api_key", lambda: existing["openai"])
    monkeypatch.setattr(auth_router, "get_gemini_api_key", lambda: existing["gemini"])
    monkeypatch.setattr(auth_router, "get_claude_api_key", lambda: existing["claude"])
    monkeypatch.setattr(auth_router.venv_manager, "restart_required_for_engine", lambda _engine: False)
    monkeypatch.setattr(auth_router, "update_translation_prompt_template", lambda _value: None)
    captured = {}
    monkeypatch.setattr(auth_router, "update_system_settings", lambda **kwargs: captured.update(kwargs))

    body = {
        "ollama_host": "http://localhost:11434", "trans_provider": "ollama", "trans_model": "model",
        "chat_provider": "ollama", "chat_model": "model", "openai_api_key": "",
        "gemini_api_key": "", "claude_api_key": "", "delete_gemini_api_key": True,
    }
    response = test_client.post("/api/settings/system", json=body)
    assert response.status_code == 200
    assert captured["openai_api_key"] == "openai-old"
    assert captured["gemini_api_key"] == ""
    assert captured["claude_api_key"] == "claude-old"


def test_all_document_ai_entrypoints_block_external_processing(test_client, isolated_dirs, monkeypatch):
    import routers.upload as upload_router

    session_id = "privacy-all-entrypoints"
    isolated_dirs["db"].db_save_document(
        session_id, "testuser", "paper.pdf", "/x/paper.pdf", 1, {"title": "Paper"},
        processing_policy="local_only", detected_source_language="en",
    )
    upload_router.sessions[session_id] = {
        "pdf_path": "/x.pdf", "filename": "paper.pdf", "pages": [{"page_num": 1, "text": "text"}],
        "total_pages": 1, "metadata": {"title": "Paper"}, "username": "testuser",
        "document_mode": "research", "document_type": "research_paper",
        "detected_source_language": "en", "source_language": "auto",
        "processing_policy": "local_only",
    }
    monkeypatch.setattr("config.get_trans_provider", lambda: "openai")
    monkeypatch.setattr("config.get_chat_provider", lambda: "gemini")
    monkeypatch.setattr("config.get_analysis_provider", lambda: "claude")
    monkeypatch.setattr("config.get_library_provider", lambda: "codex")

    requests = [
        ("get", f"/api/translate/{session_id}/1?source_lang=en"),
        ("get", f"/api/insight/{session_id}/1?kind=summary&source_lang=en"),
        ("post", f"/api/insight-jobs/{session_id}/summary/start", {"target_lang": "ko", "source_lang": "en"}),
        ("post", f"/api/jobs/{session_id}/restart", {"target_lang": "ko", "source_lang": "en"}),
        ("get", f"/api/library/{session_id}/primer?target_lang=ko"),
        ("get", "/api/library/graph/recommendations"),
    ]
    try:
        for request in requests:
            method, url, *rest = request
            response = getattr(test_client, method)(url, **({"json": rest[0]} if rest else {}))
            assert response.status_code == 409, (url, response.status_code, response.text)
            assert response.json()["code"] == "external_processing_blocked"
    finally:
        upload_router.sessions.pop(session_id, None)
