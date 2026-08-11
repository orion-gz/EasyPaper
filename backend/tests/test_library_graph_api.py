"""/api/library/graph 엔드포인트 회귀 테스트.

test_library_ownership_api.py와 동일한 fixture 패턴(test_client/isolated_dirs)을
사용한다: get_current_user를 "testuser"로 고정한 TestClient 위에서, 다른
사용자("otheruser") 소유 문서가 그래프 응답에 절대 섞여 나오지 않는지, 그리고
개념/인용 데이터가 DB에 저장된 뒤 그래프 응답에 정상적으로 반영되는지 확인한다.
"""
import pytest

from services.llm_client import _parse_json_array_response


def _create_doc_owned_by(isolated_dirs, doc_id: str, username: str, metadata: dict = None):
    db = isolated_dirs["db"]
    meta = metadata if metadata is not None else {"title": f"{doc_id} title"}
    db.db_save_document(doc_id, username, f"{doc_id}.pdf", "/x/nonexistent.pdf", 3, meta)


def test_graph_endpoint_returns_expected_keys(test_client, isolated_dirs):
    _create_doc_owned_by(
        isolated_dirs, "doc-mine-graph-1", "testuser",
        {"title": "My Paper", "graph_synced_at": "2026-01-01T00:00:00+00:00"},
    )
    res = test_client.get("/api/library/graph")
    assert res.status_code == 200
    data = res.json()
    assert "nodes" in data
    assert "edges" in data
    assert "pending_docs" in data
    assert isinstance(data["nodes"], list)
    assert isinstance(data["edges"], list)
    assert isinstance(data["pending_docs"], list)

    # 동기화 완료 표시가 있는 문서는 pending_docs에 들어가지 않아야 한다
    assert "doc-mine-graph-1" not in data["pending_docs"]
    paper_ids = {n["id"] for n in data["nodes"] if n["type"] == "paper"}
    assert "paper:doc-mine-graph-1" in paper_ids


def test_graph_endpoint_excludes_other_users_documents(test_client, isolated_dirs):
    _create_doc_owned_by(
        isolated_dirs, "doc-mine-graph-2", "testuser",
        {"title": "Mine", "graph_synced_at": "2026-01-01T00:00:00+00:00"},
    )
    _create_doc_owned_by(
        isolated_dirs, "doc-other-graph-1", "otheruser",
        {"title": "Not Mine", "graph_synced_at": "2026-01-01T00:00:00+00:00"},
    )

    res = test_client.get("/api/library/graph")
    assert res.status_code == 200
    data = res.json()

    paper_doc_ids = {n["doc_id"] for n in data["nodes"] if n["type"] == "paper"}
    assert "doc-mine-graph-2" in paper_doc_ids
    assert "doc-other-graph-1" not in paper_doc_ids

    all_node_ids = {n["id"] for n in data["nodes"]}
    assert "paper:doc-other-graph-1" not in all_node_ids

    for edge in data["edges"]:
        assert "doc-other-graph-1" not in edge["source"]
        assert "doc-other-graph-1" not in edge["target"]


def test_graph_endpoint_reflects_concepts_and_citation_edges(test_client, isolated_dirs):
    db = isolated_dirs["db"]
    _create_doc_owned_by(
        isolated_dirs, "doc-mine-graph-3", "testuser",
        {"title": "Paper A", "graph_synced_at": "2026-01-01T00:00:00+00:00"},
    )
    _create_doc_owned_by(
        isolated_dirs, "doc-mine-graph-4", "testuser",
        {"title": "Paper B", "graph_synced_at": "2026-01-01T00:00:00+00:00"},
    )

    concept_id = db.db_upsert_concept("Attention Mechanism", "attention mechanism", "method")
    db.db_link_paper_concept("doc-mine-graph-3", concept_id)
    db.db_upsert_paper_edge("doc-mine-graph-3", "doc-mine-graph-4", "citation", {"ref_num": "1"})

    res = test_client.get("/api/library/graph")
    assert res.status_code == 200
    data = res.json()

    concept_nodes = [n for n in data["nodes"] if n["type"] == "concept"]
    assert any(n["id"] == f"concept:{concept_id}" and n["label"] == "Attention Mechanism" for n in concept_nodes)

    has_concept_edges = [e for e in data["edges"] if e["type"] == "has_concept"]
    assert any(
        e["source"] == "paper:doc-mine-graph-3" and e["target"] == f"concept:{concept_id}"
        for e in has_concept_edges
    )

    citation_edges = [e for e in data["edges"] if e["type"] == "citation"]
    assert any(
        e["source"] == "paper:doc-mine-graph-3" and e["target"] == "paper:doc-mine-graph-4"
        for e in citation_edges
    )


def test_graph_endpoint_marks_unsynced_docs_as_pending(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-mine-graph-5", "testuser", {"title": "Unsynced"})

    res = test_client.get("/api/library/graph")
    assert res.status_code == 200
    data = res.json()
    assert "doc-mine-graph-5" in data["pending_docs"]


def test_tag_ontology_and_manual_edit_are_closed_and_versioned(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-tags-edit", "testuser", {"title": "Meta-Harness"})

    ontology = test_client.get("/api/library/tags/ontology")
    assert ontology.status_code == 200
    assert "Harness Engineering" in ontology.json()["roles"]["primary_topic"]
    assert "Optimizer" not in ontology.json()["roles"]["primary_topic"]

    response = test_client.put("/api/library/doc-tags-edit/tags", json={
        "primary_topics": ["Harness Engineering"],
        "domains": ["LLM Applications"],
        "methods": ["Agentic Code Search"],
    })
    assert response.status_code == 200
    metadata = response.json()["metadata"]
    assert metadata["categories"] == ["Harness Engineering", "LLM Applications", "Agentic Code Search"]
    assert metadata["paper_tags"]["source"] == "user"
    assert metadata["paper_tags"]["user_edited"] is True


def test_manual_tag_edit_rejects_free_form_ambiguous_optimizer(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-tags-invalid", "testuser", {"title": "Meta-Harness"})
    response = test_client.put("/api/library/doc-tags-invalid/tags", json={
        "primary_topics": ["Optimizer"], "domains": ["LLM"], "methods": [],
    })
    assert response.status_code == 400


def test_graph_exposes_tag_nodes_but_domain_only_does_not_link_papers(test_client, isolated_dirs):
    meta_a = {
        "title": "Harness A", "graph_synced_at": "done",
        "categories": ["Harness Engineering", "LLM Applications"],
        "paper_tags": {"version": 2, "source": "user", "user_edited": True,
            "primary_topics": [{"name": "Harness Engineering"}],
            "domains": [{"name": "LLM Applications"}], "methods": []},
    }
    meta_b = {
        "title": "Agent B", "graph_synced_at": "done",
        "categories": ["Agent Systems", "LLM Applications"],
        "paper_tags": {"version": 2, "source": "user", "user_edited": True,
            "primary_topics": [{"name": "Agent Systems"}],
            "domains": [{"name": "LLM Applications"}], "methods": []},
    }
    _create_doc_owned_by(isolated_dirs, "doc-tags-a", "testuser", meta_a)
    _create_doc_owned_by(isolated_dirs, "doc-tags-b", "testuser", meta_b)
    data = test_client.get("/api/library/graph").json()
    assert any(node["type"] == "tag" and node["label"] == "LLM Applications" for node in data["nodes"])
    assert not any(edge["type"] == "category" for edge in data["edges"])


class TestParseJsonArrayResponse:
    def test_clean_json(self):
        result = _parse_json_array_response(
            '[{"concept": "Attention Mechanism", "kind": "method"}, {"concept": "Machine Translation", "kind": "task"}]'
        )
        assert result == [
            {"concept": "Attention Mechanism", "kind": "method"},
            {"concept": "Machine Translation", "kind": "task"},
        ]

    def test_fenced_json(self):
        raw = '```json\n[{"concept": "Transformer", "kind": "method"}]\n```'
        result = _parse_json_array_response(raw)
        assert result == [{"concept": "Transformer", "kind": "method"}]

    def test_fenced_json_without_language_tag(self):
        raw = '```\n[{"concept": "GAN", "kind": null}]\n```'
        result = _parse_json_array_response(raw)
        assert result == [{"concept": "GAN", "kind": None}]

    def test_garbage_raises(self):
        with pytest.raises(Exception):
            _parse_json_array_response("this is not json at all")

    def test_non_list_json_raises(self):
        with pytest.raises(ValueError):
            _parse_json_array_response('{"concept": "not a list"}')

    def test_missing_concept_key_raises(self):
        with pytest.raises(ValueError):
            _parse_json_array_response('[{"name": "missing concept key"}]')
