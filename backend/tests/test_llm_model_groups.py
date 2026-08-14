import pytest

import config
import services.llm_client as llm_client


def test_analysis_and_library_settings_fallback_chain(monkeypatch):
    monkeypatch.setattr(config, "TRANS_PROVIDER", "trans-provider")
    monkeypatch.setattr(config, "TRANS_MODEL", "trans-model")
    monkeypatch.setattr(config, "DEFAULT_AI_PROVIDER", "")
    monkeypatch.setattr(config, "DEFAULT_AI_MODEL", "")
    monkeypatch.setattr(config, "CHAT_PROVIDER", "chat-provider")
    monkeypatch.setattr(config, "CHAT_MODEL", "chat-model")
    monkeypatch.setattr(config, "ANALYSIS_PROVIDER", "")
    monkeypatch.setattr(config, "ANALYSIS_MODEL", "")
    monkeypatch.setattr(config, "LIBRARY_PROVIDER", "")
    monkeypatch.setattr(config, "LIBRARY_MODEL", "")

    assert config.get_default_ai_provider() == "trans-provider"
    assert config.get_default_ai_model() == "trans-model"
    assert config.get_analysis_provider() == "chat-provider"
    assert config.get_analysis_model() == "chat-model"
    assert config.get_library_provider() == "chat-provider"
    assert config.get_library_model() == "chat-model"

    monkeypatch.setattr(config, "ANALYSIS_PROVIDER", "analysis-provider")
    monkeypatch.setattr(config, "ANALYSIS_MODEL", "analysis-model")
    assert config.get_library_provider() == "analysis-provider"
    assert config.get_library_model() == "analysis-model"


@pytest.mark.asyncio
async def test_json_features_select_their_model_group(monkeypatch):
    calls = []

    async def fake_json_call(prompt, **kwargs):
        calls.append(kwargs["config_group"])
        return []

    monkeypatch.setattr(llm_client, "_llm_json_array_with_retry", fake_json_call)

    await llm_client.extract_paper_concepts("title", "text")
    await llm_client.match_question_to_concepts("question", ["concept"])
    await llm_client.find_similar_concepts("new", ["existing"])
    await llm_client.score_paper_concept_relevance("title", "text", ["concept"])
    await llm_client.generate_reading_recommendations(["title"], ["category"])
    await llm_client.generate_dashboard_insights({})

    assert calls == [
        "analysis",
        "chat",
        "library",
        "library",
        "library",
        "library",
    ]
