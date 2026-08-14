import pytest

from services.paper_tags import (
    PAPER_TAG_SCHEMA_VERSION,
    build_paper_tag_prompt,
    extract_abstract_text,
    flatten_categories,
    needs_ai_reclassification,
    normalize_tag_items,
)


MUON_ABSTRACT = """Recently, the Muon optimizer based on matrix orthogonalization has
demonstrated strong results in training language models. We identify techniques
for scaling Muon and compare it with AdamW."""

META_HARNESS_ABSTRACT = """The performance of large language model systems depends on
their harness. Existing text optimizers are poorly matched to this setting. We
introduce Meta-Harness, an outer-loop system that searches over harness code for
LLM applications using an agentic proposer."""


def test_extract_abstract_prefers_delimited_section():
    pages = [{"text": f"Authors and affiliations\nAbstract\n{META_HARNESS_ABSTRACT}\n1 Introduction\nBackground text"}]
    assert extract_abstract_text(pages) == META_HARNESS_ABSTRACT


def test_extract_abstract_falls_back_when_header_is_missing():
    pages = [{"text": MUON_ABSTRACT}]
    assert extract_abstract_text(pages) == MUON_ABSTRACT


def test_closed_ontology_rejects_ambiguous_optimizer_label():
    tags = normalize_tag_items([
        {"name": "Optimizer", "role": "primary_topic", "confidence": 0.9},
        {"name": "Harness Engineering", "role": "primary_topic", "confidence": 0.95},
        {"name": "LLM Applications", "role": "domain", "confidence": 0.9},
    ])
    assert flatten_categories(tags) == ["Harness Engineering", "LLM Applications"]
    assert tags["version"] == PAPER_TAG_SCHEMA_VERSION


def test_prompt_defines_training_optimizer_semantic_boundary():
    prompt = build_paper_tag_prompt("Meta-Harness", META_HARNESS_ABSTRACT)
    assert "Never use it for prompt, text, program, workflow, agent, or harness" in prompt
    assert "primary_topic=Harness Engineering" in prompt
    assert "NOT Training Optimizer" in prompt


@pytest.mark.asyncio
async def test_meta_harness_structured_classification_uses_analysis_group(monkeypatch):
    from services import llm_client

    call = {}

    async def fake_generate(prompt, **kwargs):
        call.update(kwargs)
        return [
            {"name": "Harness Engineering", "role": "primary_topic", "confidence": 0.98, "evidence": "searches over harness code"},
            {"name": "LLM Applications", "role": "domain", "confidence": 0.95, "evidence": "for LLM applications"},
            {"name": "Agentic Code Search", "role": "method", "confidence": 0.91, "evidence": "agentic proposer"},
        ]

    monkeypatch.setattr(llm_client, "_llm_json_array_with_retry", fake_generate)
    tags = await llm_client.classify_paper_tags("Meta-Harness", META_HARNESS_ABSTRACT)

    assert call["config_group"] == "analysis"
    assert flatten_categories(tags) == ["Harness Engineering", "LLM Applications", "Agentic Code Search"]
    assert "Training Optimizer" not in flatten_categories(tags)


def test_user_tags_are_not_eligible_for_automatic_backfill():
    user_tags = normalize_tag_items([
        {"name": "Harness Engineering", "role": "primary_topic"},
    ], source="user")
    assert not needs_ai_reclassification({"paper_tags": user_tags})
    assert needs_ai_reclassification({"categories": ["LLM", "Optimizer"]})
