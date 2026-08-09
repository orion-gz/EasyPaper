from services.knowledge_graph import _build_category_edges


def test_build_category_edges_only_compares_docs_with_shared_categories():
    docs = [
        {"id": "a", "metadata": {"categories": ["ml", "vision", "ml"]}},
        {"id": "b", "metadata": {"categories": ["ml"]}},
        {"id": "c", "metadata": {"categories": ["vision"]}},
        {"id": "d", "metadata": {"categories": ["systems"]}},
        {"id": "e", "metadata": {}},
    ]

    edges = _build_category_edges(docs)

    assert {
        (edge["source"], edge["target"], edge["category"])
        for edge in edges
    } == {
        ("paper:a", "paper:b", "ml"),
        ("paper:a", "paper:c", "vision"),
    }


def test_build_category_edges_emits_each_output_pair_once():
    docs = [
        {"id": "a", "metadata": {"categories": ["shared"]}},
        {"id": "b", "metadata": {"categories": ["shared"]}},
        {"id": "c", "metadata": {"categories": ["shared"]}},
    ]

    edges = _build_category_edges(docs)

    assert {(edge["source"], edge["target"]) for edge in edges} == {
        ("paper:a", "paper:b"),
        ("paper:a", "paper:c"),
        ("paper:b", "paper:c"),
    }
