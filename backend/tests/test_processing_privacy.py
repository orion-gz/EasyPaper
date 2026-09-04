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


def _save_local_only_document(isolated_dirs, doc_id: str) -> None:
    isolated_dirs["db"].db_save_document(
        doc_id, "testuser", f"{doc_id}.pdf", "/x/nonexistent.pdf", 1,
        {"title": f"{doc_id} title"}, processing_policy="local_only",
    )


@pytest.mark.asyncio
async def test_secondary_tag_classification_enforces_analysis_provider(
    isolated_dirs, monkeypatch,
):
    import services.llm_client as llm_client
    from services.paper_tags import classify_and_store_paper_tags

    _save_local_only_document(isolated_dirs, "privacy-secondary-tags")
    monkeypatch.setattr("config.get_analysis_provider", lambda: "openai")
    calls = []

    async def fake_classify(*_args, **_kwargs):
        calls.append(True)
        return {}

    monkeypatch.setattr(llm_client, "classify_paper_tags", fake_classify)
    pages = [{"page_num": 1, "text": "Abstract\n" + ("meaningful research text " * 12)}]

    with pytest.raises(HTTPException) as exc_info:
        await classify_and_store_paper_tags(
            "privacy-secondary-tags", pages, "Private paper", force=True,
        )

    assert exc_info.value.detail["code"] == "external_processing_blocked"
    assert calls == []


@pytest.mark.asyncio
async def test_secondary_graph_sync_enforces_analysis_provider(
    isolated_dirs, monkeypatch,
):
    import services.llm_client as llm_client
    from services.knowledge_graph import sync_document_for_graph

    _save_local_only_document(isolated_dirs, "privacy-secondary-graph")
    monkeypatch.setattr("config.get_analysis_provider", lambda: "claude")
    calls = []

    async def fake_extract(*_args, **_kwargs):
        calls.append(True)
        return []

    monkeypatch.setattr(llm_client, "extract_paper_concepts", fake_extract)

    with pytest.raises(HTTPException) as exc_info:
        await sync_document_for_graph(
            "privacy-secondary-graph",
            [{"page_num": 1, "text": "private document text"}],
            "Private graph paper",
        )

    assert exc_info.value.detail["code"] == "external_processing_blocked"
    assert calls == []


@pytest.mark.asyncio
async def test_secondary_question_sync_skips_external_chat_provider(
    isolated_dirs, monkeypatch,
):
    import services.llm_client as llm_client
    from services import db
    from services.knowledge_graph import sync_question_for_graph

    doc_id = "privacy-secondary-question"
    _save_local_only_document(isolated_dirs, doc_id)
    concept_id = db.db_upsert_concept("Private Concept", "private concept", "method")
    db.db_link_paper_concept(doc_id, concept_id)
    chat_id = db.db_save_chat_message(doc_id, "user", "Explain the private concept")
    monkeypatch.setattr("config.get_chat_provider", lambda: "gemini")
    calls = []

    async def fake_match(*_args, **_kwargs):
        calls.append(True)
        return []

    monkeypatch.setattr(llm_client, "match_question_to_concepts", fake_match)
    await sync_question_for_graph(chat_id, doc_id, "Explain the private concept")

    assert calls == []
    with db.get_db() as conn:
        row = conn.execute(
            "SELECT graph_synced_at FROM chats WHERE id = ?", (chat_id,),
        ).fetchone()
    assert row["graph_synced_at"] is None


@pytest.mark.asyncio
async def test_secondary_heatmap_scoring_enforces_library_provider(
    isolated_dirs, monkeypatch,
):
    import services.llm_client as llm_client
    from services.knowledge_graph import _score_one_paper

    doc_id = "privacy-secondary-heatmap"
    _save_local_only_document(isolated_dirs, doc_id)
    monkeypatch.setattr("config.get_library_provider", lambda: "codex")
    calls = []

    async def fake_score(*_args, **_kwargs):
        calls.append(True)
        return []

    monkeypatch.setattr(llm_client, "score_paper_concept_relevance", fake_score)
    with pytest.raises(HTTPException) as exc_info:
        await _score_one_paper(doc_id, "Private paper", ["Private Concept"])

    assert exc_info.value.detail["code"] == "external_processing_blocked"
    assert calls == []


@pytest.mark.asyncio
async def test_secondary_dashboard_insights_enforce_library_provider(
    isolated_dirs, monkeypatch,
):
    import services.llm_client as llm_client
    from services.knowledge_graph import get_ai_insights

    _save_local_only_document(isolated_dirs, "privacy-secondary-dashboard")
    monkeypatch.setattr("config.get_library_provider", lambda: "openai")
    calls = []

    async def fake_generate(*_args, **_kwargs):
        calls.append(True)
        return []

    monkeypatch.setattr(llm_client, "generate_dashboard_insights", fake_generate)
    with pytest.raises(HTTPException) as exc_info:
        await get_ai_insights("testuser")

    assert exc_info.value.detail["code"] == "external_processing_blocked"
    assert calls == []



@pytest.mark.asyncio
async def test_secondary_graph_similarity_skips_external_library_provider(
    isolated_dirs, monkeypatch,
):
    import services.llm_client as llm_client
    from services import db
    from services.knowledge_graph import sync_document_for_graph

    doc_id = "privacy-secondary-similarity"
    _save_local_only_document(isolated_dirs, doc_id)
    db.db_upsert_concept("Existing Concept", "existing concept", "method")
    monkeypatch.setattr("config.get_analysis_provider", lambda: "ollama")
    monkeypatch.setattr("config.get_ollama_host", lambda: "http://127.0.0.1:11434")
    monkeypatch.setattr("config.get_library_provider", lambda: "openai")
    calls = []

    async def fake_extract(*_args, **_kwargs):
        return [{"concept": "New Private Concept", "kind": "method"}]

    async def fake_similar(*_args, **_kwargs):
        calls.append(True)
        return []

    monkeypatch.setattr(llm_client, "extract_paper_concepts", fake_extract)
    monkeypatch.setattr(llm_client, "find_similar_concepts", fake_similar)
    await sync_document_for_graph(
        doc_id, [{"page_num": 1, "text": "private text"}], "Private paper",
    )

    assert calls == []


@pytest.mark.parametrize("operation", ["translate", "insight", "primer"])
def test_ai_processing_requires_classification_confirmation(operation):
    with pytest.raises(HTTPException) as exc_info:
        ensure_processing_allowed({"processing_policy": "inherit", "classification_status": "pending"}, operation)
    assert exc_info.value.status_code == 409
    assert exc_info.value.detail["code"] == "classification_confirmation_required"


def test_classification_operation_is_allowed_while_pending(monkeypatch):
    monkeypatch.setattr("config.get_analysis_provider", lambda: "ollama")
    status = ensure_processing_allowed(
        {"processing_policy": "inherit", "classification_status": "pending"}, "classification",
    )
    assert status["processing_policy"] == "inherit"
