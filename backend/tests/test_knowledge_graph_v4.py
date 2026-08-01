"""지식 그래프 4차(Concept Heatmap / Knowledge Gap Detection / Research
Dashboard) 회귀 테스트. 이전 차수와 동일한 fixture 패턴(test_client/
isolated_dirs)을 사용한다. 이번 차수는 LLM/외부 API 호출이 전혀 없어
monkeypatch 없이 순수 데이터로 검증한다.
"""


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

def test_dashboard_stats_and_recent_lists(test_client, isolated_dirs):
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

    assert any(h["concept_id"] == concept_id for h in data["heatmap"])
    assert any(q["summary"] == "질문 테스트" for q in data["recent_questions"])
    assert any(n["summary"] == "메모 테스트" for n in data["recent_notes"])
    assert any(p["doc_id"] == "doc-dash-1" for p in data["recent_papers"])


def test_dashboard_excludes_other_users_data(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-dash-other", "otheruser", {"title": "Not Mine"})

    res = test_client.get("/api/library/dashboard")
    data = res.json()
    assert data["stats"]["total_papers"] == 0
    assert not any(p["doc_id"] == "doc-dash-other" for p in data["recent_papers"])
