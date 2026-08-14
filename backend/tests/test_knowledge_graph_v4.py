"""지식 그래프 4차(Concept Heatmap / Knowledge Gap Detection / Research
Dashboard) 회귀 테스트. 이전 차수와 동일한 fixture 패턴(test_client/
isolated_dirs)을 사용한다. Concept Heatmap/Knowledge Gap Detection은
LLM/외부 API 호출이 전혀 없어 monkeypatch 없이 순수 데이터로 검증하지만,
Research Dashboard의 AI 인사이트(get_ai_insights)는 LLM을 호출하므로
test_knowledge_graph_v3.py의 추천 논문 테스트와 동일하게
llm_client.generate_dashboard_insights를 monkeypatch한다.
"""
import pytest


def _create_doc_owned_by(isolated_dirs, doc_id: str, username: str, metadata: dict = None):
    db = isolated_dirs["db"]
    meta = metadata if metadata is not None else {"title": f"{doc_id} title"}
    db.db_save_document(doc_id, username, f"{doc_id}.pdf", "/x/nonexistent.pdf", 3, meta)


# ── Concept Heatmap ──────────────────────────────────────────────────────

def test_heatmap_counts_papers_and_questions_per_concept(test_client, isolated_dirs):
    db = isolated_dirs["db"]
    _create_doc_owned_by(isolated_dirs, "doc-hm-1", "testuser", {"title": "Paper A"})
    _create_doc_owned_by(isolated_dirs, "doc-hm-2", "testuser", {"title": "Paper B"})

    concept_id = db.db_upsert_concept("Attention", "attention", "method")
    db.db_link_paper_concept("doc-hm-1", concept_id)
    db.db_link_paper_concept("doc-hm-2", concept_id)

    chat_id = db.db_save_chat_message("doc-hm-1", "user", "How does attention work?")
    db.db_link_question_concept(chat_id, concept_id)

    res = test_client.get("/api/library/graph/heatmap")
    assert res.status_code == 200
    heatmap = res.json()["heatmap"]

    entry = next(h for h in heatmap if h["concept_id"] == concept_id)
    assert entry["paper_count"] == 2
    assert entry["question_count"] == 1
    assert entry["score"] == 3


def test_heatmap_sorted_by_score_descending(test_client, isolated_dirs):
    db = isolated_dirs["db"]
    _create_doc_owned_by(isolated_dirs, "doc-hm-3", "testuser", {"title": "Paper C"})

    low_id = db.db_upsert_concept("Rare Concept", "rare concept", "theory")
    high_id = db.db_upsert_concept("Popular Concept", "popular concept", "method")
    db.db_link_paper_concept("doc-hm-3", low_id)
    db.db_link_paper_concept("doc-hm-3", high_id)
    for i in range(3):
        chat_id = db.db_save_chat_message("doc-hm-3", "user", f"question {i}")
        db.db_link_question_concept(chat_id, high_id)

    res = test_client.get("/api/library/graph/heatmap")
    heatmap = res.json()["heatmap"]
    ids_in_order = [h["concept_id"] for h in heatmap]
    assert ids_in_order.index(high_id) < ids_in_order.index(low_id)


def test_heatmap_excludes_other_users_data(test_client, isolated_dirs):
    db = isolated_dirs["db"]
    _create_doc_owned_by(isolated_dirs, "doc-hm-other", "otheruser", {"title": "Not Mine"})
    concept_id = db.db_upsert_concept("Other Concept", "other concept", "method")
    db.db_link_paper_concept("doc-hm-other", concept_id)

    res = test_client.get("/api/library/graph/heatmap")
    heatmap = res.json()["heatmap"]
    assert not any(h["concept_id"] == concept_id for h in heatmap)


# ── Concept Heatmap Matrix (논문 x 개념 2D, LLM 채점) ─────────────────────

def _setup_one_paper_one_concept(isolated_dirs, doc_id="doc-mx-1", title="Paper A"):
    db = isolated_dirs["db"]
    _create_doc_owned_by(isolated_dirs, doc_id, "testuser", {"title": title})
    concept_id = db.db_upsert_concept("Attention", "attention", "method")
    db.db_link_paper_concept(doc_id, concept_id)
    chat_id = db.db_save_chat_message(doc_id, "user", "How does attention work?")
    db.db_link_question_paper(chat_id, doc_id)
    db.db_link_question_concept(chat_id, concept_id)
    return concept_id


def test_heatmap_matrix_uses_llm_score(test_client, isolated_dirs, monkeypatch):
    import services.llm_client as llm_client

    async def fake_score(title, text, concept_names, session_id=None):
        return [{"concept": name, "score": 0.75} for name in concept_names]

    monkeypatch.setattr(llm_client, "score_paper_concept_relevance", fake_score)

    concept_id = _setup_one_paper_one_concept(isolated_dirs)

    res = test_client.get("/api/library/graph/heatmap/matrix")
    assert res.status_code == 200
    body = res.json()
    assert any(c["concept_id"] == concept_id for c in body["concepts"])
    assert any(p["doc_id"] == "doc-mx-1" for p in body["papers"])

    cell = next(c for c in body["cells"] if c["doc_id"] == "doc-mx-1" and c["concept_id"] == concept_id)
    assert cell["present"] is True
    assert cell["question_count"] == 1
    assert cell["score"] == 0.75


def test_heatmap_matrix_falls_back_to_presence_when_llm_fails(test_client, isolated_dirs, monkeypatch):
    import services.llm_client as llm_client

    async def failing_score(title, text, concept_names, session_id=None):
        raise RuntimeError("LLM 호출 실패")

    monkeypatch.setattr(llm_client, "score_paper_concept_relevance", failing_score)

    concept_id = _setup_one_paper_one_concept(isolated_dirs)

    res = test_client.get("/api/library/graph/heatmap/matrix")
    assert res.status_code == 200
    body = res.json()
    cell = next(c for c in body["cells"] if c["doc_id"] == "doc-mx-1" and c["concept_id"] == concept_id)
    # LLM 채점이 실패해도 매트릭스 자체는 무너지지 않고 등장 여부(1.0)로 대체된다.
    assert cell["present"] is True
    assert cell["score"] == 1.0


def test_heatmap_matrix_caches_result_without_recalling_llm(test_client, isolated_dirs, monkeypatch):
    import services.llm_client as llm_client

    call_count = {"n": 0}

    async def fake_score(title, text, concept_names, session_id=None):
        call_count["n"] += 1
        return [{"concept": name, "score": 0.5} for name in concept_names]

    monkeypatch.setattr(llm_client, "score_paper_concept_relevance", fake_score)

    _setup_one_paper_one_concept(isolated_dirs)

    res1 = test_client.get("/api/library/graph/heatmap/matrix")
    assert res1.status_code == 200
    assert call_count["n"] == 1

    res2 = test_client.get("/api/library/graph/heatmap/matrix")
    assert res2.status_code == 200
    assert call_count["n"] == 1  # 캐시가 유효한 동안은 LLM을 다시 호출하지 않는다

    res3 = test_client.get("/api/library/graph/heatmap/matrix?force=true")
    assert res3.status_code == 200
    assert call_count["n"] == 2  # force=true는 캐시를 무시하고 새로 채점한다


def test_heatmap_matrix_omits_papers_without_ranked_concepts(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-mx-unrelated", "testuser", {"title": "Unrelated Paper"})

    res = test_client.get("/api/library/graph/heatmap/matrix")
    body = res.json()
    assert not any(p["doc_id"] == "doc-mx-unrelated" for p in body["papers"])


def test_heatmap_matrix_excludes_other_users_data(test_client, isolated_dirs):
    db = isolated_dirs["db"]
    _create_doc_owned_by(isolated_dirs, "doc-mx-other", "otheruser", {"title": "Not Mine"})
    concept_id = db.db_upsert_concept("Other Concept", "other concept matrix", "method")
    db.db_link_paper_concept("doc-mx-other", concept_id)

    res = test_client.get("/api/library/graph/heatmap/matrix")
    body = res.json()
    assert not any(p["doc_id"] == "doc-mx-other" for p in body["papers"])
    assert not any(c["concept_id"] == concept_id for c in body["concepts"])


# ── Knowledge Gap Detection ──────────────────────────────────────────────

def test_gap_detects_low_question_concept(test_client, isolated_dirs):
    db = isolated_dirs["db"]
    _create_doc_owned_by(isolated_dirs, "doc-gap-1", "testuser", {"title": "Paper A"})
    _create_doc_owned_by(isolated_dirs, "doc-gap-2", "testuser", {"title": "Paper B"})
    concept_id = db.db_upsert_concept("Diffusion", "diffusion", "method")
    db.db_link_paper_concept("doc-gap-1", concept_id)
    db.db_link_paper_concept("doc-gap-2", concept_id)  # 논문 2편에 등장, 질문은 0개

    res = test_client.get("/api/library/graph/gaps")
    gaps = res.json()["gaps"]
    assert any(g["type"] == "low_question_concept" and g["concept_id"] == concept_id for g in gaps)


def test_gap_skips_concept_with_only_one_paper(test_client, isolated_dirs):
    """논문 1편에만 등장하는 개념은 임계값(paper_count>=2) 미달이라 격차로 잡히면 안 된다."""
    db = isolated_dirs["db"]
    _create_doc_owned_by(isolated_dirs, "doc-gap-single", "testuser", {"title": "Paper A"})
    concept_id = db.db_upsert_concept("New Idea", "new idea", "theory")
    db.db_link_paper_concept("doc-gap-single", concept_id)

    res = test_client.get("/api/library/graph/gaps")
    gaps = res.json()["gaps"]
    assert not any(g.get("concept_id") == concept_id for g in gaps)


def test_gap_detects_read_paper_without_notes(test_client, isolated_dirs):
    db = isolated_dirs["db"]
    _create_doc_owned_by(
        isolated_dirs, "doc-gap-nonotes", "testuser",
        {"title": "Mamba Paper", "read": True, "read_at": "2026-01-01T00:00:00+00:00"},
    )

    res = test_client.get("/api/library/graph/gaps")
    gaps = res.json()["gaps"]
    assert any(g["type"] == "no_notes_paper" and g["doc_id"] == "doc-gap-nonotes" for g in gaps)


def test_gap_skips_read_paper_with_notes(test_client, isolated_dirs):
    db = isolated_dirs["db"]
    _create_doc_owned_by(
        isolated_dirs, "doc-gap-hasnotes", "testuser",
        {"title": "Well Noted Paper", "read": True, "read_at": "2026-01-01T00:00:00+00:00"},
    )
    db.db_put_memos("doc-gap-hasnotes", {"page_1": [{"id": "memo_1700000000000", "content": "메모 있음"}]})

    res = test_client.get("/api/library/graph/gaps")
    gaps = res.json()["gaps"]
    assert not any(g.get("doc_id") == "doc-gap-hasnotes" for g in gaps)


def test_gap_skips_unread_paper_without_notes(test_client, isolated_dirs):
    """읽음 표시를 안 한 논문은 메모가 없어도 격차로 잡히면 안 된다(아직 안 읽었을 뿐)."""
    _create_doc_owned_by(isolated_dirs, "doc-gap-unread", "testuser", {"title": "Unread Paper"})

    res = test_client.get("/api/library/graph/gaps")
    gaps = res.json()["gaps"]
    assert not any(g.get("doc_id") == "doc-gap-unread" for g in gaps)


# ── Research Dashboard ───────────────────────────────────────────────────

def test_dashboard_stats_and_recent_lists(test_client, isolated_dirs, monkeypatch):
    import services.llm_client as llm_client

    async def fake_generate_insights(profile, session_id=None):
        return [{"type": "summary", "message": "테스트 인사이트"}]

    monkeypatch.setattr(llm_client, "generate_dashboard_insights", fake_generate_insights)

    db = isolated_dirs["db"]
    _create_doc_owned_by(
        isolated_dirs, "doc-dash-1", "testuser",
        {"title": "Dashboard Paper", "read": True, "read_at": "2026-01-01T00:00:00+00:00"},
    )
    concept_id = db.db_upsert_concept("Dashboard Concept", "dashboard concept", "method")
    db.db_link_paper_concept("doc-dash-1", concept_id)
    chat_id = db.db_save_chat_message("doc-dash-1", "user", "질문 테스트")
    db.db_link_question_paper(chat_id, "doc-dash-1")
    db.db_link_question_concept(chat_id, concept_id)
    db.db_put_memos("doc-dash-1", {"page_1": [{"id": "memo_1700000000000", "content": "메모 테스트"}]})

    res = test_client.get("/api/library/dashboard")
    assert res.status_code == 200
    data = res.json()

    assert data["stats"]["total_papers"] == 1
    assert data["stats"]["read_papers"] == 1
    assert data["stats"]["total_concepts"] == 1
    assert data["stats"]["total_questions"] == 1
    assert data["stats"]["total_notes"] == 1
    assert data["stats"]["total_pages"] == 3
    # 완독 표시됐고 참고문헌 시작 페이지 정보가 아직 없는 문서는(캐시된 페이지
    # 텍스트가 없음) 전체 페이지 수(3)를 그대로 읽은 페이지로 본다(폴백).
    assert data["stats"]["read_pages"] == 3

    assert any(h["concept_id"] == concept_id for h in data["heatmap"])
    assert any(q["summary"] == "질문 테스트" for q in data["recent_questions"])
    assert any(n["summary"] == "메모 테스트" for n in data["recent_notes"])
    assert any(p["doc_id"] == "doc-dash-1" for p in data["recent_papers"])
    assert data["insights"] == [{"type": "summary", "message": "테스트 인사이트"}]


def test_dashboard_excludes_other_users_data(test_client, isolated_dirs):
    # testuser 소유 문서가 0건이라 get_ai_insights가 LLM을 호출하지 않고 바로
    # 빈 규칙 기반 결과로 반환하므로(문서가 없으면 근거가 없어 조기 반환)
    # 별도 monkeypatch가 필요 없다.
    _create_doc_owned_by(isolated_dirs, "doc-dash-other", "otheruser", {"title": "Not Mine"})

    res = test_client.get("/api/library/dashboard")
    data = res.json()
    assert data["stats"]["total_papers"] == 0
    assert not any(p["doc_id"] == "doc-dash-other" for p in data["recent_papers"])


# ── AI Insights (LLM 기반) ───────────────────────────────────────────────

@pytest.mark.asyncio
async def test_ai_insights_uses_llm_result_when_available(isolated_dirs, monkeypatch):
    import services.llm_client as llm_client
    import services.knowledge_graph as knowledge_graph

    _create_doc_owned_by(isolated_dirs, "doc-insight-1", "testuser", {"title": "Insight Paper"})

    captured = {}

    async def fake_generate_insights(profile, session_id=None):
        captured["profile"] = profile
        return [{"type": "advice", "message": "다음엔 관련 논문을 더 찾아보세요."}]

    monkeypatch.setattr(llm_client, "generate_dashboard_insights", fake_generate_insights)

    result = await knowledge_graph.get_ai_insights("testuser")
    assert result == [{"type": "advice", "message": "다음엔 관련 논문을 더 찾아보세요."}]
    assert captured["profile"]["stats"]["total_papers"] == 1


@pytest.mark.asyncio
async def test_ai_insights_reextracts_filename_title_for_prompt(isolated_dirs, monkeypatch, tmp_path):
    import services.llm_client as llm_client
    import services.pdf_parser as pdf_parser
    import services.knowledge_graph as knowledge_graph

    db = isolated_dirs["db"]
    pdf_path = tmp_path / "uploaded_file.pdf"
    pdf_path.write_bytes(b"%PDF-test")
    db.db_save_document(
        "doc-insight-title",
        "testuser",
        "uploaded_file.pdf",
        str(pdf_path),
        1,
        {"title": "uploaded_file.pdf"},
    )
    db.db_put_memos("doc-insight-title", {
        "page_1": [{"id": "memo_1700000000000", "content": "핵심 메모"}],
    })

    monkeypatch.setattr(
        pdf_parser,
        "get_pdf_metadata",
        lambda _path: {"title": "Automatically Extracted Paper Title"},
    )
    captured = {}

    async def fake_generate_insights(profile, session_id=None):
        captured["profile"] = profile
        return [{"type": "summary", "message": "제목 테스트"}]

    monkeypatch.setattr(llm_client, "generate_dashboard_insights", fake_generate_insights)

    await knowledge_graph.get_ai_insights("testuser")

    assert captured["profile"]["notes"] == [
        "[Automatically Extracted Paper Title] 핵심 메모",
    ]
    assert db.db_get_document("doc-insight-title")["metadata"]["title"] == (
        "Automatically Extracted Paper Title"
    )


@pytest.mark.asyncio
async def test_ai_insights_preserves_manual_title_matching_filename(
    test_client, isolated_dirs, monkeypatch, tmp_path,
):
    import services.llm_client as llm_client
    import services.pdf_parser as pdf_parser
    import services.knowledge_graph as knowledge_graph

    db = isolated_dirs["db"]
    pdf_path = tmp_path / "Muon is Scalable for LLM Training.pdf"
    pdf_path.write_bytes(b"%PDF-test")
    db.db_save_document(
        "doc-manual-title",
        "testuser",
        pdf_path.name,
        str(pdf_path),
        1,
        {"title": "Wrong Embedded PDF Title"},
    )
    res = test_client.put(
        "/api/library/doc-manual-title/title",
        json={"title": "Muon is Scalable for LLM Training"},
    )
    assert res.status_code == 200

    monkeypatch.setattr(
        pdf_parser,
        "get_pdf_metadata",
        lambda _path: {"title": "Wrong Embedded PDF Title"},
    )

    async def fake_generate_insights(*_args, **_kwargs):
        return []

    monkeypatch.setattr(llm_client, "generate_dashboard_insights", fake_generate_insights)

    await knowledge_graph.get_ai_insights("testuser")

    metadata = db.db_get_document("doc-manual-title")["metadata"]
    assert metadata["title"] == "Muon is Scalable for LLM Training"
    assert metadata["title_source"] == "manual"


@pytest.mark.asyncio
async def test_ai_insights_falls_back_to_rule_based_gaps_when_llm_empty(isolated_dirs, monkeypatch):
    import services.llm_client as llm_client
    import services.knowledge_graph as knowledge_graph

    _create_doc_owned_by(
        isolated_dirs, "doc-insight-nonotes", "testuser",
        {"title": "No Notes Paper", "read": True, "read_at": "2026-01-01T00:00:00+00:00"},
    )

    async def fake_generate_insights(profile, session_id=None):
        return []  # LLM 실패/빈 응답 상황을 흉내

    monkeypatch.setattr(llm_client, "generate_dashboard_insights", fake_generate_insights)

    result = await knowledge_graph.get_ai_insights("testuser")
    assert any(g["type"] == "no_notes_paper" and g["doc_id"] == "doc-insight-nonotes" for g in result)


@pytest.mark.asyncio
async def test_ai_insights_caches_result_for_a_day(isolated_dirs, monkeypatch):
    import services.llm_client as llm_client
    import services.knowledge_graph as knowledge_graph

    _create_doc_owned_by(isolated_dirs, "doc-insight-cache", "testuser", {"title": "Cache Paper"})

    call_count = {"n": 0}

    async def fake_generate_insights(profile, session_id=None):
        call_count["n"] += 1
        return [{"type": "summary", "message": f"호출 {call_count['n']}회"}]

    monkeypatch.setattr(llm_client, "generate_dashboard_insights", fake_generate_insights)

    first = await knowledge_graph.get_ai_insights("testuser")
    second = await knowledge_graph.get_ai_insights("testuser")
    assert first == second
    assert call_count["n"] == 1  # 캐시가 있으면 LLM을 다시 호출하지 않는다


@pytest.mark.asyncio
async def test_ai_insights_invalidates_cache_when_extracted_title_changes(isolated_dirs, monkeypatch):
    import services.llm_client as llm_client
    import services.knowledge_graph as knowledge_graph

    db = isolated_dirs["db"]
    _create_doc_owned_by(isolated_dirs, "doc-insight-retitle", "testuser", {"title": "Old Title"})

    call_count = {"n": 0}

    async def fake_generate_insights(profile, session_id=None):
        call_count["n"] += 1
        return [{"type": "summary", "message": f"호출 {call_count['n']}회"}]

    monkeypatch.setattr(llm_client, "generate_dashboard_insights", fake_generate_insights)

    first = await knowledge_graph.get_ai_insights("testuser")
    doc = db.db_get_document("doc-insight-retitle")
    metadata = doc["metadata"]
    metadata["title"] = "Automatically Extracted New Title"
    db.db_update_document_metadata("doc-insight-retitle", metadata)
    second = await knowledge_graph.get_ai_insights("testuser")

    assert first != second
    assert call_count["n"] == 2
