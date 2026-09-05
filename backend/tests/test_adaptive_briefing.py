import pytest

from services.briefing_policy import (
    MAX_LONG_DOCUMENT_CHARS,
    MAX_LONG_DOCUMENT_SEGMENTS,
    QUALITY_REQUIRED_SECTIONS,
    SECTION_POLICIES,
    briefing_quality_issues,
    build_chapter_guided_excerpts,
    normalize_briefing,
    section_policy,
    select_briefing_excerpts,
)


EXPECTED_TYPES = {
    "research_paper", "review_survey", "thesis", "preprint", "academic_report",
    "technical", "academic_book", "general_book", "literary_work", "article",
    "report", "manual", "legal_policy", "presentation", "other",
}


def _pages(count: int) -> list[dict]:
    return [{"page_num": index + 1, "text": f"page {index + 1}\n" + "evidence " * 500} for index in range(count)]


def test_all_15_active_types_have_distinct_section_policies():
    assert set(SECTION_POLICIES) == EXPECTED_TYPES
    for document_type in EXPECTED_TYPES:
        sections = section_policy(document_type)
        assert sections
        assert len({section.id for section in sections}) == len(sections)


def test_49_and_50_page_boundary_uses_short_and_long_policies():
    _, short_policy, _ = select_briefing_excerpts(_pages(49), "manual")
    text, long_policy, sampled_pages = select_briefing_excerpts(_pages(50), "manual")
    assert short_policy == "short"
    assert long_policy == "long"
    assert len(text) <= MAX_LONG_DOCUMENT_CHARS
    assert len(sampled_pages) <= MAX_LONG_DOCUMENT_SEGMENTS
    assert sampled_pages[0] == 1
    assert sampled_pages[-1] == 50


def test_long_document_prioritizes_detected_table_of_contents():
    pages = _pages(60)
    pages[1]["text"] = "TABLE OF CONTENTS\n1. Start\n2. Method"
    _, _, sampled_pages = select_briefing_excerpts(pages, "general_book")
    assert 2 in sampled_pages
    assert sampled_pages[0] == 1
    assert sampled_pages[-1] == 60


def test_long_research_document_keeps_research_sections():
    value = normalize_briefing(
        {"headline": "Research", "sections": [{
            "id": "experiment_flow", "title": "wrong", "kind": "triples",
            "items": [{"hypothesis": "h", "method": "m", "result": "r"}],
        }]},
        "research", "research_paper", "long",
    )
    assert value["document_mode"] == "research"
    assert value["document_type"] == "research_paper"
    assert value["sections"][0]["title"] == "wrong"
    assert value["sections"][0]["kind"] == "triples"


def test_unknown_or_cross_type_sections_are_dropped():
    value = normalize_briefing(
        {"sections": [{"id": "experiment_flow", "content": "wrong frame"}]},
        "general", "literary_work", "short",
    )
    assert value["sections"] == []



def test_short_manual_prioritizes_type_specific_heading_pages():
    pages = [{"page_num": page, "text": f"ordinary page {page}"} for page in range(1, 21)]
    pages[9]["text"] = "WARNING: disconnect power\nImportant safety details"
    text, policy, sampled = select_briefing_excerpts(pages, "manual")
    assert policy == "short"
    assert 10 in sampled
    assert "Important safety details" in text
    assert len(text) <= MAX_LONG_DOCUMENT_CHARS


def test_policy_kind_cannot_be_changed_by_model():
    value = normalize_briefing({"sections": [{
        "id": "definitions", "title": "Definitions", "kind": "prose", "items": [{"term": "A"}],
    }]}, "general", "legal_policy", "short")
    assert value["sections"][0]["kind"] == "glossary"
    assert value["sections"][0]["title"] == "Definitions"


def test_all_type_contracts_keep_only_their_policy_sections():
    research_types = {"research_paper", "review_survey", "thesis", "preprint", "academic_report"}
    for document_type in EXPECTED_TYPES:
        section = section_policy(document_type)[0]
        value = normalize_briefing({"sections": [{
            "id": section.id, "title": "Localized", "kind": "prose", "content": "evidence",
        }]}, "research" if document_type in research_types else "general", document_type, "short")
        assert value["sections"] == [{
            "id": section.id, "title": "Localized", "kind": section.kind, "content": "evidence", "items": [],
        }]


def test_all_15_types_define_cache_quality_anchors():
    assert set(QUALITY_REQUIRED_SECTIONS) == EXPECTED_TYPES
    for document_type, required in QUALITY_REQUIRED_SECTIONS.items():
        assert required
        assert set(required) <= {section.id for section in section_policy(document_type)}
        value = normalize_briefing({
            "headline": f"Complete orientation for {document_type}",
            "sections": [
                {"id": section_id, "title": section_id, "items": ["grounded overview"]}
                for section_id in required
            ] + ([{
                "id": next(section.id for section in section_policy(document_type) if section.id not in required),
                "title": "supporting", "items": ["supporting evidence"],
            }] if len(required) < 2 else []),
        }, "research" if document_type in {
            "research_paper", "review_survey", "thesis", "preprint", "academic_report",
        } else "general", document_type, "short")
        assert briefing_quality_issues(value, document_type) == []


def test_quality_gate_rejects_structurally_valid_but_thin_output():
    value = normalize_briefing({
        "headline": "Manual overview",
        "sections": [{"id": "steps", "title": "Steps", "items": ["Run it"]}],
    }, "general", "manual", "short")
    assert "briefing needs at least 2 evidence-backed sections" in briefing_quality_issues(value, "manual")


def test_chapter_guided_book_input_covers_every_confirmed_chapter():
    pages = [
        {"page_num": page, "text": f"Opening evidence for page {page}. " * 100}
        for page in range(1, 13)
    ]
    chapters = [
        {"title": "Foundations", "start_page": 1, "end_page": 3},
        {"title": "Transport", "start_page": 4, "end_page": 7},
        {"title": "Networks", "start_page": 8, "end_page": 12},
    ]
    text = build_chapter_guided_excerpts(pages, chapters)
    assert len(text) <= MAX_LONG_DOCUMENT_CHARS
    for chapter in chapters:
        assert f"{chapter['title']} (pages {chapter['start_page']}-{chapter['end_page']})" in text
        assert f"[CHAPTER OPENING: {chapter['title']}" in text


def test_academic_book_quality_requires_one_item_per_confirmed_chapter():
    chapters = [
        {"title": "Foundations", "start_page": 1, "end_page": 3},
        {"title": "Transport", "start_page": 4, "end_page": 7},
    ]
    value = normalize_briefing({
        "headline": "A complete networking textbook orientation",
        "sections": [
            {"id": "book_identity", "content": "A networking textbook."},
            {"id": "learning_map", "content": "Moves from applications to links."},
            {"id": "chapter_roadmap", "items": [
                {"title": "Foundations", "pages": "1-3", "focus": "Core models"},
            ]},
        ],
    }, "general", "academic_book", "long")
    issues = briefing_quality_issues(value, "academic_book", chapters)
    assert any("exactly 2 items" in issue for issue in issues)
    assert any("Transport" in issue for issue in issues)


@pytest.mark.asyncio
async def test_generation_repairs_quality_failure_once(monkeypatch):
    from services.adaptive_briefing import generate_adaptive_briefing
    responses = [
        [{"headline": "Too thin", "sections": [{"id": "steps", "items": ["Run"]}]}],
        [{"headline": "Complete setup manual overview", "sections": [
            {"id": "prerequisites", "items": ["Administrator access"]},
            {"id": "steps", "items": ["Install", "Verify"]},
        ]}],
    ]
    prompts = []

    async def fake_llm(prompt, **_kwargs):
        prompts.append(prompt)
        return responses.pop(0)

    monkeypatch.setattr("services.llm_client._llm_json_array_with_retry", fake_llm)
    result = await generate_adaptive_briefing(
        "Setup", "source", "general", "manual", "short",
    )
    assert len(prompts) == 2
    assert "quality gate" in prompts[1]
    assert {section["id"] for section in result["sections"]} >= {"prerequisites", "steps"}


@pytest.mark.asyncio
async def test_academic_book_generation_reuses_real_pdf_toc(isolated_dirs, tmp_path, monkeypatch):
    import fitz
    from services import primer

    pdf_path = tmp_path / "book.pdf"
    pdf = fitz.open()
    for page_num in range(1, 5):
        page = pdf.new_page()
        page.insert_text((50, 80), f"Opening material for page {page_num}")
    pdf.set_toc([[1, "Foundations", 1], [1, "Transport", 3]])
    pdf.save(pdf_path)
    pdf.close()
    isolated_dirs["db"].db_save_document(
        "book-1", "testuser", "book.pdf", str(pdf_path), 4,
        {"title": "Networking"}, document_mode="general", document_type="academic_book",
    )
    pages = [
        {"page_num": page, "text": f"Opening material for page {page}"}
        for page in range(1, 5)
    ]
    captured = {}

    async def fake_generate(title, source_text, mode, document_type, length_policy, **kwargs):
        captured.update(source_text=source_text, chapters=kwargs["chapters"])
        return {
            "schema_version": 3, "document_mode": mode, "document_type": document_type,
            "length_policy": length_policy, "headline": "Networking book orientation",
            "sections": [], "suggested_questions": [],
        }

    monkeypatch.setattr("services.adaptive_briefing.generate_adaptive_briefing", fake_generate)
    monkeypatch.setattr("services.library.get_pdf_path", lambda _doc_id: str(pdf_path))
    await primer.generate_adaptive_document_briefing(
        "book-1", pages, {"title": "Networking"}, "general", "academic_book",
    )
    assert [chapter["title"] for chapter in captured["chapters"]] == ["Foundations", "Transport"]
    assert "Foundations (pages 1-2)" in captured["source_text"]
    assert "Transport (pages 3-4)" in captured["source_text"]
