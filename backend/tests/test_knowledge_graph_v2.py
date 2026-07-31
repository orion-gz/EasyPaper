"""지식 그래프 2차(Question 노드 / Note 노드 / Node Search / AI Graph Linking)
회귀 테스트. test_library_graph_api.py와 동일한 fixture 패턴(test_client/
isolated_dirs)을 사용한다.
"""
import pytest


def _create_doc_owned_by(isolated_dirs, doc_id: str, username: str, metadata: dict = None):
    db = isolated_dirs["db"]
    meta = metadata if metadata is not None else {"title": f"{doc_id} title"}
    db.db_save_document(doc_id, username, f"{doc_id}.pdf", "/x/nonexistent.pdf", 3, meta)


# ── Question → Concept 매칭 ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_sync_question_for_graph_links_single_doc(isolated_dirs, monkeypatch):
    import services.llm_client as llm_client
    import services.knowledge_graph as knowledge_graph
    from services import db

    _create_doc_owned_by(isolated_dirs, "doc-q-1", "testuser", {"title": "Paper Q1"})
    concept_id = db.db_upsert_concept("Sharpness Aware Minimization", "sharpness aware minimization", "method")
    db.db_link_paper_concept("doc-q-1", concept_id)

    chat_id = db.db_save_chat_message("doc-q-1", "user", "Why does SAM improve generalization?")
    assert chat_id is not None

    async def fake_match(question, concept_names, session_id=None):
        assert "Sharpness Aware Minimization" in concept_names
        return [{"concept": "Sharpness Aware Minimization"}]

    monkeypatch.setattr(llm_client, "match_question_to_concepts", fake_match)

    await knowledge_graph.sync_question_for_graph(chat_id, "doc-q-1", "Why does SAM improve generalization?")

    with db.get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT graph_synced_at FROM chats WHERE id = ?", (chat_id,))
        assert cursor.fetchone()["graph_synced_at"] is not None

    linked_concepts = db.db_get_related_questions_for_concept(concept_id)
    assert any(q["content"] == "Why does SAM improve generalization?" for q in linked_concepts)

    papers = db.db_get_related_questions_for_doc("doc-q-1")
    assert any(q["content"] == "Why does SAM improve generalization?" for q in papers)


@pytest.mark.asyncio
async def test_sync_question_for_graph_resolves_compare_session(isolated_dirs, monkeypatch):
    """비교 세션의 가상 doc_id(cmp_...)는 compare_sessions를 통해 실제 문서
    id 목록으로 역매핑되어, 각 문서마다 question_papers 행이 생겨야 한다."""
    import services.llm_client as llm_client
    import services.knowledge_graph as knowledge_graph
    from services import db

    _create_doc_owned_by(isolated_dirs, "doc-cmp-a", "testuser", {"title": "Paper A"})
    _create_doc_owned_by(isolated_dirs, "doc-cmp-b", "testuser", {"title": "Paper B"})
    compare_id = "cmp_testhash"
    db.db_upsert_compare_session(compare_id, "testuser", ["doc-cmp-a", "doc-cmp-b"])

    chat_id = db.db_save_chat_message(compare_id, "user", "Compare these two papers")
    assert chat_id is not None

    async def fake_match(question, concept_names, session_id=None):
        return []

    monkeypatch.setattr(llm_client, "match_question_to_concepts", fake_match)

    await knowledge_graph.sync_question_for_graph(chat_id, compare_id, "Compare these two papers")

    assert any(q["content"] == "Compare these two papers" for q in db.db_get_related_questions_for_doc("doc-cmp-a"))
    assert any(q["content"] == "Compare these two papers" for q in db.db_get_related_questions_for_doc("doc-cmp-b"))


@pytest.mark.asyncio
async def test_sync_question_for_graph_skips_llm_when_no_concepts_yet(isolated_dirs, monkeypatch):
    """해당 논문에 아직 추출된 개념이 없으면 매칭 LLM 호출 자체를 하지 않고
    question_papers 연결만 하고 넘어가야 한다(다음 backfill 때 다시 시도됨)."""
    import services.llm_client as llm_client
    import services.knowledge_graph as knowledge_graph
    from services import db

    _create_doc_owned_by(isolated_dirs, "doc-q-noconcepts", "testuser", {"title": "No concepts yet"})
    chat_id = db.db_save_chat_message("doc-q-noconcepts", "user", "What is this paper about?")

    called = {"n": 0}

    async def fake_match(question, concept_names, session_id=None):
        called["n"] += 1
        return []

    monkeypatch.setattr(llm_client, "match_question_to_concepts", fake_match)
    await knowledge_graph.sync_question_for_graph(chat_id, "doc-q-noconcepts", "What is this paper about?")

    assert called["n"] == 0
    assert any(q["content"] == "What is this paper about?" for q in db.db_get_related_questions_for_doc("doc-q-noconcepts"))


# ── AI Graph Linking (concept_edges) ────────────────────────────────────

def test_concept_edge_is_symmetric_and_deduplicated(isolated_dirs):
    db = isolated_dirs["db"]
    id_a = db.db_upsert_concept("LLM", "llm", "concept")
    id_b = db.db_upsert_concept("Large Language Model", "large language model", "concept")

    db.db_upsert_concept_edge(id_a, id_b)
    db.db_upsert_concept_edge(id_b, id_a)  # 반대 순서로 다시 넣어도 중복 생성되면 안 됨

    edges = db.db_get_concept_edges_for_concepts([id_a, id_b])
    assert len(edges) == 1
    assert {edges[0]["concept_id_a"], edges[0]["concept_id_b"]} == {id_a, id_b}


def test_concept_edge_self_loop_is_noop(isolated_dirs):
    db = isolated_dirs["db"]
    concept_id = db.db_upsert_concept("Diffusion", "diffusion", "concept")
    db.db_upsert_concept_edge(concept_id, concept_id)
    assert db.db_get_concept_edges_for_concepts([concept_id]) == []


# ── Note 노드 (memos) ────────────────────────────────────────────────────

def test_graph_endpoint_includes_note_nodes_from_memos(test_client, isolated_dirs):
    db = isolated_dirs["db"]
    _create_doc_owned_by(
        isolated_dirs, "doc-note-1", "testuser",
        {"title": "Paper With Memo", "graph_synced_at": "2026-01-01T00:00:00+00:00"},
    )
    db.db_put_memos("doc-note-1", {"page_1": [{"id": "memo-abc", "text": "Figure 4가 핵심"}]})

    res = test_client.get("/api/library/graph")
    assert res.status_code == 200
    data = res.json()

    note_nodes = [n for n in data["nodes"] if n["type"] == "note"]
    assert any(n["id"] == "note:doc-note-1:memo-abc" for n in note_nodes)

    notes_on_edges = [e for e in data["edges"] if e["type"] == "notes_on"]
    assert any(
        e["source"] == "note:doc-note-1:memo-abc" and e["target"] == "paper:doc-note-1"
        for e in notes_on_edges
    )


def test_graph_endpoint_excludes_other_users_notes(test_client, isolated_dirs):
    db = isolated_dirs["db"]
    _create_doc_owned_by(
        isolated_dirs, "doc-other-note", "otheruser",
        {"title": "Not Mine", "graph_synced_at": "2026-01-01T00:00:00+00:00"},
    )
    db.db_put_memos("doc-other-note", {"page_1": [{"id": "memo-other", "text": "다른 사용자 메모"}]})

    res = test_client.get("/api/library/graph")
    assert res.status_code == 200
    data = res.json()
    note_nodes = [n for n in data["nodes"] if n["type"] == "note"]
    assert not any(n["id"] == "note:doc-other-note:memo-other" for n in note_nodes)


# ── Node Search ──────────────────────────────────────────────────────────

def test_graph_search_finds_paper_and_concept(test_client, isolated_dirs):
    db = isolated_dirs["db"]
    _create_doc_owned_by(
        isolated_dirs, "doc-search-1", "testuser",
        {"title": "Vision Transformer Study", "graph_synced_at": "2026-01-01T00:00:00+00:00"},
    )
    concept_id = db.db_upsert_concept("Vision Transformer", "vision transformer", "method")
    db.db_link_paper_concept("doc-search-1", concept_id)

    res = test_client.get("/api/library/graph/search?q=Vision Transformer")
    assert res.status_code == 200
    data = res.json()
    assert "paper:doc-search-1" in data["paper"]
    assert f"concept:{concept_id}" in data["concept"]


def test_graph_search_excludes_other_users_documents(test_client, isolated_dirs):
    db = isolated_dirs["db"]
    _create_doc_owned_by(isolated_dirs, "doc-search-mine", "testuser", {"title": "Shared Keyword Paper"})
    _create_doc_owned_by(isolated_dirs, "doc-search-other", "otheruser", {"title": "Shared Keyword Paper"})

    res = test_client.get("/api/library/graph/search?q=Shared Keyword")
    assert res.status_code == 200
    data = res.json()
    assert "paper:doc-search-mine" in data["paper"]
    assert "paper:doc-search-other" not in data["paper"]


def test_graph_search_empty_query_returns_empty(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-search-empty", "testuser", {"title": "Anything"})
    res = test_client.get("/api/library/graph/search?q=")
    assert res.status_code == 200
    data = res.json()
    assert data == {"paper": [], "concept": [], "note": []}


# ── 관련 질문 상세 패널 ────────────────────────────────────────────────────

def test_graph_questions_endpoint_for_concept(test_client, isolated_dirs):
    db = isolated_dirs["db"]
    _create_doc_owned_by(isolated_dirs, "doc-detail-1", "testuser", {"title": "Detail Paper"})
    concept_id = db.db_upsert_concept("Loss Landscape", "loss landscape", "theory")
    db.db_link_paper_concept("doc-detail-1", concept_id)
    chat_id = db.db_save_chat_message("doc-detail-1", "user", "What is Loss Landscape?")
    db.db_link_question_paper(chat_id, "doc-detail-1")
    db.db_link_question_concept(chat_id, concept_id)

    res = test_client.get(f"/api/library/graph/questions?node_id=concept:{concept_id}")
    assert res.status_code == 200
    questions = res.json()["questions"]
    assert any(q["content"] == "What is Loss Landscape?" for q in questions)


def test_graph_questions_endpoint_excludes_other_users_concept_links(test_client, isolated_dirs):
    """다른 사용자 문서에 연결된 질문이, 같은 concept_id를 공유하더라도
    이 사용자의 상세 패널 조회 결과에 섞여 나오면 안 된다."""
    db = isolated_dirs["db"]
    _create_doc_owned_by(isolated_dirs, "doc-detail-other", "otheruser", {"title": "Other User Paper"})
    concept_id = db.db_upsert_concept("Shared Concept", "shared concept", "theory")
    db.db_link_paper_concept("doc-detail-other", concept_id)
    chat_id = db.db_save_chat_message("doc-detail-other", "user", "Other user's question")
    db.db_link_question_paper(chat_id, "doc-detail-other")
    db.db_link_question_concept(chat_id, concept_id)

    res = test_client.get(f"/api/library/graph/questions?node_id=concept:{concept_id}")
    assert res.status_code == 200
    questions = res.json()["questions"]
    assert not any(q["content"] == "Other user's question" for q in questions)


def test_graph_questions_endpoint_for_other_users_paper_returns_empty(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-detail-notmine", "otheruser", {"title": "Not Mine"})
    res = test_client.get("/api/library/graph/questions?node_id=paper:doc-detail-notmine")
    assert res.status_code == 200
    assert res.json()["questions"] == []
