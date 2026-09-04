from services.briefing_policy import (
    MAX_LONG_DOCUMENT_CHARS,
    MAX_LONG_DOCUMENT_SEGMENTS,
    SECTION_POLICIES,
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
