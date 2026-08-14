from services.knowledge_graph import _build_category_edges, _queue_tag_nodes


def _tags(primary=(), domains=(), methods=()):
    def records(values):
        return [{"name": name, "confidence": 0.9, "evidence": "fixture"} for name in values]
    return {
        "version": 2,
        "source": "ai",
        "primary_topics": records(primary),
        "domains": records(domains),
        "methods": records(methods),
    }


def _doc(doc_id, *, primary=(), domains=(), methods=(), legacy=()):
    metadata = {"paper_tags": _tags(primary, domains, methods)} if not legacy else {"categories": list(legacy)}
    return {"id": doc_id, "metadata": metadata}


def test_domain_only_overlap_does_not_create_direct_paper_edge():
    docs = [
        _doc("muon", primary=("Training Optimizer",), domains=("LLM Training",)),
        _doc("harness", primary=("Harness Engineering",), domains=("LLM Applications",)),
        _doc("agent", primary=("Agent Systems",), domains=("LLM Applications",)),
    ]
    assert _build_category_edges(docs) == []


def test_shared_primary_topic_creates_weighted_edge():
    docs = [
        _doc("a", primary=("Harness Engineering",), domains=("LLM Applications",)),
        _doc("b", primary=("Harness Engineering",), domains=("Code Intelligence",)),
        _doc("c", primary=("Training Optimizer",), domains=("LLM Training",)),
    ]
    edges = _build_category_edges(docs)
    assert len(edges) == 1
    assert edges[0]["source"] == "paper:a"
    assert edges[0]["target"] == "paper:b"
    assert edges[0]["category"] == "Harness Engineering"
    assert edges[0]["relation"] == "shared_primary_topic"
    assert edges[0]["weight"] >= 1.0


def test_shared_primary_topic_emits_each_pair_once():
    docs = [_doc(doc_id, primary=("Agent Systems",)) for doc_id in ("a", "b", "c")]
    edges = _build_category_edges(docs)
    assert {(edge["source"], edge["target"]) for edge in edges} == {
        ("paper:a", "paper:b"), ("paper:a", "paper:c"), ("paper:b", "paper:c"),
    }


def test_legacy_flat_categories_do_not_create_direct_edges_before_backfill():
    docs = [_doc("a", legacy=("LLM", "Optimizer")), _doc("b", legacy=("LLM", "Optimizer"))]
    assert _build_category_edges(docs) == []


def test_all_roles_are_exposed_as_tag_nodes_without_domain_paper_edge():
    docs = [
        _doc("a", primary=("Harness Engineering",), domains=("LLM Applications",), methods=("Agentic Code Search",)),
        _doc("b", primary=("Agent Systems",), domains=("LLM Applications",)),
    ]
    nodes, edges = [], []
    _queue_tag_nodes(docs, nodes, edges)
    assert {(node["label"], node["role"]) for node in nodes} == {
        ("Harness Engineering", "primary_topic"),
        ("Agent Systems", "primary_topic"),
        ("LLM Applications", "domain"),
        ("Agentic Code Search", "method"),
    }
    assert len([node for node in nodes if node["label"] == "LLM Applications"]) == 1
    assert all(edge["type"] == "tagged_with" for edge in edges)
