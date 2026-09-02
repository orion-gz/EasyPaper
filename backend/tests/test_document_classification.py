import pytest

from services.document_classification import _normalize, representative_text


def test_recommendation_accepts_active_type_and_limits_alternatives():
    value = _normalize({
        "document_mode": "general", "document_type": "manual", "confidence": 1.4,
        "reason": "ordered instructions", "alternatives": [
            {"document_mode": "general", "document_type": "technical"},
            {"document_mode": "research", "document_type": "thesis"},
            {"document_mode": "general", "document_type": "article"},
        ],
    })
    assert value["confidence"] == 1.0
    assert len(value["alternatives"]) == 2


def test_recommendation_rejects_cross_mode_type():
    with pytest.raises(ValueError):
        _normalize({"document_mode": "general", "document_type": "research_paper"})


def test_representative_text_is_bounded_and_samples_edges():
    pages = [{"text": f"page-{number} " + "x" * 1200} for number in range(20)]
    sample = representative_text(pages, limit=6000)
    assert len(sample) <= 6000
    assert "page-0" in sample
    assert "page-19" in sample
