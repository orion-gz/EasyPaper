"""services/llm_client.py의 generate_reading_primer() 응답 파싱 테스트.

실제 LLM 호출은 하지 않고 stream_antigravity를 대체해 고정된 응답 텍스트를
돌려주게 한 뒤, 신규 필드(LINEAGE/FEYNMAN/HYPOTHESIS-METHOD-RESULT/GLOSSARY)를
포함한 응답이 올바르게 파싱되는지 검증한다.
"""

import pytest

import services.llm_client as llm_client


@pytest.fixture()
def fake_provider(monkeypatch):
    """stream_antigravity가 실제 CLI를 호출하지 않도록 대체하고, 미리 정해둔
    응답을 돌려주게 한다."""
    state = {"response": ""}

    async def fake_stream_antigravity(prompt, model=None, session_id=None, **kwargs):
        yield state["response"]

    monkeypatch.setattr(llm_client, "stream_antigravity", fake_stream_antigravity)
    monkeypatch.setattr(llm_client, "get_analysis_provider", lambda: "antigravity")
    monkeypatch.setattr(llm_client, "get_analysis_model", lambda: "test-model")
    return state


_FULL_RESPONSE = (
    "HOOK: 기존 접근이 왜 실패하는가?\n"
    "LINEAGE: 기존 방법은 한계가 있었는데, 이 논문은 이를 해결해 성능을 높였다.\n"
    "FEYNMAN: 마치 지도를 그리듯 핵심 아이디어를 비유로 설명한다.\n"
    "Q1: 질문1\nQ2: 질문2\nQ3: 질문3\n"
    "CHECK1: 체크1\nCHECK2: 체크2\nCHECK3: 체크3\n"
    "HYPOTHESIS1: 가설1\nMETHOD1: 방법1\nRESULT1: 결과1\n"
    "HYPOTHESIS2: 가설2\nMETHOD2: 방법2\nRESULT2: 결과2\n"
    "GLOSSARY1: HNEN :: 계층적 신경 인코딩 누락 현상을 뜻하는 용어\n"
    "GLOSSARY2: ViEEG :: 시각-EEG 교차 인코딩 프레임워크\n"
    "REC1: Attention Is All You Need\n"
)


@pytest.mark.asyncio
async def test_parses_all_new_fields(fake_provider):
    fake_provider["response"] = _FULL_RESPONSE
    result = await llm_client.generate_reading_primer(
        "Test Paper",
        {"intro_related": "intro text", "method_results": "method text", "conclusion": "concl text"},
        [{"term": "HNEN", "context_sentence": "...HNEN framework...", "page_num": 1}],
    )

    assert result["hook"] == "기존 접근이 왜 실패하는가?"
    assert "해결해 성능을 높였다" in result["lineage"]
    assert "비유로 설명한다" in result["feynman"]
    assert result["questions"] == ["질문1", "질문2", "질문3"]
    assert result["checklist"] == ["체크1", "체크2", "체크3"]
    assert result["recommended_titles"] == ["Attention Is All You Need"]

    assert result["experiment_flow"] == [
        {"hypothesis": "가설1", "method": "방법1", "result": "결과1"},
        {"hypothesis": "가설2", "method": "방법2", "result": "결과2"},
    ]

    assert result["glossary"] == [
        {"term": "HNEN", "definition": "계층적 신경 인코딩 누락 현상을 뜻하는 용어"},
        {"term": "ViEEG", "definition": "시각-EEG 교차 인코딩 프레임워크"},
    ]


@pytest.mark.asyncio
async def test_incomplete_experiment_flow_set_is_dropped(fake_provider):
    """HYPOTHESIS만 있고 METHOD/RESULT가 없는 불완전한 세트는 결과에 포함하지 않는다."""
    fake_provider["response"] = "HOOK: h\nHYPOTHESIS1: 가설만 있음\n"
    result = await llm_client.generate_reading_primer(
        "Test Paper", {"intro_related": "x", "method_results": "", "conclusion": ""}, []
    )
    assert result["experiment_flow"] == []


@pytest.mark.asyncio
async def test_glossary_line_without_delimiter_is_ignored(fake_provider):
    fake_provider["response"] = "HOOK: h\nGLOSSARY1: 구분자가 없는 잘못된 형식\n"
    result = await llm_client.generate_reading_primer(
        "Test Paper", {"intro_related": "x", "method_results": "", "conclusion": ""}, []
    )
    assert result["glossary"] == []


@pytest.mark.asyncio
async def test_empty_sections_and_terms_do_not_crash_prompt_building(fake_provider):
    fake_provider["response"] = "HOOK: h\n"
    result = await llm_client.generate_reading_primer(
        "Test Paper", {"intro_related": "", "method_results": "", "conclusion": ""}, []
    )
    assert result["hook"] == "h"
