"""지식 그래프 3차(Figure 노드 / Timeline View / Reading Recommendation)
회귀 테스트. 이전 차수와 동일한 fixture 패턴(test_client/isolated_dirs)을
사용한다.
"""
import json

import pytest


def _create_doc_owned_by(isolated_dirs, doc_id: str, username: str, metadata: dict = None):
    db = isolated_dirs["db"]
    meta = metadata if metadata is not None else {"title": f"{doc_id} title"}
    db.db_save_document(doc_id, username, f"{doc_id}.pdf", "/x/nonexistent.pdf", 3, meta)


# ── Figure 노드 ──────────────────────────────────────────────────────────

def test_graph_endpoint_includes_labeled_figure_nodes(test_client, isolated_dirs, monkeypatch):
    import services.library as library
    import services.cache as cache

    _create_doc_owned_by(
        isolated_dirs, "doc-fig-1", "testuser",
        {"title": "Figure Paper", "graph_synced_at": "2026-01-01T00:00:00+00:00"},
    )
    monkeypatch.setattr(library, "get_pdf_path", lambda doc_id: "/fake/path.pdf")
    monkeypatch.setattr(cache, "get_cached_images", lambda doc_id, pdf_path: [
        {"page": 1, "label": "Figure 1", "caption": "설명"},
        {"page": 2, "label": None, "caption": None},  # 라벨 없는 항목은 제외돼야 함
    ])

    res = test_client.get("/api/library/graph")
    assert res.status_code == 200
    data = res.json()

    figure_nodes = [n for n in data["nodes"] if n["type"] == "figure"]
    assert len(figure_nodes) == 1
    assert figure_nodes[0]["id"] == "figure:doc-fig-1:0"
    assert figure_nodes[0]["label"] == "Figure 1"
    # 상세 패널에서 실제 이미지를 크롭 서빙(figure-image 엔드포인트)하고 캡션을
    # 보여주려면 index/page/caption이 노드 데이터에 그대로 실려 있어야 한다.
    assert figure_nodes[0]["index"] == 0
    assert figure_nodes[0]["page"] == 1
    assert figure_nodes[0]["caption"] == "설명"

    shows_figure_edges = [e for e in data["edges"] if e["type"] == "shows_figure"]
    assert any(e["source"] == "figure:doc-fig-1:0" and e["target"] == "paper:doc-fig-1" for e in shows_figure_edges)


def test_graph_endpoint_skips_figures_without_cache(test_client, isolated_dirs, monkeypatch):
    """캐시가 없는 문서는 PDF를 강제로 파싱하지 않고 그냥 Figure 노드 없이 넘어가야 한다."""
    import services.library as library
    import services.cache as cache

    _create_doc_owned_by(
        isolated_dirs, "doc-fig-2", "testuser",
        {"title": "No Cache Yet", "graph_synced_at": "2026-01-01T00:00:00+00:00"},
    )
    monkeypatch.setattr(library, "get_pdf_path", lambda doc_id: "/fake/path.pdf")
    monkeypatch.setattr(cache, "get_cached_images", lambda doc_id, pdf_path: None)

    res = test_client.get("/api/library/graph")
    assert res.status_code == 200
    data = res.json()
    assert not any(n["type"] == "figure" for n in data["nodes"])


def test_graph_endpoint_excludes_other_users_figures(test_client, isolated_dirs, monkeypatch):
    import services.library as library
    import services.cache as cache

    _create_doc_owned_by(
        isolated_dirs, "doc-fig-other", "otheruser",
        {"title": "Not Mine", "graph_synced_at": "2026-01-01T00:00:00+00:00"},
    )
    monkeypatch.setattr(library, "get_pdf_path", lambda doc_id: "/fake/path.pdf")
    monkeypatch.setattr(cache, "get_cached_images", lambda doc_id, pdf_path: [{"page": 1, "label": "Figure 1"}])

    res = test_client.get("/api/library/graph")
    assert res.status_code == 200
    data = res.json()
    assert not any(n["type"] == "figure" for n in data["nodes"])


# ── Timeline View ────────────────────────────────────────────────────────

def test_timeline_endpoint_merges_event_types(test_client, isolated_dirs):
    db = isolated_dirs["db"]
    _create_doc_owned_by(
        isolated_dirs, "doc-tl-1", "testuser",
        {
            "title": "Timeline Paper", "read": True, "read_at": "2026-02-02T00:00:00+00:00",
        },
    )
    chat_id = db.db_save_chat_message("doc-tl-1", "user", "What is this about?")
    db.db_link_question_paper(chat_id, "doc-tl-1")
    db.db_put_memos("doc-tl-1", {"page_1": [{"id": "memo_1700000000000", "content": "핵심 메모"}]})

    res = test_client.get("/api/library/timeline")
    assert res.status_code == 200
    events = res.json()["events"]

    types = {e["type"] for e in events}
    assert types == {"uploaded", "read", "question", "note"}
    assert any(e["type"] == "note" and e["summary"] == "핵심 메모" for e in events)
    assert any(e["type"] == "question" and e["summary"] == "What is this about?" for e in events)


def test_timeline_prefers_reading_analytics_verified_pages(test_client, isolated_dirs):
    db = isolated_dirs["db"]
    _create_doc_owned_by(isolated_dirs, "doc-analytics", "testuser", {
        "title": "Analytics Paper",
        "read_sessions": [{
            "timestamp": "2026-02-02T10:00:00+00:00",
            "start_page": 1, "end_page": 9, "verified_pages": 9,
        }],
    })
    db.db_save_reading_session(
        session_id="analytics-session", username="testuser", paper_id="doc-analytics",
        started_at="2026-02-02T10:00:00+00:00",
        ended_at="2026-02-02T10:05:00+00:00", active_reading_time=300, version=1,
        page_sessions_json=json.dumps([{
            "page": 1, "activeTime": 180, "scrollCoverage": 0.8,
        }, {
            "page": 3, "activeTime": 120, "scrollCoverage": 0.7,
        }]),
        interaction_summary_json="{}", reading_depth="Reading",
        reading_score=62.5, reading_confidence=58.0,
        verified_pages_count=2, total_pages=10,
    )

    events = test_client.get("/api/library/timeline").json()["events"]
    read_events = [
        event for event in events
        if event["type"] == "read" and event["doc_id"] == "doc-analytics"
    ]
    assert len(read_events) == 1
    assert read_events[0]["verified_pages"] == 2
    assert read_events[0]["verified_page_numbers"] == [1, 3]
    assert read_events[0]["start_page"] == 1
    assert read_events[0]["end_page"] == 3
    assert read_events[0]["reading_score"] == 62.5
    assert read_events[0]["reading_confidence"] == 58.0
    assert read_events[0]["reading_depth"] == "Reading"
    assert read_events[0]["reading_activity"] == "read"
    assert read_events[0]["minimum_evidence_time"] == 90.0


def test_timeline_skips_accidental_short_open(test_client, isolated_dirs):
    db = isolated_dirs["db"]
    _create_doc_owned_by(isolated_dirs, "doc-short-open", "testuser")
    common = {
        "username": "testuser", "paper_id": "doc-short-open",
        "started_at": "2026-02-02T10:00:00+00:00", "ended_at": None,
        "version": 1, "page_sessions_json": json.dumps([{"page": 1}]),
        "interaction_summary_json": "{}", "reading_depth": "Opened",
        "reading_score": 0.0, "reading_confidence": 0.0,
        "verified_pages_count": 0, "total_pages": 10,
    }
    db.db_save_reading_session(
        session_id="short-open", active_reading_time=29, **common,
    )

    events = test_client.get("/api/library/timeline").json()["events"]
    assert not any(event.get("reading_session_id") == "short-open" for event in events)


def test_timeline_keeps_long_session_with_zero_verified_pages(test_client, isolated_dirs):
    db = isolated_dirs["db"]
    _create_doc_owned_by(isolated_dirs, "doc-long-browse", "testuser")
    db.db_save_reading_session(
        session_id="long-browse", username="testuser", paper_id="doc-long-browse",
        started_at="2026-02-02T10:00:00+00:00", ended_at=None,
        active_reading_time=30, version=1,
        page_sessions_json=json.dumps([{"page": 1}]),
        interaction_summary_json="{}", reading_depth="Browsing",
        reading_score=5.0, reading_confidence=10.0,
        verified_pages_count=0, total_pages=10,
    )

    events = test_client.get("/api/library/timeline").json()["events"]
    event = next(item for item in events if item.get("reading_session_id") == "long-browse")
    assert event["type"] == "browsed"
    assert event["verified_pages"] == 0
    assert event["duration_seconds"] == 30


def test_timeline_uses_persisted_reading_activity(test_client, isolated_dirs):
    db = isolated_dirs["db"]
    _create_doc_owned_by(isolated_dirs, "doc-stable-browse", "testuser")
    db.db_save_reading_session(
        session_id="stable-browse", username="testuser", paper_id="doc-stable-browse",
        started_at="2026-02-02T10:00:00+00:00", ended_at=None,
        active_reading_time=300, version=1,
        page_sessions_json=json.dumps([{
            "page": 1, "activeTime": 300, "scrollCoverage": 0.8,
        }]),
        interaction_summary_json="{}", reading_depth="Reading",
        reading_score=60.0, reading_confidence=80.0,
        verified_pages_count=1, total_pages=10,
        reading_activity="browsed", minimum_evidence_time=75.0,
    )

    events = test_client.get("/api/library/timeline").json()["events"]
    event = next(item for item in events if item.get("reading_session_id") == "stable-browse")
    assert event["type"] == "browsed"
    assert event["minimum_evidence_time"] == 75.0


def test_timeline_ignores_malformed_memo_ids(test_client, isolated_dirs):
    db = isolated_dirs["db"]
    _create_doc_owned_by(isolated_dirs, "doc-tl-2", "testuser", {"title": "Bad Memo Id"})
    db.db_put_memos("doc-tl-2", {"page_1": [{"id": "not-a-timestamp-id", "content": "무시되어야 함"}]})

    res = test_client.get("/api/library/timeline")
    assert res.status_code == 200
    events = res.json()["events"]
    assert not any(e.get("summary") == "무시되어야 함" for e in events)


def test_timeline_excludes_other_users_events(test_client, isolated_dirs):
    db = isolated_dirs["db"]
    _create_doc_owned_by(isolated_dirs, "doc-tl-other", "otheruser", {"title": "Not Mine"})

    res = test_client.get("/api/library/timeline")
    assert res.status_code == 200
    events = res.json()["events"]
    assert not any(e["doc_id"] == "doc-tl-other" for e in events)


def test_timeline_read_session_identical_start_end_timestamp(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-tl-same-ts", "testuser", {
        "title": "Same Timestamp Paper",
        "read_sessions": [
            {
                "timestamp": "2026-02-02T10:00:00+00:00",
                "end_timestamp": "2026-02-02T10:00:00+00:00",
                "duration_seconds": 0,
            }
        ]
    })
    res = test_client.get("/api/library/timeline")
    assert res.status_code == 200
    events = res.json()["events"]
    read_events = [e for e in events if e.get("doc_id") == "doc-tl-same-ts" and e["type"] == "read"]
    assert len(read_events) == 1
    assert read_events[0]["end_timestamp"] is None


def test_metadata_put_accumulates_read_sessions(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-tl-accum", "testuser", {
        "title": "Accumulation Paper",
        "read_sessions": [
            {"timestamp": "2026-02-02T10:00:00+00:00", "end_timestamp": "2026-02-02T10:05:00+00:00", "duration_seconds": 300}
        ]
    })
    new_payload = {
        "read_sessions": [
            {"timestamp": "2026-02-02T11:00:00+00:00", "end_timestamp": "2026-02-02T11:05:00+00:00", "duration_seconds": 300}
        ]
    }
    res = test_client.put("/api/library/doc-tl-accum/metadata", json=new_payload)
    assert res.status_code == 200
    updated_meta = res.json()["metadata"]
    assert len(updated_meta["read_sessions"]) == 2


def test_metadata_put_updates_same_timestamp_session(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-tl-update-same", "testuser", {
        "title": "Same Session Update Paper",
        "read_sessions": [
            {"timestamp": "2026-02-02T10:00:00+00:00", "end_timestamp": "2026-02-02T10:00:20+00:00", "duration_seconds": 20}
        ]
    })
    # 20초 후 하트비트가 동일 세션(시작 시각 동일)의 연장 정보를 보냄
    new_payload = {
        "read_sessions": [
            {"timestamp": "2026-02-02T10:00:00+00:00", "end_timestamp": "2026-02-02T10:00:40+00:00", "duration_seconds": 40}
        ]
    }
    res = test_client.put("/api/library/doc-tl-update-same/metadata", json=new_payload)
    assert res.status_code == 200
    updated_meta = res.json()["metadata"]
    assert len(updated_meta["read_sessions"]) == 1
    assert updated_meta["read_sessions"][0]["end_timestamp"] == "2026-02-02T10:00:40+00:00"
    assert updated_meta["read_sessions"][0]["duration_seconds"] == 40


def test_metadata_put_merges_consecutive_sessions_within_2min(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-tl-merge-consec", "testuser", {
        "title": "Consecutive Merge Paper",
        "read_sessions": [
            {"timestamp": "2026-02-02T10:00:00+00:00", "end_timestamp": "2026-02-02T10:05:00+00:00", "duration_seconds": 300, "verified_pages": 2}
        ]
    })
    # 직전 종료시각(10:05:00) 후 1분 뒤(10:06:00) 세션 전송 -> 하나의 연속 세션으로 병합되어야 함
    new_payload = {
        "read_sessions": [
            {"timestamp": "2026-02-02T10:06:00+00:00", "end_timestamp": "2026-02-02T10:10:00+00:00", "duration_seconds": 240, "verified_pages": 1}
        ]
    }
    res = test_client.put("/api/library/doc-tl-merge-consec/metadata", json=new_payload)
    assert res.status_code == 200
    updated_meta = res.json()["metadata"]
    assert len(updated_meta["read_sessions"]) == 1
    assert updated_meta["read_sessions"][0]["end_timestamp"] == "2026-02-02T10:10:00+00:00"
    assert updated_meta["read_sessions"][0]["duration_seconds"] == 600




# ── Reading Recommendation ───────────────────────────────────────────────

@pytest.mark.asyncio
async def test_reading_recommendations_skips_when_too_few_docs(isolated_dirs):
    import services.knowledge_graph as knowledge_graph
    _create_doc_owned_by(isolated_dirs, "doc-rec-only-one", "testuser", {"title": "Only One Paper"})
    result = await knowledge_graph.get_reading_recommendations("testuser")
    assert result == []


@pytest.mark.asyncio
async def test_reading_recommendations_filters_implausible_and_duplicate(isolated_dirs, monkeypatch):
    import services.llm_client as llm_client
    import services.reference_linker as reference_linker
    import services.knowledge_graph as knowledge_graph

    _create_doc_owned_by(isolated_dirs, "doc-rec-1", "testuser", {"title": "Vision Transformer", "categories": ["CV"]})
    _create_doc_owned_by(isolated_dirs, "doc-rec-2", "testuser", {"title": "Masked Autoencoders", "categories": ["CV"]})

    async def fake_generate(titles, categories, session_id=None):
        assert "Vision Transformer" in titles
        return [
            {"title": "DINO Self-Supervised Vision Transformers", "reason": "자기지도학습 확장"},
            {"title": "Hallucinated Nonexistent Paper", "reason": "가짜 추천"},
            {"title": "Vision Transformer", "reason": "이미 읽은 논문과 동일"},
        ]

    async def fake_resolve(query_text):
        if query_text == "DINO Self-Supervised Vision Transformers":
            return {"title": "DINO Self-Supervised Vision Transformers", "url": "https://example.com/dino", "year": 2021}
        if query_text == "Vision Transformer":
            return {"title": "Vision Transformer", "url": "https://example.com/vit", "year": 2020}
        return None  # OpenAlex에 없는(존재하지 않는) 논문 - 환각으로 취급

    monkeypatch.setattr(llm_client, "generate_reading_recommendations", fake_generate)
    monkeypatch.setattr(reference_linker, "resolve_reference", fake_resolve)

    results = await knowledge_graph.get_reading_recommendations("testuser")

    titles = [r["title"] for r in results]
    assert "DINO Self-Supervised Vision Transformers" in titles
    assert "Hallucinated Nonexistent Paper" not in titles  # OpenAlex 검증 실패
    assert "Vision Transformer" not in titles  # 이미 읽은 논문과 중복
    assert any(r["reason"] == "자기지도학습 확장" for r in results)


@pytest.mark.asyncio
async def test_reading_recommendations_resolve_references_with_bounded_concurrency(
    isolated_dirs, monkeypatch
):
    import asyncio
    import services.llm_client as llm_client
    import services.reference_linker as reference_linker
    import services.knowledge_graph as knowledge_graph

    _create_doc_owned_by(isolated_dirs, "doc-rec-concurrent-1", "testuser", {"title": "Read One"})
    _create_doc_owned_by(isolated_dirs, "doc-rec-concurrent-2", "testuser", {"title": "Read Two"})
    recommendation_count = knowledge_graph.OPENALEX_RECOMMENDATION_CONCURRENCY + 3

    async def fake_generate(titles, categories, session_id=None):
        return [
            {"title": f"Recommended Paper {index}", "reason": f"reason {index}"}
            for index in range(recommendation_count)
        ]

    active = 0
    max_active = 0

    async def fake_resolve(query_text):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.01)
        active -= 1
        return {"title": query_text, "url": f"https://example.com/{query_text}"}

    monkeypatch.setattr(llm_client, "generate_reading_recommendations", fake_generate)
    monkeypatch.setattr(reference_linker, "resolve_reference", fake_resolve)

    results = await knowledge_graph.get_reading_recommendations("testuser")

    assert max_active == knowledge_graph.OPENALEX_RECOMMENDATION_CONCURRENCY
    assert [result["title"] for result in results] == [
        f"Recommended Paper {index}" for index in range(recommendation_count)
    ]


def test_reading_recommendations_endpoint(test_client, isolated_dirs, monkeypatch):
    import services.llm_client as llm_client
    import services.reference_linker as reference_linker

    _create_doc_owned_by(isolated_dirs, "doc-rec-api-1", "testuser", {"title": "Vision Transformer"})
    _create_doc_owned_by(isolated_dirs, "doc-rec-api-2", "testuser", {"title": "Masked Autoencoders"})

    async def fake_generate(titles, categories, session_id=None):
        return [{"title": "DINO Self-Supervised Vision Transformers", "reason": "다음 단계"}]

    async def fake_resolve(query_text):
        return {"title": "DINO Self-Supervised Vision Transformers", "url": "https://example.com/dino", "year": 2021}

    monkeypatch.setattr(llm_client, "generate_reading_recommendations", fake_generate)
    monkeypatch.setattr(reference_linker, "resolve_reference", fake_resolve)

    res = test_client.get("/api/library/graph/recommendations")
    assert res.status_code == 200
    recs = res.json()["recommendations"]
    assert any(r["title"] == "DINO Self-Supervised Vision Transformers" and r["reason"] == "다음 단계" for r in recs)


@pytest.mark.asyncio
async def test_reading_recommendations_force_bypasses_cache(isolated_dirs, monkeypatch):
    """대시보드 "다시 받기" 버튼이 쓰는 force=True는 유효한 캐시가 있어도
    무시하고 새로 생성해야 한다."""
    import services.llm_client as llm_client
    import services.reference_linker as reference_linker
    import services.knowledge_graph as knowledge_graph

    _create_doc_owned_by(isolated_dirs, "doc-rec-force-1", "testuser", {"title": "Vision Transformer"})
    _create_doc_owned_by(isolated_dirs, "doc-rec-force-2", "testuser", {"title": "Masked Autoencoders"})

    call_count = {"n": 0}

    async def fake_generate(titles, categories, session_id=None):
        call_count["n"] += 1
        return [{"title": f"Paper Round {call_count['n']}", "reason": "이유"}]

    async def fake_resolve(query_text):
        return {"title": query_text, "url": "https://example.com/x", "year": 2024}

    monkeypatch.setattr(llm_client, "generate_reading_recommendations", fake_generate)
    monkeypatch.setattr(reference_linker, "resolve_reference", fake_resolve)

    first = await knowledge_graph.get_reading_recommendations("testuser")
    assert call_count["n"] == 1
    cached_again = await knowledge_graph.get_reading_recommendations("testuser")
    assert call_count["n"] == 1  # 캐시가 있으면 재호출하지 않는다
    assert cached_again == first

    forced = await knowledge_graph.get_reading_recommendations("testuser", force=True)
    assert call_count["n"] == 2  # force=True는 캐시를 무시하고 재생성한다
    assert forced != first


def test_reading_recommendations_endpoint_force_query_param(test_client, isolated_dirs, monkeypatch):
    import services.llm_client as llm_client
    import services.reference_linker as reference_linker
    import services.knowledge_graph as knowledge_graph

    _create_doc_owned_by(isolated_dirs, "doc-rec-force-api-1", "testuser", {"title": "Vision Transformer"})
    _create_doc_owned_by(isolated_dirs, "doc-rec-force-api-2", "testuser", {"title": "Masked Autoencoders"})

    call_count = {"n": 0}

    async def fake_generate(titles, categories, session_id=None):
        call_count["n"] += 1
        return [{"title": f"Paper Round {call_count['n']}", "reason": "이유"}]

    async def fake_resolve(query_text):
        return {"title": query_text, "url": "https://example.com/x", "year": 2024}

    monkeypatch.setattr(llm_client, "generate_reading_recommendations", fake_generate)
    monkeypatch.setattr(reference_linker, "resolve_reference", fake_resolve)

    test_client.get("/api/library/graph/recommendations")
    assert call_count["n"] == 1
    res = test_client.get("/api/library/graph/recommendations?force=true")
    assert res.status_code == 200
    assert call_count["n"] == 2
