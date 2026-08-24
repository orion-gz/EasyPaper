"""services/llm_client.py의 stream_translation() 프롬프트 구성 테스트.

세션이 지속되는 provider(antigravity/claude_code/codex)는 매 페이지마다 규칙
전문을 다시 보내지 않고, 5페이지에 한 번만 리마인드하는 "짧은 프롬프트"를
쓴다. 이때 수식/표/참고문헌 제외 옵션까지 "앞서 안내한 규칙을 유지하라"는
말에만 의존하면 세션이 길어질수록 모델이 잊어버려 표가 번역 결과에 섞여
들어오는 문제가 있었다 - 이를 방지하기 위해 이 옵션들만큼은 짧은 프롬프트
에도 매번 명시적으로 재포함되는지 검증한다.
"""

import pytest

import services.llm_client as llm_client


@pytest.fixture()
def capture_antigravity_prompt(monkeypatch):
    """stream_antigravity가 실제로 외부 CLI를 호출하지 않도록 대체하고,
    전달된 prompt를 캡처해 반환하는 리스트를 제공한다."""
    captured = []

    async def fake_stream_antigravity(prompt, model=None, session_id=None):
        captured.append(prompt)
        yield "번역결과"

    monkeypatch.setattr(llm_client, "stream_antigravity", fake_stream_antigravity)
    monkeypatch.setattr(llm_client, "get_trans_provider", lambda: "antigravity")
    monkeypatch.setattr(llm_client, "get_trans_model", lambda: "gemini")
    return captured


async def _drain(agen):
    async for _ in agen:
        pass


@pytest.mark.asyncio
async def test_short_prompt_reminds_ignore_table(capture_antigravity_prompt):
    await _drain(llm_client.stream_translation(
        text="[S0] Some table content here.",
        ignore_table=True,
        session_id="sess-1",
        page_num=3,  # (3-1) % 5 != 0 이고 1도 아니므로 짧은 프롬프트 경로
    ))
    prompt = capture_antigravity_prompt[0]
    assert "Omit tables completely" in prompt and "never emit Markdown tables" in prompt


@pytest.mark.asyncio
async def test_short_prompt_omits_table_reminder_when_not_ignoring(capture_antigravity_prompt):
    await _drain(llm_client.stream_translation(
        text="[S0] Some table content here.",
        ignore_table=False,
        session_id="sess-1",
        page_num=3,
    ))
    prompt = capture_antigravity_prompt[0]
    assert "Omit tables completely" not in prompt


@pytest.mark.asyncio
async def test_short_prompt_reminds_ignore_math_and_refs(capture_antigravity_prompt):
    await _drain(llm_client.stream_translation(
        text="[S0] Some equation content here.",
        ignore_math=True,
        ignore_table=False,
        ignore_refs=True,
        session_id="sess-1",
        page_num=3,
    ))
    prompt = capture_antigravity_prompt[0]
    assert "Omit mathematical expressions" in prompt
    assert "Omit reference lists and footnotes" in prompt


@pytest.mark.asyncio
async def test_reminder_page_uses_full_prompt_not_short_prompt(capture_antigravity_prompt, monkeypatch):
    """page_num=1(리마인드 페이지)은 짧은 프롬프트 경로를 타지 않고 전체
    규칙이 담긴 프롬프트를 그대로 사용해야 한다."""
    monkeypatch.setattr(llm_client, "get_translation_prompt_template", lambda: (
        "{{LANG_INSTRUCTION}}\n{{STYLE_INSTRUCTION}}\n{{RULES_TEXT}}\n{{CONTEXT_PART}}\n{{TEXT}}\n{{TARGET_LANG}}"
    ))
    await _drain(llm_client.stream_translation(
        text="[S0] Some table content here.",
        ignore_table=True,
        session_id="sess-1",
        page_num=1,
    ))
    prompt = capture_antigravity_prompt[0]
    assert "Maintain all previously supplied rules" not in prompt
    assert "Omit tables completely" in prompt
