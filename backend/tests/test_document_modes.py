import json

import pytest

from services.document_policy import (
    build_assistant_prompt,
    registry_payload,
    translation_cache_candidates,
    translation_cache_suffix,
    validate_classification,
)
from services.vocabulary import validate_vocabulary_result


def test_registry_has_all_research_and_general_types():
    payload = registry_payload()
    by_mode = {mode["value"]: mode for mode in payload["modes"]}
    assert {item["value"] for item in by_mode["research"]["types"]} == {
        "research_paper", "review_survey", "thesis", "preprint", "academic_report",
    }
    assert {item["value"] for item in by_mode["general"]["types"]} == {
        "technical", "book", "article", "report", "manual", "other",
    }
    assert by_mode["general"]["features"]["research_graph"] is False


def test_mode_type_validation_rejects_cross_mode_type():
    with pytest.raises(ValueError):
        validate_classification("general", "research_paper")
    with pytest.raises(ValueError):
        validate_classification("research", "manual")


def test_cache_suffix_separates_mode_type_and_prompt_version():
    research = translation_cache_suffix(
        "research", "research_paper", "한국어", "academic", False, True, False,
    )
    manual = translation_cache_suffix(
        "general", "manual", "한국어", "academic", False, True, False,
    )
    assert research != manual
    assert "document-modes-v1" in research


def test_assistant_prompt_treats_document_as_untrusted_and_requires_pages():
    prompt = build_assistant_prompt("general", "technical", "API Guide", "--- Page 2 ---\ntext")
    assert "untrusted" in prompt.lower()
    assert "[p.N]" in prompt
    assert "technical documentation guide" in prompt


def test_existing_documents_migrate_to_research_defaults(isolated_dirs):
    db = isolated_dirs["db"]
    db.db_save_document("legacy", "admin", "paper.pdf", "/x", 1, {})
    doc = db.db_get_document("legacy")
    assert doc["document_mode"] == "research"
    assert doc["document_type"] == "research_paper"
    assert doc["mode_schema_version"] == 1


def test_document_list_filters_by_mode(isolated_dirs):
    db = isolated_dirs["db"]
    db.db_save_document("r", "admin", "r.pdf", "/x", 1, {})
    db.db_save_document("g", "admin", "g.pdf", "/x", 1, {}, "general", "manual")
    assert [doc["id"] for doc in db.db_list_documents("admin", document_mode="general")] == ["g"]


def test_workspace_settings_round_trip(isolated_dirs):
    db = isolated_dirs["db"]
    saved = db.db_upsert_workspace_settings(
        "admin", 1, "general", {"manual": {"ignore_table": False}},
    )
    assert saved["preferred_workspace_mode"] == "general"
    assert saved["document_type_options"]["manual"]["ignore_table"] is False


def test_workspace_and_document_type_endpoints(test_client):
    registry = test_client.get("/api/document-types")
    assert registry.status_code == 200
    assert len(registry.json()["modes"]) == 2

    response = test_client.patch(
        "/api/settings/workspace",
        json={"onboarding_version": 1, "preferred_workspace_mode": "general"},
    )
    assert response.status_code == 200
    assert response.json()["preferred_workspace_mode"] == "general"
    assert test_client.patch(
        "/api/settings/workspace", json={"preferred_workspace_mode": "invalid"},
    ).status_code == 400


def test_classification_endpoint_validates_and_invalidates(isolated_dirs, test_client):
    db = isolated_dirs["db"]
    db.db_save_document("doc", "testuser", "paper.pdf", "/x", 1, {})
    db.db_save_translation("doc", 1, "cached", "legacy")
    db.db_save_page_insight("doc", 1, "keywords", "cached", "legacy")

    invalid = test_client.patch(
        "/api/library/doc/classification",
        json={"document_mode": "general", "document_type": "research_paper"},
    )
    assert invalid.status_code == 400

    blocked = test_client.patch(
        "/api/library/doc/classification",
        json={"document_mode": "general", "document_type": "technical"},
    )
    assert blocked.status_code == 409
    assert db.db_get_translation("doc", 1, "legacy", fallback=False) == "cached"
    assert db.db_get_page_insight("doc", 1, "keywords", "legacy") == "cached"

    db.db_save_document("fresh", "testuser", "manual.pdf", "/x", 1, {})
    changed = test_client.patch(
        "/api/library/fresh/classification",
        json={"document_mode": "general", "document_type": "manual"},
    )
    assert changed.status_code == 200
    assert changed.json()["document_type"] == "manual"


def test_vocabulary_validation_drops_hallucinations_and_dedupes_lemmas():
    text = "Ubiquitous systems make APIs interoperable. Ubiquitous tools help."
    raw = json.dumps({
        "advanced_words": [
            {"term": "Ubiquitous", "lemma": "ubiquitous", "level": "GRE", "occurrence": 2, "meaning": "어디에나 있는"},
            {"term": "Ubiquitous", "lemma": "ubiquitous", "level": "SAT", "occurrence": 1, "meaning": "편재하는"},
            {"term": "invented", "lemma": "invent", "level": "GRE", "meaning": "발명된"},
        ],
        "technical_terms": [{"term": "APIs", "lemma": "API", "meaning": "응용 프로그래밍 인터페이스"}],
    })
    result = validate_vocabulary_result(raw, text, 7)
    assert len(result["advanced_words"]) == 1
    word = result["advanced_words"][0]
    assert word["occurrence"] == 2
    assert text[word["char_start"]:word["char_end"]] == "Ubiquitous"
    assert result["technical_terms"][0]["page_num"] == 7


def test_research_cache_candidates_include_legacy_key_only_for_legacy_classification():
    research = translation_cache_candidates(
        "research", "research_paper", "한국어", "academic", False, True, False,
    )
    general = translation_cache_candidates(
        "general", "manual", "한국어", "academic", False, True, False,
    )
    assert len(research) == 2
    assert research[1] == "한국어_academic_math0_table1_refs0"
    assert len(general) == 1


def test_chat_sessions_filter_by_document_mode(isolated_dirs):
    db = isolated_dirs["db"]
    db.db_save_document("r-chat", "admin", "r.pdf", "/x", 1, {})
    db.db_save_document("g-chat", "admin", "g.pdf", "/x", 1, {}, "general", "manual")
    db.db_save_chat_message("r-chat", "user", "research")
    db.db_save_chat_message("g-chat", "user", "general")
    sessions = db.db_list_assistant_chat_sessions("admin", document_mode="general")
    assert [session["doc_id"] for session in sessions] == ["g-chat"]
    assert sessions[0]["document_type"] == "manual"


def test_non_english_page_does_not_emit_advanced_english_words():
    raw = json.dumps({
        "advanced_words": [{"term": "Ubiquitous", "lemma": "ubiquitous", "level": "GRE", "meaning": "편재하는"}],
        "technical_terms": [],
    })
    result = validate_vocabulary_result(raw, "한글로만 작성된 짧은 문서입니다.", 1)
    assert result["advanced_words"] == []
    assert "영어 원문" in result["advanced_words_notice"]


@pytest.mark.asyncio
async def test_general_document_overview_is_lazy_structured_and_cacheable(monkeypatch):
    import services.primer as primer
    saved = {}

    async def fake_stream(kind, *args, **kwargs):
        assert kind == "overview"
        assert kwargs["document_mode"] == "general"
        assert kwargs["document_type"] == "manual"
        yield json.dumps({
            "purpose": "설치 전에 요구사항을 확인하고 순서대로 진행하도록 안내",
            "audience": "운영 담당자",
            "structure": ["설치", "설정"],
            "key_points": ["요구사항 확인", "순서 준수"],
            "prerequisites": ["관리자 권한"],
            "warnings": ["설정 파일을 먼저 백업"],
            "metrics": [],
            "glossary": [{"term": "bootstrap", "definition": "초기 설정"}],
        }, ensure_ascii=False)

    def fake_save(doc_id, page_num, kind, content, suffix=""):
        saved.update(doc_id=doc_id, page_num=page_num, kind=kind, content=content, suffix=suffix)

    monkeypatch.setattr(primer, "stream_page_insight", fake_stream)
    monkeypatch.setattr(primer, "save_page_insight", fake_save)
    result = await primer.generate_document_overview(
        "manual-1", [{"page_num": 1, "text": "Install the package after checking requirements."}],
        {"title": "Setup"}, "manual", session_id="manual-1",
    )
    assert result["document_overview"] is True
    assert "요구사항" in result["hook"]
    assert "설치" in result["lineage"]
    assert "요구사항" in result["feynman"]
    assert result["glossary"][0]["term"] == "bootstrap"
    assert saved["kind"] == "document_overview_v2"
    assert saved["suffix"].endswith(":manual")


def test_reading_time_stats_filter_by_document_mode(isolated_dirs):
    db = isolated_dirs["db"]
    db.db_save_document("r-time", "admin", "r.pdf", "/x", 1, {})
    db.db_save_document("g-time", "admin", "g.pdf", "/x", 1, {}, "general", "book")
    db.db_add_reading_time("r-time", "admin", "reading", 10)
    db.db_add_reading_time("g-time", "admin", "reading", 25)
    stats = db.db_get_reading_time_stats("admin", document_mode="general")
    assert stats["total_seconds"] == 25
    assert stats["total_seconds_by_doc"] == {"g-time": 25}


@pytest.mark.asyncio
async def test_general_translation_job_skips_research_postprocessing(monkeypatch):
    import services.translation_job as translation_job

    called = {"paper_tags": False, "graph": False}

    async def fake_paper_tags(*args, **kwargs):
        called["paper_tags"] = True

    async def fake_graph(*args, **kwargs):
        called["graph"] = True

    import services.paper_tags as paper_tags
    import services.knowledge_graph as knowledge_graph
    monkeypatch.setattr(paper_tags, "classify_and_store_paper_tags", fake_paper_tags)
    monkeypatch.setattr(knowledge_graph, "sync_document_for_graph", fake_graph)
    monkeypatch.setattr(translation_job, "get_document", lambda _doc_id: {
        "filename": "manual.pdf", "metadata": {},
        "document_mode": "general", "document_type": "manual",
    })
    monkeypatch.setattr(translation_job, "get_trans_provider", lambda: "ollama")
    monkeypatch.setattr(translation_job, "_save_job", lambda *args, **kwargs: None)
    monkeypatch.setattr(translation_job, "_build_full_md", lambda *args, **kwargs: None)

    job = {
        "status": "running", "options": {},
        "completed_pages": [], "failed_pages": [],
    }
    await translation_job._run_job("general-job", [], job)

    assert job["status"] == "completed"
    assert called == {"paper_tags": False, "graph": False}


def test_job_page_cache_fallback_is_legacy_research_only(isolated_dirs, test_client, monkeypatch):
    from routers.upload import sessions

    db = isolated_dirs["db"]
    legacy_suffix = "한국어_academic_math0_table1_refs0"
    db.db_save_document("legacy-research", "testuser", "paper.pdf", "/x", 1, {})
    db.db_save_document("general-cache", "testuser", "manual.pdf", "/x", 1, {}, "general", "manual")
    db.db_save_translation("legacy-research", 1, "old research", legacy_suffix)
    db.db_save_translation("general-cache", 1, "wrong policy", legacy_suffix)
    monkeypatch.setitem(sessions, "legacy-research", {
        "username": "testuser", "pages": [{"page_num": 1, "text": "x"}],
        "total_pages": 1, "metadata": {}, "filename": "paper.pdf",
        "document_mode": "research", "document_type": "research_paper", "pdf_path": "/x",
    })
    monkeypatch.setitem(sessions, "general-cache", {
        "username": "testuser", "pages": [{"page_num": 1, "text": "x"}],
        "total_pages": 1, "metadata": {}, "filename": "manual.pdf",
        "document_mode": "general", "document_type": "manual", "pdf_path": "/x",
    })

    research = test_client.get("/api/jobs/legacy-research/page/1")
    general = test_client.get("/api/jobs/general-cache/page/1")
    assert research.status_code == 200
    assert research.json()["translation"] == "old research"
    assert general.status_code == 404


@pytest.mark.asyncio
async def test_background_job_promotes_legacy_research_cache_without_retranslation(isolated_dirs, monkeypatch):
    import services.translation_job as translation_job
    import services.paper_tags as paper_tags
    import services.knowledge_graph as knowledge_graph

    db = isolated_dirs["db"]
    db.db_save_document("legacy-job", "admin", "paper.pdf", "/x", 1, {})
    legacy_suffix = "한국어_academic_math0_table1_refs0"
    db.db_save_translation("legacy-job", 1, json.dumps({
        "translation": "기존 번역", "sentences": [{"source": "old", "translated": "기존"}],
    }, ensure_ascii=False), legacy_suffix)

    translated = {"called": False}

    async def fail_if_translated(*args, **kwargs):
        translated["called"] = True
        raise AssertionError("legacy research cache should be reused")

    async def no_op(*args, **kwargs):
        return None

    monkeypatch.setattr(translation_job, "_translate_page", fail_if_translated)
    monkeypatch.setattr(translation_job, "_save_job", lambda *args, **kwargs: None)
    monkeypatch.setattr(translation_job, "_save_page_md", lambda *args, **kwargs: None)
    monkeypatch.setattr(translation_job, "_build_full_md", lambda *args, **kwargs: None)
    monkeypatch.setattr(translation_job, "get_trans_provider", lambda: "ollama")
    monkeypatch.setattr(paper_tags, "classify_and_store_paper_tags", no_op)
    monkeypatch.setattr(knowledge_graph, "sync_document_for_graph", no_op)

    job = {
        "status": "running", "options": {},
        "completed_pages": [], "failed_pages": [],
    }
    await translation_job._run_job(
        "legacy-job", [{"page_num": 1, "text": "old"}], job,
    )

    current_suffix = translation_cache_suffix(
        "research", "research_paper", "ko", "academic", False, True, False,
    )
    assert translated["called"] is False
    assert db.db_get_translation("legacy-job", 1, current_suffix, fallback=False)
    assert job["completed_pages"] == [1]



def test_fts_retrieval_finds_late_page_and_extends_section(isolated_dirs):
    from services.context_retrieval import index_document_chunks, retrieve_context
    pages = [
        {"page_num": 1, "text": "# Introduction\n\nGeneral setup and background."},
        {"page_num": 302, "text": "# Recovery Procedure\n\nRotate the recovery token before restarting.\n\nVerify the audit checksum after restart."},
    ]
    assert index_document_chunks("long-doc", pages) >= 2
    result = retrieve_context("long-doc", pages, "How do I verify the audit checksum?")
    assert 302 in result.evidence_pages
    assert "audit checksum" in result.text
    assert result.strategy.startswith("fts5")


def test_context_prioritizes_explicit_and_current_pages(isolated_dirs):
    from services.context_retrieval import retrieve_context
    pages = [{"page_num": n, "text": f"Section {n}\n\ncontent for page {n}"} for n in range(1, 8)]
    result = retrieve_context("priority-doc", pages, "페이지 6을 설명해줘", current_page=4)
    assert {4, 6}.issubset(result.evidence_pages)


def test_page_citation_validation_removes_unsupported_ranges():
    from services.context_retrieval import validate_page_citations
    answer, invalid = validate_page_citations("근거 [p.2], 과장 [pp.5-7]", {2, 5, 6})
    assert "[p.2]" in answer
    assert "[pp.5-7]" not in answer
    assert invalid == ["[pp.5-7]"]


def test_advanced_vocabulary_uses_versioned_local_candidates():
    raw = json.dumps({
        "advanced_words": [
            {"term": "Ubiquitous", "lemma": "ubiquitous", "level": "GRE", "meaning": "편재하는"},
            {"term": "Interoperable", "lemma": "interoperable", "level": "GRE", "meaning": "상호 운용 가능한"},
        ],
        "technical_terms": [],
    })
    result = validate_vocabulary_result(raw, "Ubiquitous but interoperable systems exist.", 3)
    assert [item["lemma"] for item in result["advanced_words"]] == ["ubiquitous"]
    assert result["candidate_filter_version"] == "easypaper-advanced-en-v1"
    assert result["candidate_filter_license"]


def test_registry_rollout_flags_follow_environment(monkeypatch):
    monkeypatch.setenv("EASYPAPER_GENERAL_DOCUMENT_MODE", "false")
    monkeypatch.setenv("EASYPAPER_DOCUMENT_FTS", "0")
    payload = registry_payload()
    assert payload["rollout"]["general_document_mode"] is False
    assert payload["rollout"]["document_fts"] is False


def test_insight_job_estimate_skips_empty_and_cached_pages(isolated_dirs):
    from services.document_policy import insight_cache_suffix
    from services.insight_job import estimate_insight_job
    pages = [
        {"page_num": 1, "text": "Ubiquitous systems."},
        {"page_num": 2, "text": ""},
        {"page_num": 3, "text": "Another technical page."},
    ]
    suffix = insight_cache_suffix("general", "technical", "한국어")
    isolated_dirs["library"].save_page_insight("estimate-doc", 1, "keywords", "{}", suffix)
    estimate = estimate_insight_job("estimate-doc", pages, "한국어", "keywords", "general", "technical")
    assert estimate["eligible_pages"] == 1
    assert estimate["cached_or_empty_pages"] == 2
    assert estimate["estimated_calls"] == 1



def test_long_vocabulary_job_requires_estimate_confirmation(isolated_dirs, test_client, monkeypatch):
    from routers import upload
    pages = [{"page_num": n, "text": f"Ubiquitous technical content {n}."} for n in range(1, 26)]
    isolated_dirs["db"].db_save_document(
        "long-vocab", "testuser", "manual.pdf", "/x", 25, {}, "general", "manual",
    )
    monkeypatch.setitem(upload.sessions, "long-vocab", {
        "pdf_path": "/x", "filename": "manual.pdf", "pages": pages,
        "total_pages": 25, "metadata": {}, "username": "testuser",
        "document_mode": "general", "document_type": "manual",
    })
    estimate = test_client.get("/api/insight-jobs/long-vocab/keywords/estimate")
    assert estimate.status_code == 200
    assert estimate.json()["estimated_calls"] == 25
    assert estimate.json()["requires_confirmation"] is True
    rejected = test_client.post(
        "/api/insight-jobs/long-vocab/keywords/start",
        json={"target_lang": "한국어", "confirmed": False},
    )
    assert rejected.status_code == 409
    assert rejected.json()["detail"]["estimated_calls"] == 25


def test_workspace_switch_metrics_expose_no_document_content(isolated_dirs, test_client):
    changed = test_client.patch("/api/settings/workspace", json={"preferred_workspace_mode": "general"})
    assert changed.status_code == 200
    response = test_client.get("/api/metrics/document-modes")
    assert response.status_code == 200
    metrics = response.json()["metrics"]
    assert any(item["event"] == "workspace_switch" and item["document_mode"] == "general" for item in metrics)
    assert all("content" not in item and "prompt" not in item for item in metrics)


def test_translation_integrity_rejects_missing_protected_literals():
    from services.translation_quality import TranslationIntegrityError, assert_translation_integrity
    source = "Run `npm install` at https://example.test and wait 30s."
    with pytest.raises(TranslationIntegrityError):
        assert_translation_integrity(source, "설치를 실행하고 기다리세요.")
