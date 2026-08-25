import json
import re
import fitz
import pytest


def _events(response):
    result = []
    for frame in response.text.replace("\r\n", "\n").split("\n\n"):
        if not frame.strip():
            continue
        event, data = "message", []
        for line in frame.splitlines():
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].lstrip())
        if data:
            result.append((event, json.loads("\n".join(data))))
    return result


def _chat_document(isolated_dirs, doc_id="grounded-doc", policy="inherit"):
    from routers.upload import sessions
    pdf_path = isolated_dirs["library_dir"] / (doc_id + ".pdf")
    pdf = fitz.open()
    page = pdf.new_page()
    page.insert_text((72, 72), "Figure 1 shows the grounded accuracy result.")
    pdf.save(pdf_path)
    pdf.close()
    isolated_dirs["db"].db_save_document(
        doc_id, "testuser", "paper.pdf", str(pdf_path), 1, {"title": "Paper"},
        processing_policy=policy,
    )
    isolated_dirs["db"].db_save_translation(doc_id, 1, "그림 1은 근거 정확도 결과를 보여준다.")
    sessions[doc_id] = {
        "pdf_path": str(pdf_path), "filename": "paper.pdf",
        "pages": [{"page_num": 1, "text": "Figure 1 shows the grounded accuracy result.",
                   "blocks": [{"bbox": [70, 60, 350, 90], "text": "Figure 1 shows the grounded accuracy result."}]}],
        "total_pages": 1, "metadata": {"title": "Paper"}, "username": "testuser",
        "document_mode": "research", "document_type": "research_paper",
        "processing_policy": policy, "content_revision": 1,
    }
    return sessions


@pytest.fixture()
def grounded_doc(isolated_dirs):
    sessions = _chat_document(isolated_dirs)
    try:
        yield sessions
    finally:
        sessions.pop("grounded-doc", None)


def test_visual_question_detection_avoids_korean_false_positive():
    from routers.chat import _VISUAL_QUESTION_RE
    assert _VISUAL_QUESTION_RE.search("이 표를 설명해줘")
    assert not _VISUAL_QUESTION_RE.search("연구 목표를 설명해줘")


def test_evidence_ids_are_deterministic_and_invalid_ids_are_removed(isolated_dirs):
    from services.context_retrieval import retrieve_context, validate_evidence_citations
    pages = [{"page_num": 3, "text": "# Results\n\nAccuracy improved by 12 percent."}]
    first = retrieve_context("doc", pages, "accuracy", content_revision=4)
    second = retrieve_context("doc", pages, "accuracy", content_revision=4)
    assert first.evidence == second.evidence
    item = first.evidence[0]
    assert item["content_revision"] == 4 and item["page_num"] == 3
    assert item["char_start"] is not None and item["evidence_id"].startswith("ev_")
    answer, cited, verification = validate_evidence_citations(
        "Improved [E:" + item["evidence_id"] + "]. Invented [E:ev_missing].", first.evidence,
    )
    assert "[p.3]" in answer and "ev_missing" not in answer
    assert cited[0]["evidence_id"] == item["evidence_id"]
    assert "invalid_evidence_id" in verification["risks"]


@pytest.mark.parametrize("question,screen_context,expect_visual", [
    ("이 페이지 그림을 설명해줘", {"mode": "viewer", "page_num": 1, "include_visual": None}, True),
    ("핵심 내용을 설명해줘", {"mode": "viewer", "page_num": 1, "include_visual": None}, False),
    ("이 페이지 그림을 설명해줘", {"mode": "standalone", "include_visual": True}, False),
])
def test_screen_context_visual_attachment_rules(
    test_client, grounded_doc, isolated_dirs, monkeypatch, question, screen_context, expect_visual,
):
    import routers.chat as chat_router
    captures = []

    async def fake_stream(system_prompt, messages, session_id=None, page_image_b64=None):
        evidence_id = re.search(r"\[E:(ev_[A-Za-z0-9_-]+)\]", system_prompt).group(1)
        captures.append(page_image_b64)
        yield "Supported claim [E:" + evidence_id + "]."

    monkeypatch.setattr(chat_router, "stream_chat", fake_stream)
    monkeypatch.setattr("config.get_chat_provider", lambda: "openai")
    monkeypatch.setattr("config.get_chat_model", lambda: "gpt-vision")
    response = test_client.post("/api/chat/stream", json={
        "session_id": "grounded-doc", "messages": [{"role": "user", "content": question}],
        "screen_context": screen_context,
    })
    assert response.status_code == 200
    events = _events(response)
    assert [name for name, _ in events] == ["context", "answer", "evidence", "verification", "done"]
    context = events[0][1]
    assert context["visual_included"] is expect_visual
    assert bool(captures[0]) is expect_visual
    assert context["current_page_text_included"] is (screen_context["mode"] == "viewer")
    assert "[p.1]" in events[1][1]["delta"]
    evidence = events[2][1]["items"]
    assert evidence and evidence[0]["quote"].startswith("Figure 1")
    assert evidence[0]["translation_quote"].startswith("그림 1")
    history = isolated_dirs["db"].db_get_chat_history("grounded-doc", include_revision=True)
    assert history[-1]["evidence"][0]["content_revision"] == 1
    assert history[-1]["evidence"][0]["translation_quote"].startswith("그림 1")


def test_unsupported_vision_model_reports_reason_without_render(test_client, grounded_doc, monkeypatch):
    import routers.chat as chat_router
    captures = []

    async def fake_stream(system_prompt, messages, session_id=None, page_image_b64=None):
        evidence_id = re.search(r"\[E:(ev_[A-Za-z0-9_-]+)\]", system_prompt).group(1)
        captures.append(page_image_b64)
        yield "Supported [E:" + evidence_id + "]."

    monkeypatch.setattr(chat_router, "stream_chat", fake_stream)
    monkeypatch.setattr("config.get_chat_provider", lambda: "ollama")
    monkeypatch.setattr("config.get_chat_model", lambda: "llama3")
    response = test_client.post("/api/chat/stream", json={
        "session_id": "grounded-doc", "messages": [{"role": "user", "content": "이 페이지 그림을 설명해줘"}],
        "screen_context": {"mode": "viewer", "page_num": 1, "include_visual": True},
    })
    context = _events(response)[0][1]
    assert context["visual_included"] is False
    assert context["visual_reason"] == "vision_not_supported"
    assert captures == [None]


def test_local_only_external_provider_blocks_before_page_render(test_client, isolated_dirs, monkeypatch):
    from routers.upload import sessions
    _chat_document(isolated_dirs, "local-grounded", policy="local_only")
    rendered = []
    monkeypatch.setattr("config.get_chat_provider", lambda: "openai")
    monkeypatch.setattr("services.pdf_parser.render_page_image_base64", lambda *_args: rendered.append(True))
    try:
        response = test_client.post("/api/chat/stream", json={
            "session_id": "local-grounded", "messages": [{"role": "user", "content": "이 페이지 그림을 설명해줘"}],
            "screen_context": {"mode": "viewer", "page_num": 1, "include_visual": True},
        })
    finally:
        sessions.pop("local-grounded", None)
    assert response.status_code == 409
    assert response.json()["code"] == "external_processing_blocked"
    assert rendered == []


def test_invalid_evidence_id_emits_risk_and_is_not_persisted(
    test_client, grounded_doc, isolated_dirs, monkeypatch,
):
    import routers.chat as chat_router

    async def fake_stream(*_args, **_kwargs):
        yield "Unsupported statement [E:ev_not_supplied]."

    monkeypatch.setattr(chat_router, "stream_chat", fake_stream)
    monkeypatch.setattr("config.get_chat_provider", lambda: "openai")
    monkeypatch.setattr("config.get_chat_model", lambda: "model")
    response = test_client.post("/api/chat/stream", json={
        "session_id": "grounded-doc", "messages": [{"role": "user", "content": "question"}],
        "screen_context": {"mode": "viewer", "page_num": 1, "include_visual": False},
    })
    events = dict(_events(response))
    assert "ev_not_supplied" not in events["answer"]["delta"]
    assert "invalid_evidence_id" in events["verification"]["risks"]
    history = isolated_dirs["db"].db_get_chat_history("grounded-doc", include_revision=True)
    assert history[-1]["evidence"] == []
    assert "invalid_evidence_id" in history[-1]["verification"]["risks"]


def test_explicit_verification_runs_separate_semantic_pass(test_client, grounded_doc, monkeypatch):
    import routers.chat as chat_router
    calls = []

    async def fake_stream(system_prompt, messages, session_id=None, page_image_b64=None):
        calls.append(session_id)
        if "evidence verification model" in system_prompt:
            yield "{\"status\":\"supported\"}"
            return
        evidence_id = re.search(r"\[E:(ev_[A-Za-z0-9_-]+)\]", system_prompt).group(1)
        yield "Supported [E:" + evidence_id + "]."

    monkeypatch.setattr(chat_router, "stream_chat", fake_stream)
    monkeypatch.setattr("config.get_chat_provider", lambda: "openai")
    monkeypatch.setattr("config.get_chat_model", lambda: "model")
    response = test_client.post("/api/chat/stream", json={
        "session_id": "grounded-doc",
        "messages": [{"role": "user", "content": "Verify the evidence"}],
        "screen_context": {"mode": "viewer", "page_num": 1, "include_visual": False},
        "verify_evidence": True,
    })
    verification = dict(_events(response))["verification"]
    assert verification["semantic"]["mode"] == "semantic_model"
    assert len(calls) == 2


def test_local_only_without_model_limits_verification_to_structure(test_client, isolated_dirs, monkeypatch):
    import routers.chat as chat_router
    from routers.upload import sessions
    _chat_document(isolated_dirs, "local-verify", policy="local_only")
    calls = []

    async def fake_stream(system_prompt, messages, session_id=None, page_image_b64=None):
        calls.append(session_id)
        evidence_id = re.search(r"\[E:(ev_[A-Za-z0-9_-]+)\]", system_prompt).group(1)
        yield "Supported [E:" + evidence_id + "]."

    monkeypatch.setattr(chat_router, "stream_chat", fake_stream)
    monkeypatch.setattr("config.get_chat_provider", lambda: "ollama")
    monkeypatch.setattr("config.get_chat_model", lambda: "")
    monkeypatch.setattr("config.get_ollama_host", lambda: "http://127.0.0.1:11434")
    try:
        response = test_client.post("/api/chat/stream", json={
            "session_id": "local-verify",
            "messages": [{"role": "user", "content": "근거 검증"}],
            "screen_context": {"mode": "viewer", "page_num": 1, "include_visual": False},
            "verify_evidence": True,
        })
    finally:
        sessions.pop("local-verify", None)
    verification = dict(_events(response))["verification"]
    assert verification["semantic"] == {
        "mode": "structural_only", "status": "no_allowed_local_verifier",
    }
    assert len(calls) == 1


def test_screen_page_range_is_validated_before_rate_accounting(test_client, grounded_doc, monkeypatch):
    import routers.chat as chat_router
    calls = []
    monkeypatch.setattr(chat_router, "enforce_rate_limit", lambda *_args: calls.append(True))
    monkeypatch.setattr("config.get_chat_provider", lambda: "openai")
    response = test_client.post("/api/chat/stream", json={
        "session_id": "grounded-doc",
        "messages": [{"role": "user", "content": "question"}],
        "screen_context": {"mode": "viewer", "page_num": 9, "include_visual": False},
    })
    assert response.status_code == 400
    assert response.json()["code"] == "screen_page_out_of_range"
    assert calls == []


def test_selected_text_is_resolved_to_canonical_page_source():
    from services.context_retrieval import resolve_page_selected_text

    pages = [{"page_num": 2, "text": "Grounded accuracy\n  improves by 12 percent."}]
    assert resolve_page_selected_text(
        pages, 2, "Grounded accuracy improves by 12 percent.",
    ) == "Grounded accuracy\n  improves by 12 percent."
    assert resolve_page_selected_text(pages, 2, "invented statement") is None


def test_forged_selected_text_is_rejected_before_rate_or_llm(
    test_client, grounded_doc, isolated_dirs, monkeypatch,
):
    import routers.chat as chat_router
    calls = []
    monkeypatch.setattr(chat_router, "enforce_rate_limit", lambda *_args: calls.append("rate"))

    async def forbidden_stream(*_args, **_kwargs):
        calls.append("llm")
        yield "unexpected"

    monkeypatch.setattr(chat_router, "stream_chat", forbidden_stream)
    response = test_client.post("/api/chat/stream", json={
        "session_id": "grounded-doc",
        "messages": [{"role": "user", "content": "question"}],
        "selected_text": "This forged text is not in the PDF.",
        "screen_context": {"mode": "viewer", "page_num": 1, "include_visual": False},
    })
    assert response.status_code == 400
    assert response.json()["code"] == "selected_text_not_on_page"
    assert calls == []
    assert isolated_dirs["db"].db_get_chat_history("grounded-doc", include_revision=True) == []


def test_standalone_chat_rejects_selected_text_without_viewer_page(
    test_client, grounded_doc, monkeypatch,
):
    import routers.chat as chat_router
    calls = []
    monkeypatch.setattr(chat_router, "enforce_rate_limit", lambda *_args: calls.append(True))
    response = test_client.post("/api/chat/stream", json={
        "session_id": "grounded-doc",
        "messages": [{"role": "user", "content": "question"}],
        "selected_text": "Figure 1 shows the grounded accuracy result.",
        "screen_context": {"mode": "standalone", "include_visual": False},
    })
    assert response.status_code == 400
    assert response.json()["code"] == "selected_text_requires_viewer_page"
    assert calls == []


def test_valid_selected_text_uses_server_canonical_quote(
    test_client, grounded_doc, monkeypatch,
):
    import routers.chat as chat_router
    prompts = []

    async def fake_stream(system_prompt, messages, session_id=None, page_image_b64=None):
        prompts.append(system_prompt)
        evidence_id = re.search(r"\[E:(ev_[A-Za-z0-9_-]+)\]", system_prompt).group(1)
        yield "Supported [E:" + evidence_id + "]."

    monkeypatch.setattr(chat_router, "stream_chat", fake_stream)
    monkeypatch.setattr("config.get_chat_provider", lambda: "openai")
    monkeypatch.setattr("config.get_chat_model", lambda: "model")
    response = test_client.post("/api/chat/stream", json={
        "session_id": "grounded-doc",
        "messages": [{"role": "user", "content": "explain selection"}],
        "selected_text": "Figure 1   shows the grounded accuracy result.",
        "screen_context": {"mode": "viewer", "page_num": 1, "include_visual": False},
    })
    events = dict(_events(response))
    assert response.status_code == 200
    assert "Figure 1 shows the grounded accuracy result." in prompts[0]
    assert events["evidence"]["items"][0]["quote"] == "Figure 1 shows the grounded accuracy result."


def test_suggestions_reject_forged_selection_before_rate_accounting(
    test_client, grounded_doc, monkeypatch,
):
    import routers.chat as chat_router
    calls = []
    monkeypatch.setattr(chat_router, "enforce_rate_limit", lambda *_args: calls.append("rate"))

    async def forbidden_suggestions(*_args, **_kwargs):
        calls.append("llm")
        return []

    monkeypatch.setattr(chat_router, "generate_suggested_questions", forbidden_suggestions)
    response = test_client.post("/api/chat/suggestions", json={
        "session_id": "grounded-doc",
        "messages": [{"role": "user", "content": "question"}],
        "current_page": 1,
        "selected_text": "This forged text is not in the PDF.",
    })
    assert response.status_code == 400
    assert response.json()["code"] == "selected_text_not_on_page"
    assert calls == []
