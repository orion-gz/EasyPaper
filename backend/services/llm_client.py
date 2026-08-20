import asyncio
import functools
import httpx
import json
import logging
import re
import threading
from typing import AsyncGenerator
from services.atomic_io import atomic_write_text
from config import (
    get_ollama_host,
    get_trans_provider,
    get_trans_model,
    get_chat_provider,
    get_chat_model,
    get_analysis_provider,
    get_analysis_model,
    get_library_provider,
    get_library_model,
    get_openai_api_key,
    get_gemini_api_key,
    get_claude_api_key,
    get_agy_path,
    get_agy_env,
    get_claude_code_path,
    get_codex_path,
    get_translation_prompt_template,
    get_project_root,
    windows_safe_exec_args as _exec_args,
)

logger = logging.getLogger(__name__)


# CLI(Claude Code/Codex/Antigravity) 서브프로세스 출력이 이 시간(초) 동안
# 한 번도 들어오지 않으면 멈춘 것으로 판단한다. claude_code/codex는 이
# 호출을 문서(session_id)당 asyncio.Lock으로 감싸는데, 타임아웃 없이
# 무한정 기다리면 CLI가 인증 프롬프트 대기·네트워크 stall 등으로 멈췄을 때
# 그 락을 영원히 붙잡아 해당 문서의 번역/채팅/인사이트 호출이 서버
# 재시작 전까지 전부 막히는 문제가 있었다.
CLI_STALL_TIMEOUT_SECONDS = 120
# stdout이 이미 EOF로 닫힌 뒤에는 프로세스가 곧 종료되어야 정상이므로,
# wait()에는 훨씬 짧은 타임아웃만 준다.
CLI_EXIT_TIMEOUT_SECONDS = 10


async def _kill_process_safely(process):
    """멈춘 것으로 판단된 CLI 서브프로세스를 강제 종료하고 좀비로 남지 않도록 회수한다."""
    try:
        process.kill()
    except Exception:
        pass
    try:
        await asyncio.wait_for(process.wait(), timeout=5)
    except Exception:
        pass


async def _read_chunk_with_timeout(process, size: int = 1024, label: str = "CLI"):
    """process.stdout.read()에 정체 타임아웃을 적용. 타임아웃 시 프로세스를 죽이고 예외를 던진다."""
    try:
        return await asyncio.wait_for(process.stdout.read(size), timeout=CLI_STALL_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        await _kill_process_safely(process)
        raise RuntimeError(f"{label} 응답이 {CLI_STALL_TIMEOUT_SECONDS}초 이상 없어 중단했습니다(멈춘 것으로 판단).")


async def _readline_with_timeout(process, label: str = "CLI"):
    """process.stdout.readline()에 정체 타임아웃을 적용. 타임아웃 시 프로세스를 죽이고 예외를 던진다."""
    try:
        return await asyncio.wait_for(process.stdout.readline(), timeout=CLI_STALL_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        await _kill_process_safely(process)
        raise RuntimeError(f"{label} 응답이 {CLI_STALL_TIMEOUT_SECONDS}초 이상 없어 중단했습니다(멈춘 것으로 판단).")


async def _wait_with_timeout(process, label: str = "CLI"):
    """stdout이 닫힌 뒤 프로세스 종료를 짧게만 기다리고, 안 끝나면 강제 종료한다."""
    try:
        await asyncio.wait_for(process.wait(), timeout=CLI_EXIT_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        await _kill_process_safely(process)
        raise RuntimeError(f"{label} 프로세스가 출력 종료 후에도 {CLI_EXIT_TIMEOUT_SECONDS}초 이상 종료되지 않아 강제 종료했습니다.")


def _start_stderr_drain(process):
    """stderr을 별도 태스크로 즉시 계속 읽기 시작한다.

    이전에는 stdout을 다 읽고 프로세스가 끝난 뒤에야 stderr를 읽었는데, CLI가
    stderr에 충분히 많은 내용을 써서 OS 파이프 버퍼(보통 64KB)가 가득 차면
    자식 프로세스가 그 write() 호출에서 멈춰버리고, 그 상태로는 stdout도
    더 이상 진행되지 않아 사실상 데드락에 빠질 수 있었다. 생성과 동시에
    별도 태스크로 계속 읽어 버퍼가 절대 가득 차지 않게 한다.
    """
    return asyncio.create_task(process.stderr.read())


async def _finish_stderr_drain(stderr_task) -> str:
    """stderr 드레인 태스크를 정리하고 지금까지 모인 내용을 문자열로 반환한다.

    process.wait()가 끝난 직후에도 stderr 파이프의 EOF 감지가 아주 살짝(수십~수백ms)
    늦게 반영되어 stderr_task.done()이 아직 False일 수 있다(실측으로 확인됨) - 이걸
    "멈춘 것"으로 보고 곧장 cancel해버리면, 이미 커널 파이프에는 다 도착해 있던 stderr
    내용까지 통째로 버려진다(취소된 태스크를 await하면 CancelledError만 던지고 그동안
    읽은 데이터는 사라짐). 그 결과 예를 들어 claude_code의 "No conversation found"
    같은 실패 메시지를 못 읽어, 상위의 재시도(신규 세션 생성) 로직이 걸리지 않는 버그가
    있었다. 정말 멈춘 경우와 구분하기 위해 짧게 유예 시간을 준 뒤에만 취소한다.
    """
    if not stderr_task.done():
        try:
            await asyncio.wait_for(stderr_task, timeout=2.0)
        except Exception:
            pass
    try:
        data = stderr_task.result()
    except Exception:
        return ""
    return data.decode("utf-8", errors="replace") if data else ""


async def stream_translation(
    text: str,
    target_lang: str = "한국어",
    style: str = "academic",
    ignore_math: bool = False,
    ignore_table: bool = True,
    ignore_refs: bool = False,
    doc_title: str = "",
    prev_context: str = "",
    session_id: str = None,
    page_num: int = None,
    page_image_b64: str = None,
    document_mode: str = "research",
    document_type: str = "research_paper",
) -> AsyncGenerator[str, None]:
    """
    Ollama /api/chat 엔드포인트를 사용해 번역 결과를 스트리밍합니다.
    사용자의 요구에 따른 언어, 번역 스타일, 제외 요소 옵션에 맞춰 프롬프트를 동적으로 구성합니다.
    """
    provider = get_trans_provider()
    from services.document_policy import build_translation_policy
    document_policy_rules = build_translation_policy(document_mode, document_type)
    model = get_trans_model()

    # antigravity/claude code는 문서(session_id)당 세션(대화)이 실제로 이어지므로,
    # 매 페이지마다 문체·수식·표·참고문헌 처리 규칙 전체를 통째로 반복해서 보낼
    # 필요가 없다 - 이미 앞선 페이지에서 같은 대화 안에 전달된 지시사항을 모델이
    # 기억하고 있다. 다만 대화가 길어질수록 규칙이 흐려질 수 있으므로, 완전히
    # 한 번만 보내고 끝내지는 않고 5페이지마다 한 번씩 전체 규칙을 다시 리마인드
    # 한다. 세션 개념이 없는 provider(openai/gemini/claude API/ollama)는 매 호출이
    # 독립적이라 이 최적화가 의미가 없으므로 항상 전체 프롬프트를 보낸다. 만약
    # provider를 중간에 바꾸면 그 문서는 처음부터 다시 번역해야 하므로(새 세션이라
    # 이전 페이지의 지시사항을 전혀 모름), 그 경우도 page_num이 그대로 1부터
    # 시작되어 자연히 첫 페이지에서 전체 규칙을 다시 받게 된다.
    REMINDER_INTERVAL = 5
    is_session_persistent = provider in ("antigravity", "claude_code", "codex")
    is_reminder_page = (
        page_num is None
        or page_num == 1
        or (page_num - 1) % REMINDER_INTERVAL == 0
    )
    use_short_prompt = is_session_persistent and session_id and not is_reminder_page

    if use_short_prompt:
        context_part = ""
        if prev_context:
            truncated_prev = prev_context[-1000:] if len(prev_context) > 1000 else prev_context
            context_part = f"\n[참고 문맥 정보]\n- 이전 페이지/단락의 번역 결과 (참고용):\n\"\"\"\n{truncated_prev}\n\"\"\"\n"

        # 제외 옵션(수식/표/참고문헌)은 "앞서 안내한 규칙을 유지하라"는 말만으로는
        # 세션이 길어질수록 모델이 잊어버리는 경우가 있었다(특히 표 제외 규칙 -
        # 표는 시각적으로 두드러진 콘텐츠라 지시를 무시하고 그대로 재현하려는
        # 경향이 강함). 5페이지마다만 리마인드하는 전체 규칙과 별개로, 이 세
        # 가지 제외 옵션만큼은 매 페이지 짧은 프롬프트에도 항상 명시적으로
        # 다시 못박아 드리프트를 방지한다.
        exclusion_reminders = []
        if ignore_math:
            exclusion_reminders.append("수식은 번역하지 말고 생략하거나 단순 기호 처리하세요.")
        if ignore_table:
            exclusion_reminders.append("Markdown 표(Table) 형식의 출력은 절대 하지 말고, 표 데이터는 번역 결과에서 완전히 제외하세요.")
        if ignore_refs:
            exclusion_reminders.append("참고문헌(References) 목록이나 각주 정보는 번역하지 말고 결과에서 제외하세요.")
        exclusion_part = ("\n" + "\n".join(exclusion_reminders) + "\n") if exclusion_reminders else ""

        prompt = (
            f"{document_policy_rules}\n"
            "앞서 안내한 문체·용어·수식·표·참고문헌 처리 규칙을 동일하게 유지하며 이어지는 다음 원문을 번역하세요.\n"
            "서론이나 설명 없이 번역 결과만 즉시 출력하세요. 입력 텍스트의 각 문장 앞에 있는 [S0], [S1] 등 문장 식별자 "
            "태그는 번역 결과에서도 반드시 그대로, 순서를 바꾸거나 누락 없이 유지하세요. 태그 개수는 원문과 정확히 "
            "동일해야 합니다 - 두 개 이상의 원문 문장을 하나의 태그 아래로 합치지 말고, 각 태그 뒤에는 그 태그가 "
            "표시된 원문 문장 하나에 대응하는 번역만 오도록 하세요. 원문에 없는 태그를 새로 만들거나 번역 문장을 "
            "임의로 더 쪼개어 추가 태그를 붙이지도 마세요. 일부 태그는 [S3:I]처럼 콜론 뒤에 알파벳이 붙어 있을 수 "
            "있는데, 이것도 지우거나 숫자만 남기지 말고 태그 전체를 그대로 유지하세요. 원문에서 **별표 두 개로 감싸인 "
            "부분**은 볼드 처리였으니 번역 결과에서도 그 부분을 동일하게 **볼드**로 감싸서 출력하세요.\n"
            f"{exclusion_part}"
            f"{context_part}\n"
            f"원문:\n{text}\n\n"
            f"{target_lang} 번역:"
        )

        if provider == "antigravity":
            async for token in stream_antigravity(prompt, model=model, session_id=session_id):
                yield token
            return
        elif provider == "claude_code":
            async for token in stream_claude_code(prompt, model=model, session_id=session_id):
                yield token
            return
        elif provider == "codex":
            async for token in stream_codex(prompt, model=model, session_id=session_id):
                yield token
            return
        # 세션 지속 provider가 아니면 여기 도달하지 않지만, 안전하게 아래 전체
        # 프롬프트 경로로 흘러가도록 둔다.

    # 1. 문서 모드에 맞는 목적어와 문체 설정
    is_research = document_mode == "research"
    source_noun = "영어 논문 텍스트" if is_research else "문서 텍스트"
    lang_instruction = f"다음 {source_noun}를 자연스러운 {target_lang}로 번역하세요."

    naturalness_guidance = (
        "번역투 방지: 원문의 문장 구조나 어순을 그대로 옮기려 하지 말고, 자연스러운 목표 언어 "
        "문장으로 재구성하세요. 길고 복잡한 문장은 자연스러운 호흡에 맞게 두세 문장으로 나눠 "
        "쓰세요. 단, 문장을 나누더라도 원문 문장의 [S] 태그는 하나만 유지하고 새로운 태그를 "
        "만들지 마세요. 이 과정에서 원문의 의미나 사실 관계를 바꾸거나 생략해서는 안 됩니다."
    )

    if style == "literal":
        style_instruction = "자연스러운 직역을 수행하고 원문의 어순을 가능한 한 유지하여 단어 대조가 쉽도록 번역하세요."
    elif style == "summary":
        focus = "연구 내용" if is_research else "내용"
        style_instruction = (
            f"문단의 핵심 {focus}을 짧고 명확한 개조식 또는 설명글 형태로 요약 번역하세요.\n"
            f"{naturalness_guidance}"
        )
    else:
        register = "학술 문체" if is_research else "원문의 목적과 문체"
        style_instruction = (
            f"자연스럽고 명확한 {target_lang} 표현을 사용하고 {register}를 유지해 번역문을 다듬으세요.\n"
            f"{naturalness_guidance}"
        )

    rules = [
        document_policy_rules,
        "전문 용어 번역 원칙: 사전적으로 정확한 번역이 아니라, 해당 분야의 한국어 문서에서 "
        "실제로 관용적으로 쓰이는 표기를 따르세요.\n"
        f"- 이미 자연스러운 {target_lang} 대응어가 정착된 일반 용어는 {target_lang}로 번역하고 "
        f"필요시 괄호에 영어 원문을 병기하세요 (예: 심층 학습(Deep Learning), 지도 학습(Supervised Learning)).\n"
        "- 하지만 self-attention, transformer, attention mechanism, backpropagation, embedding, "
        "fine-tuning, batch normalization, dropout, epoch처럼 실제 한국어 논문/기술 문서에서도 "
        "번역하지 않고 영어 그대로 쓰거나 발음만 한글로 옮기는(예: '셀프 어텐션', '트랜스포머') "
        "방법론·기법·모델 구성요소 명칭은 억지로 의미를 풀어서 번역하지 마세요. "
        "(잘못된 예: self-attention → \"자기주의\" / 올바른 예: self-attention → \"self-attention\" "
        "또는 \"셀프 어텐션\"). 모델명, 데이터셋명 등 고유명사도 항상 원문 그대로 유지하세요.\n"
        "- 판단이 애매하면 그 분야 전공자가 실제로 쓰는 표현을 우선하세요 - 사전적으로는 맞아도 "
        "현장에서 쓰지 않는 표현이면 부자연스러운 번역입니다.",
        "문단 구조(빈 줄)를 원문과 동일하게 유지하세요.",
        "URL, DOI, 저자명, 이메일 주소 등은 번역하지 말고 원문 그대로 유지하세요.",
        "페이지 줄 번호(예: 001 002)나 페이지 헤더/푸터 정보는 번역에서 제외하세요.",
        "설명이나 메모, 서론(예: '여기에 번역이 있습니다')은 절대 추가하지 말고 번역 결과만 즉시 출력하세요.",
        ("번역문은 반드시 경어체로만 작성하고 평어체를 섞지 마세요."
         if is_research else "원문의 서술 시점, 존대 수준, 대화체와 명령문의 강도를 유지하세요."),
        "중요: 입력 텍스트의 각 문장 시작 부분에 [S0], [S1], [S2] 등과 같은 문장 식별자 태그가 포함되어 있습니다. 번역 결과에서도 각 번역된 문장 앞에 일치하는 태그(예: [S0], [S1]...)를 반드시 그대로 유지하여 출력하세요. 태그의 순서를 바꾸거나 누락하지 마세요. "
        "태그 개수는 원문과 정확히 동일해야 합니다 - 두 개 이상의 원문 문장을 하나의 태그 아래로 합쳐서 번역하지 마세요(예: [S3] 문장이 [S4] 문장의 번역까지 함께 포함해서는 안 됩니다). 반대로 원문에 없는 태그를 새로 만들거나, 번역 문장을 임의로 더 잘게 나누어 추가 태그를 붙이지도 마세요. "
        "예를 들어 원문이 \"[S0] Sentence A. [S1] Sentence B.\"라면, 번역 결과는 반드시 \"[S0] A의 번역. [S1] B의 번역.\"처럼 태그 1개당 정확히 그 태그가 표시된 원문 문장 1개의 번역만 대응해야 합니다. "
        "일부 태그는 [S3:I]처럼 콜론 뒤에 알파벳이 붙어 있을 수 있습니다 - 이는 원문 레이아웃 정보이니 절대 지우거나 숫자만 남기지 말고 콜론과 알파벳을 포함해 태그 전체를 그대로 출력하세요.",
        "원문 텍스트 중 **이렇게 별표 두 개로 감싸인 부분**은 PDF 원본에서 볼드(굵게) 처리되어 있던 부분입니다. 번역 결과에서도 그 부분에 해당하는 번역 텍스트를 동일하게 **볼드 표시**로 감싸서 출력하세요. 별표로 감싸지 않은 나머지 부분에는 임의로 볼드 표시를 추가하지 마세요.",
    ]

    if ignore_math:
        rules.append("수식(LaTeX 수식 블록 또는 인라인 수식)은 번역하지 말고, 수식 자체를 생략하거나 단순 기호 처리하세요.")
    else:
        rules.append(
            "수식, 수식 기호, 수학적 변수나 수식 성분(예: x_i, f(x), \\alpha, \\beta, O(N) 등), 참조 번호 [1], [2,3], Figure N, Table N 레이블은 원문 그대로 유지하세요.\n"
            "단, 원문에서 일반 텍스트 기호로 노출되는 수학 기호, 수식, 변수명은 웹 뷰어에서 미려하게 렌더링되도록 LaTeX 수식 기호($...$ 또는 $$...$$)로 적절히 감싸서 출력해 주세요.\n"
            "※ 중요 1: 등호(=), 더하기(+), 빼기(-), 분수, 시그마(\\sum), 인테그랄(\\int) 등 여러 연산 기호와 변수가 결합된 복잡한 식은 절대로 여러 개의 인라인 수식으로 잘게 쪼개서 감싸지 마세요. 식 전체(예: $f(x) = x_i + y_i$ 또는 $f(x) = \\sum_{i=1}^n x_i$)를 통째로 하나의 인라인($...$) 또는 블록($$...$$) 수식 기호로 감싸서 온전하게 출력해야 합니다. 수식 중간에 기호나 연산자를 수식 기호($) 바깥으로 노출시키지 마세요.\n"
            "※ 중요 2: 원문에 식 번호(예: (1), (2), (3.4) 등 괄호 안에 숫자가 표기된 형태)가 붙어 있는 수식은 독립된 블록 수식으로 취급해야 합니다. 번역문에서도 이 수식은 본문 줄바꿈을 통해 반드시 별도의 단독 줄(Line break)로 분리하고, 블록 수식 기호인 $$...$$를 사용하여 식 번호와 함께 감싸서 출력하세요 (예: `\\n$$f(x) = y \\quad (1)$$\\n`). 이를 본문 한가운데에 인라인 형태로 이어 적지 마세요.\n"
            "※ 중요 3: 하나의 긴 수식이 원문 텍스트 레이어의 분리로 인해 여러 줄(Line)로 나뉘어 있거나, 시그마(\\sum) 등 수식의 일부 기호가 단독으로 쪼개져 보일 수 있습니다. 이 경우 번역문에서는 절대로 수식의 일부 기호(예: `\\sum^L` 등)를 중복되거나 잘못된 단독 수식으로 분리하여 출력하지 마세요. 여러 줄에 걸쳐 나뉜 수식 성분들을 누락이나 기호의 중복 생성 없이 온전히 하나로 병합하여 단 하나의 완성된 블록 수식 `$$수식 전체$$`로 결합하여 출력해야 합니다."
        )
        # PDF 텍스트 추출은 수식 폰트(그리스 문자, 첨자, 시그마/적분 등)의 글리프를
        # 엉뚱한 유니코드로 옮기거나 순서를 뒤섞는 경우가 많아, 텍스트만으로는
        # 원본 수식을 온전히 복원하기 어렵다 - vision을 지원하는 provider(openai/
        # gemini/claude)에는 이 페이지의 실제 스캔 이미지를 함께 첨부해, 텍스트가
        # 아니라 이미지를 근거로 수식을 재현하도록 지시한다.
        if page_image_b64:
            rules.append(
                "이 페이지의 실제 스캔 이미지가 텍스트와 함께 첨부되어 있습니다. PDF에서 텍스트를 추출하는 "
                "과정에서 수식 기호, 위/아래 첨자, 그리스 문자, 시그마·적분 등의 구조가 깨지거나 순서가 "
                "뒤섞였을 수 있습니다. 수식의 정확한 표기(어떤 기호인지, 첨자가 위첨자인지 아래첨자인지, "
                "항의 순서 등)는 텍스트가 아니라 반드시 첨부된 이미지를 직접 보고 확인하여 정확한 LaTeX로 "
                "재현하세요. 추출된 텍스트와 이미지의 내용이 서로 다르게 보이면 이미지를 기준으로 삼으세요."
            )

    if ignore_table:
        rules.append("Markdown 표(Table) 형식의 출력은 절대 하지 말고, 표 데이터는 번역에서 완전히 제외하세요.")
    else:
        rules.append("표(Table)의 수치·단위·레이블을 보존하고 문서 문맥에 맞게 번역하고 마크다운 표 형태를 유지하세요.")
        
    if ignore_refs:
        rules.append("참고문헌(References) 목록이나 각주 정보는 번역하지 말고 목록에서 제외하세요.")
        
    n = len(rules)
    rules_text = "\n".join(f"{idx+1}. {rule}" for idx, rule in enumerate(rules))
    
    # 4. 문맥 정보 추가 (Context-aware Translation)
    context_part = ""
    if doc_title:
        context_part += f"- 문서 제목 (Document Title): {doc_title}\n"
    if prev_context:
        # 이전 번역 결과가 너무 길면 뒷부분 1000자만 잘서 보냄
        truncated_prev = prev_context[-1000:] if len(prev_context) > 1000 else prev_context
        context_part += f"- 이전 페이지/단락의 번역 결과 (참고용):\n\"\"\"\n{truncated_prev}\n\"\"\"\n"

    if context_part:
        context_part = f"\n[참고 문맥 정보]\n{context_part}"

    # 5. 템플릿 로드 및 프롬프트 동적 조립 (하드코딩 제거)
    template = get_translation_prompt_template()
    prompt = (
        template
        .replace("{{LANG_INSTRUCTION}}", lang_instruction)
        .replace("{{STYLE_INSTRUCTION}}", style_instruction)
        .replace("{{RULES_TEXT}}", rules_text)
        .replace("{{CONTEXT_PART}}", context_part)
        .replace("{{TEXT}}", text)
        .replace("{{TARGET_LANG}}", target_lang)
    )

    messages = [
        {
            "role": "user",
            "content": prompt,
        }
    ]
    # ignore_math일 때는 애초에 수식을 번역 결과에서 빼므로 이미지를 함께 보낼
    # 이유가 없다 - 수식을 실제로 재현해야 하는 경우에만 첨부한다.
    use_image = bool(page_image_b64) and not ignore_math

    if provider == "openai":
        if use_image:
            messages = [{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{page_image_b64}"}}
                ]
            }]
        async for token in stream_openai(messages, model=model, temperature=0.3):
            yield token
        return
    elif provider == "gemini":
        async for token in stream_gemini(messages, model=model, temperature=0.3, image_b64=page_image_b64 if use_image else None):
            yield token
        return
    elif provider == "claude":
        if use_image:
            messages = [{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": page_image_b64}}
                ]
            }]
        async for token in stream_claude(messages, model=model, temperature=0.3):
            yield token
        return
    elif provider == "antigravity":
        async for token in stream_antigravity(prompt, model=model, session_id=session_id):
            yield token
        return
    elif provider == "claude_code":
        async for token in stream_claude_code(prompt, model=model, session_id=session_id):
            yield token
        return
    elif provider == "codex":
        async for token in stream_codex(prompt, model=model, session_id=session_id):
            yield token
        return

    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "think": False,  # thinking 모드 비활성화 (속도 향상)
        "options": {
            "temperature": 0.3,
            "top_p": 0.9,
            "num_ctx": 8192,
            "num_predict": 4096,
        },
    }

    try:
        async with httpx.AsyncClient(timeout=360.0) as client:
            async with client.stream(
                "POST",
                f"{get_ollama_host()}/api/chat",
                json=payload,
            ) as response:
                if response.status_code != 200:
                    body = await response.aread()
                    raise RuntimeError(
                        f"Ollama API 오류 (HTTP {response.status_code}): {body.decode()[:200]}"
                    )

                async for line in response.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        data = json.loads(line)

                        # 에러 응답 처리
                        if data.get("error"):
                            raise RuntimeError(f"Ollama 오류: {data['error']}")

                        # 번역 결과 추출
                        message = data.get("message", {})
                        token = message.get("content", "")
                        if token:
                            yield token

                        if data.get("done", False):
                            break

                    except json.JSONDecodeError:
                        continue

    except httpx.ConnectError:
        raise RuntimeError(f"Ollama 서버에 연결할 수 없습니다. ({get_ollama_host()})")
    except httpx.TimeoutException:
        raise RuntimeError("번역 시간이 초과되었습니다. 텍스트가 너무 길 수 있습니다.")
    except httpx.HTTPStatusError as e:
        raise RuntimeError(f"Ollama HTTP 오류: {e.response.status_code}")


class _ProviderResponseError(RuntimeError):
    pass


async def _ensure_provider_response_ok(
    response: httpx.Response, provider: str, include_body: bool = True
) -> None:
    """원격 provider의 비정상 응답을 기존 RuntimeError 계약으로 변환한다."""
    if response.status_code == 200:
        return
    body = await response.aread()
    detail = f": {body.decode()[:200]}" if include_body else ""
    raise _ProviderResponseError(f"{provider} API 오류 (HTTP {response.status_code}){detail}")


def _raise_provider_transport_error(provider: str, exc: Exception) -> None:
    """세 provider가 공유하는 연결/타임아웃 오류 문구를 일관되게 만든다."""
    if isinstance(exc, httpx.ConnectError):
        raise RuntimeError(f"{provider} 서버에 연결할 수 없습니다.")
    if isinstance(exc, httpx.TimeoutException):
        raise RuntimeError(f"{provider} 요청 시간이 초과되었습니다.")
    raise exc


async def stream_openai(messages: list, model: str, temperature: float = 0.5) -> AsyncGenerator[str, None]:
    api_key = get_openai_api_key()
    if not api_key:
        raise RuntimeError("OpenAI API Key가 설정되지 않았습니다. 설정에서 입력해 주세요.")
        
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "temperature": temperature
    }
    
    try:
        async with httpx.AsyncClient(timeout=360.0) as client:
            async with client.stream(
                "POST",
                "https://api.openai.com/v1/chat/completions",
                headers=headers,
                json=payload
            ) as response:
                await _ensure_provider_response_ok(response, "OpenAI")
                    
                async for line in response.aiter_lines():
                    line_str = line.strip()
                    if not line_str:
                        continue
                    if line_str.startswith("data:"):
                        data_str = line_str[5:].strip()
                        if data_str == "[DONE]":
                            break
                        try:
                            data = json.loads(data_str)
                            choices = data.get("choices", [])
                            if choices:
                                delta = choices[0].get("delta", {})
                                token = delta.get("content", "")
                                if token:
                                    yield token
                        except json.JSONDecodeError:
                            continue
    except (httpx.ConnectError, httpx.TimeoutException) as exc:
        _raise_provider_transport_error("OpenAI", exc)


async def stream_gemini(messages: list, model: str, temperature: float = 0.5, image_b64: str = None) -> AsyncGenerator[str, None]:
    api_key = get_gemini_api_key()
    if not api_key:
        raise RuntimeError("Gemini API Key가 설정되지 않았습니다. 설정에서 입력해 주세요.")

    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": api_key,
    }

    gemini_contents = []
    system_instruction = None

    for msg in messages:
        role = msg["role"]
        if role == "system":
            system_instruction = {"parts": [{"text": msg["content"]}]}
        else:
            gemini_role = "model" if role == "assistant" else "user"
            gemini_contents.append({
                "role": gemini_role,
                "parts": [{"text": msg["content"]}]
            })

    # 번역 시 수식(LaTeX) 재현 정확도를 높이기 위해 페이지 원본 이미지를 함께
    # 보내는 경우, 마지막 user 메시지의 parts에 inline_data로 첨부한다.
    if image_b64 and gemini_contents:
        gemini_contents[-1]["parts"].append({
            "inline_data": {"mime_type": "image/png", "data": image_b64}
        })

    payload = {
        "contents": gemini_contents,
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": 8192,   # 번역 절단 방지: Gemini 기본값(~2048)이 너무 작음
        }
    }
    if system_instruction:
        payload["systemInstruction"] = system_instruction
        
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent"
    
    try:
        async with httpx.AsyncClient(timeout=360.0) as client:
            async with client.stream(
                "POST",
                url,
                headers=headers,
                json=payload
            ) as response:
                await _ensure_provider_response_ok(response, "Gemini", include_body=False)

                # Gemini streamGenerateContent는 JSON 배열을 스트리밍함:
                # [ {chunk1},\n {chunk2}, ... ]
                # 줄단위 strip은 멀티라인 청크에서 json.loads 실패하므로
                # 누적 버퍼 + 중괄호 균형 탐색으로 완전한 JSON 객체 파싱
                buffer = ""
                async for raw_chunk in response.aiter_bytes():
                    buffer += raw_chunk.decode("utf-8", errors="replace")

                    while True:
                        start = buffer.find("{")
                        if start == -1:
                            buffer = ""
                            break

                        depth = 0
                        end = -1
                        in_string = False
                        escape_next = False
                        for i in range(start, len(buffer)):
                            ch = buffer[i]
                            if escape_next:
                                escape_next = False
                                continue
                            if ch == "\\" and in_string:
                                escape_next = True
                                continue
                            if ch == '"':
                                in_string = not in_string
                            elif not in_string:
                                if ch == "{":
                                    depth += 1
                                elif ch == "}":
                                    depth -= 1
                                    if depth == 0:
                                        end = i
                                        break

                        if end == -1:
                            # 아직 완전한 JSON 객체 없음 → 더 읽어야 함
                            break

                        json_str = buffer[start:end + 1]
                        buffer = buffer[end + 1:]

                        try:
                            data = json.loads(json_str)
                            candidates = data.get("candidates", [])
                            if candidates:
                                content = candidates[0].get("content", {})
                                parts = content.get("parts", [])
                                if parts:
                                    token = parts[0].get("text", "")
                                    if token:
                                        yield token
                        except json.JSONDecodeError:
                            continue

    except (httpx.ConnectError, httpx.TimeoutException) as exc:
        _raise_provider_transport_error("Gemini", exc)
    except _ProviderResponseError:
        raise
    except Exception:
        raise RuntimeError("Gemini 요청 처리 중 오류가 발생했습니다.")


async def stream_claude(messages: list, model: str, temperature: float = 0.5) -> AsyncGenerator[str, None]:
    api_key = get_claude_api_key()
    if not api_key:
        raise RuntimeError("Claude API Key가 설정되지 않았습니다. 설정에서 입력해 주세요.")
        
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
    }
    
    claude_messages = []
    system_prompt = ""
    for msg in messages:
        if msg["role"] == "system":
            system_prompt = msg["content"]
        else:
            claude_messages.append({
                "role": msg["role"],
                "content": msg["content"]
            })
            
    payload = {
        "model": model,
        "messages": claude_messages,
        "stream": True,
        "max_tokens": 8192,
        "temperature": temperature
    }
    if system_prompt:
        payload["system"] = system_prompt
        
    try:
        async with httpx.AsyncClient(timeout=360.0) as client:
            async with client.stream(
                "POST",
                "https://api.anthropic.com/v1/messages",
                headers=headers,
                json=payload
            ) as response:
                await _ensure_provider_response_ok(response, "Claude")
                    
                async for line in response.aiter_lines():
                    line_str = line.strip()
                    if not line_str:
                        continue
                    if line_str.startswith("data:"):
                        data_str = line_str[5:].strip()
                        try:
                            data = json.loads(data_str)
                            delta = data.get("delta", {})
                            token = delta.get("text", "")
                            if token:
                                yield token
                        except json.JSONDecodeError:
                            continue
    except (httpx.ConnectError, httpx.TimeoutException) as exc:
        _raise_provider_transport_error("Claude", exc)


def _save_chat_capture_image(session_id: str, image_b64: str) -> str:
    """캡처 모드로 첨부된 이미지를 vision API가 없는 CLI 기반 provider(agy 등)가
    자신의 파일 도구로 직접 열어볼 수 있도록 문서별 디렉터리에 PNG로 저장하고
    절대경로를 반환한다.

    LIBRARY_DIR는 상대경로("./library")라 우리 프로세스(backend/ 기준 cwd)와
    CLI 서브프로세스(project root 기준 cwd)가 서로 다른 기준으로 풀어버린다 -
    stream_antigravity의 로그 파일 경로와 동일한 이유로 반드시 절대경로로
    변환해서 넘겨야 한다. agy는 이미 --dangerously-skip-permissions로 project
    root 하위 파일 접근 권한을 갖고 있으므로(기존 번역/채팅 흐름과 동일한
    권한 범위), 이 폴더에 새로 쓰는 것으로 접근 범위가 추가로 넓어지지는 않는다.
    """
    import base64 as _base64
    import os
    import time
    from config import LIBRARY_DIR

    capture_dir = os.path.abspath(os.path.join(LIBRARY_DIR, session_id, "chat_captures"))
    os.makedirs(capture_dir, exist_ok=True)
    file_path = os.path.join(capture_dir, f"capture_{int(time.time() * 1000)}.png")
    with open(file_path, "wb") as f:
        f.write(_base64.b64decode(image_b64))
    return file_path


def _messages_with_trailing_image(messages: list, page_image_b64: str, image_block_builder) -> list:
    """마지막 메시지(캡처 이미지를 첨부해 물어본 최신 질문)의 content를 텍스트+
    이미지 멀티파트 블록으로 바꾼 사본을 반환한다. 원본 messages는 건드리지
    않는다 - 이미지는 이번 호출 한 번에만 실어 보내면 되고, DB/히스토리에는
    여전히 텍스트 placeholder만 남아야 하기 때문이다."""
    if not page_image_b64 or not messages or messages[-1]["role"] != "user":
        return messages
    return messages[:-1] + [{
        "role": "user",
        "content": [
            {"type": "text", "text": messages[-1]["content"]},
            image_block_builder(),
        ]
    }]


async def stream_chat(
    system_prompt: str,
    history_messages: list,
    session_id: str = None,
    page_image_b64: str = None
) -> AsyncGenerator[str, None]:
    """
    논문 관련 질문 답변 결과를 스트리밍합니다. (선택된 AI Provider에 따름)

    page_image_b64가 있으면(사용자가 캡처 모드로 화면 영역을 잘라 질문에 첨부한
    경우) vision을 지원하는 provider(openai/gemini/claude)에는 최신 질문 메시지에
    실제 이미지를 함께 실어 보내, 캡처한 영역을 텍스트 placeholder가 아니라
    이미지 자체로 보고 답하게 한다. CLI 기반 provider(antigravity/claude_code/
    codex)는 텍스트 프롬프트만 받을 수 있어 이미지를 첨부할 수 없다 - 번역
    기능의 페이지 이미지 첨부와 동일한 기존 제약이다.
    """
    messages = [{"role": "system", "content": system_prompt}] + history_messages

    provider = get_chat_provider()
    model = get_chat_model()
    if provider == "openai":
        chat_messages = _messages_with_trailing_image(
            messages, page_image_b64,
            lambda: {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{page_image_b64}"}}
        )
        async for token in stream_openai(chat_messages, model=model, temperature=0.5):
            yield token
        return
    elif provider == "gemini":
        async for token in stream_gemini(messages, model=model, temperature=0.5, image_b64=page_image_b64):
            yield token
        return
    elif provider == "claude":
        chat_messages = _messages_with_trailing_image(
            messages, page_image_b64,
            lambda: {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": page_image_b64}}
        )
        async for token in stream_claude(chat_messages, model=model, temperature=0.5):
            yield token
        return
    elif provider == "antigravity":
        # 사용량 기록(record_call)은 stream_antigravity 내부에서 usage_label에
        # 맞춰 이미 처리한다 - 여기서 한 번 더 기록하면 채팅 1회가 2번으로
        # 집계되는 이중 카운트 버그가 있었다.
        # agy CLI가 자체적으로 --conversation 세션 내에 이전 대화 히스토리(우리가 보낸
        # 논문 원문+가이드라인 포함)를 그대로 갖고 있으므로, 같은 세션에 이미 한 번
        # 보냈다면 매 질문마다 논문 원문 전체를 다시 붙일 필요가 없다 - 최초 1회만
        # 붙이고 이후에는 질문만 전달한다.
        include_full_context = not _chat_context_already_sent(session_id, "antigravity")
        formatted_prompt = []
        if include_full_context:
            formatted_prompt.append(f"System instructions:\n{system_prompt}\n")
        if history_messages:
            latest_msg = history_messages[-1]
            question_text = latest_msg.get('content', '')
            # agy는 vision API가 아니라 CLI라 이미지를 메시지에 직접 실을 수
            # 없다 - 대신 파일로 저장해두고 경로를 알려줘서, agy 자신의 파일
            # 읽기 도구로 직접 열어보고 답하게 한다.
            if page_image_b64:
                image_path = _save_chat_capture_image(session_id, page_image_b64)
                question_text += (
                    f"\n\n[사용자가 캡처해 첨부한 이미지 파일: {image_path}]\n"
                    "위 경로의 이미지 파일을 반드시 먼저 열어서 실제로 확인한 뒤, "
                    "그 이미지에 보이는 내용을 근거로 답변하세요. 이미지를 열지 않고 "
                    "추측으로 답하지 마세요."
                )
            formatted_prompt.append(f"User Question:\n{question_text}")

        chat_prompt = "\n".join(formatted_prompt)
        async for token in stream_antigravity(chat_prompt, model=model, session_id=session_id, is_chat=True):
            yield token
        if include_full_context:
            _mark_chat_context_sent(session_id, "antigravity")
        return
    elif provider == "claude_code":
        # 사용량 기록(record_call)은 stream_claude_code 내부에서 usage_label에
        # 맞춰 이미 처리한다 - 여기서 한 번 더 기록하면 채팅 1회가 2번으로
        # 집계되는 이중 카운트 버그가 있었다.
        # claude CLI가 자체적으로 --resume 세션 내에 이전 대화 히스토리(논문 원문+
        # 가이드라인 포함)를 그대로 갖고 있으므로, 같은 세션에 이미 한 번 보냈다면
        # 매 질문마다 논문 원문 전체를 다시 붙일 필요가 없다 - 최초 1회만 붙이고
        # 이후에는 질문만 전달한다.
        include_full_context = not _chat_context_already_sent(session_id, "claude_code")
        formatted_prompt = []
        if include_full_context:
            formatted_prompt.append(f"System instructions:\n{system_prompt}\n")
        if history_messages:
            latest_msg = history_messages[-1]
            question_text = latest_msg.get('content', '')
            # claude code 세션은 이제 project root가 아니라 이 문서 전용 격리
            # 폴더를 cwd로 쓰고 Read 도구만 열어두므로(stream_claude_code 참고),
            # agy와 동일하게 캡처 이미지를 파일로 저장해두고 경로를 알려줘서
            # 직접 열어보고 답하게 할 수 있다.
            if page_image_b64:
                image_path = _save_chat_capture_image(session_id, page_image_b64)
                question_text += (
                    f"\n\n[사용자가 캡처해 첨부한 이미지 파일: {image_path}]\n"
                    "위 경로의 이미지 파일을 반드시 먼저 열어서 실제로 확인한 뒤, "
                    "그 이미지에 보이는 내용을 근거로 답변하세요. 이미지를 열지 않고 "
                    "추측으로 답하지 마세요."
                )
            formatted_prompt.append(f"User Question:\n{question_text}")

        chat_prompt = "\n".join(formatted_prompt)
        async for token in stream_claude_code(chat_prompt, model=model, session_id=session_id, is_chat=True):
            yield token
        if include_full_context:
            _mark_chat_context_sent(session_id, "claude_code")
        return
    elif provider == "codex":
        # 사용량 기록(record_call)은 stream_codex 내부에서 usage_label에 맞춰
        # 이미 처리한다 - 여기서 한 번 더 기록하면 채팅 1회가 2번으로 집계되는
        # 이중 카운트 버그가 있었다.
        # codex CLI가 자체적으로 resume 세션(thread) 내에 이전 대화 히스토리(논문 원문+
        # 가이드라인 포함)를 그대로 갖고 있으므로, 같은 세션에 이미 한 번 보냈다면
        # 매 질문마다 논문 원문 전체를 다시 붙일 필요가 없다 - 최초 1회만 붙이고
        # 이후에는 질문만 전달한다.
        include_full_context = not _chat_context_already_sent(session_id, "codex")
        formatted_prompt = []
        if include_full_context:
            formatted_prompt.append(f"System instructions:\n{system_prompt}\n")
        if history_messages:
            latest_msg = history_messages[-1]
            formatted_prompt.append(f"User Question:\n{latest_msg.get('content', '')}")

        # codex CLI는 -i/--image로 로컬 이미지를 직접 첨부할 수 있어, agy와 달리
        # 파일 경로를 프롬프트 텍스트에 안내할 필요 없이 파일만 저장해두면 된다.
        codex_image_path = _save_chat_capture_image(session_id, page_image_b64) if page_image_b64 else None

        chat_prompt = "\n".join(formatted_prompt)
        async for token in stream_codex(chat_prompt, model=model, session_id=session_id, is_chat=True, image_path=codex_image_path):
            yield token
        if include_full_context:
            _mark_chat_context_sent(session_id, "codex")
        return

    # Fallback to Ollama:
    ollama_messages = messages
    if page_image_b64 and messages and messages[-1]["role"] == "user":
        # Ollama /api/chat은 멀티모달(vision) 모델에 한해 메시지의 "images" 필드로
        # 로컬 이미지를 받는다(data URL 접두사 없는 raw base64). 첨부해도 현재
        # 설정된 CHAT_MODEL이 vision을 지원하지 않으면 이미지는 무시되거나
        # 모델에 따라 오류가 날 수 있다 - vision 지원 모델(gemma3/llava 등) 사용을
        # 전제로 한다.
        ollama_messages = messages[:-1] + [{**messages[-1], "images": [page_image_b64]}]

    payload = {
        "model": model,
        "messages": ollama_messages,
        "stream": True,
        "think": False,  # thinking 모드 비활성화 (속도 향상)
        "options": {
            "temperature": 0.5,
            "top_p": 0.9,
            "num_ctx": 16384,  # 논문 컨텍스트가 들어가므로 16k 컨텍스트 윈도우 사용
            "num_predict": 4096,
        },
    }

    try:
        async with httpx.AsyncClient(timeout=360.0) as client:
            async with client.stream(
                "POST",
                f"{get_ollama_host()}/api/chat",
                json=payload,
            ) as response:
                if response.status_code != 200:
                    body = await response.aread()
                    raise RuntimeError(
                        f"Ollama API 오류 (HTTP {response.status_code}): {body.decode()[:200]}"
                    )

                async for line in response.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        data = json.loads(line)

                        # 에러 응답 처리
                        if data.get("error"):
                            raise RuntimeError(f"Ollama 오류: {data['error']}")

                        # 결과 토큰 추출
                        message = data.get("message", {})
                        token = message.get("content", "")
                        if token:
                            yield token

                        if data.get("done", False):
                            break

                    except json.JSONDecodeError:
                        continue

    except httpx.ConnectError:
        raise RuntimeError(f"Ollama 서버에 연결할 수 없습니다. ({get_ollama_host()})")
    except httpx.TimeoutException:
        raise RuntimeError("답변 생성 시간이 초과되었습니다.")
    except httpx.HTTPStatusError as e:
        raise RuntimeError(f"Ollama HTTP 오류: {e.response.status_code}")



async def stream_page_insight(
    kind: str,
    text: str,
    target_lang: str,
    doc_title: str = "",
    session_id: str = None,
    document_mode: str = "research",
    document_type: str = "research_paper",
) -> AsyncGenerator[str, None]:
    """
    페이지 원문에서 키워드/전문용어 설명(kind='keywords') 또는 요약(kind='summary')을
    생성합니다. 읽기 분석 프로바이더/모델 설정을 사용한다 - 번역보다는
    "분석/설명" 작업에 가깝고, antigravity/claude_code처럼 세션이 지속되는 provider라면
    이미 채팅에서 쓰고 있는 문서당 공유 세션을 그대로 활용해 별도 세션을 만들지 않는다.
    단, 대화창에 노출되는 채팅 기록(chats 테이블)에는 남기지 않고 사용량 통계도
    "insight"로 별도 기록한다.
    """
    if kind == "keywords":
        instruction = (
            f"다음은 학술 논문 '{doc_title}'의 한 페이지 원문입니다. 이 텍스트에서 정말로 생소하거나 "
            f"고급 수준의 영단어(GRE 수준 이상)와, 이 논문의 세부 연구 분야에 특화된 전문용어·고유명사만 "
            f"중요도 순으로 최대 10개까지 골라주세요.\n\n"
            f"**절대 포함하지 말아야 할 것 (제외 기준)**: 이 분야를 공부하는 사람이라면 이미 당연히 아는 "
            f"기본적이고 흔한 용어는 절대 포함하지 마세요. 예를 들어:\n"
            f"- 일반적인 머신러닝/딥러닝 훈련 개념: epoch, batch size, learning rate, optimizer, loss "
            f"function, gradient, backpropagation, fine-tuning, cosine annealing scheduler, dropout, "
            f"overfitting, pretraining 같은 것들\n"
            f"- 일반적인 통계/수학 용어: mean, variance, standard deviation 같은 것들\n"
            f"- 논문에서 흔히 쓰이는 관용적 학술 표현: state-of-the-art, we propose, ablation study 같은 것들\n\n"
            f"**포함해야 할 것**: 이 논문의 좁은 세부 분야가 아니면 접하기 어려운 전문용어, 처음 보면 "
            f"이해하기 힘든 방법론명·모델명·데이터셋명 등의 고유명사, 또는 정말 어려운 수준의 영단어만 "
            f"선택하세요. 위 제외 기준에 해당하는지 애매하면 과감히 빼세요 - 개수가 적어도 괜찮습니다.\n\n"
            f"각 항목은 반드시 \"- **원어 용어**: {target_lang} 뜻풀이\" 형식으로만 출력하세요. 뜻풀이 뒤에 "
            f"\"(GRE 수준 단어)\", \"(전문용어)\"처럼 왜 이 용어를 골랐는지 분류/설명하는 괄호 주석을 "
            f"절대 덧붙이지 마세요 - 순수하게 용어와 뜻풀이만 적으세요. 서론이나 부연 설명도 절대 추가하지 "
            f"마세요. 위 기준을 만족하는 용어가 거의 없다면 목록 개수를 줄이거나, 정말 하나도 없으면 "
            f"\"이 페이지에는 특별히 짚을 전문용어/고급 어휘가 없습니다.\"라고만 "
            f"답하세요."
        )
    else:  # "summary"
        instruction = (
            f"다음은 학술 논문 '{doc_title}'의 한 페이지 원문입니다. 이 페이지의 핵심 내용을 "
            f"{target_lang}로 3~5문장 이내로 간결하게 요약해주세요. 서론이나 부연 설명 없이 "
            f"요약 내용만 즉시 출력하세요."
        )

    if document_mode == "general" and kind == "overview":
        instruction = (
            f"일반 문서 {doc_title!r}의 대표 구간을 분석해 문서 개요를 {target_lang}로 작성하세요. "
            "문서에 명시된 근거만 사용하고 모르는 항목은 빈 값으로 두세요. "
            "purpose(문서 목적), audience(예상 독자), structure(장·절 구성 문자열 배열), "
            "key_points(핵심 내용 최대 5개), prerequisites(전제 지식·설치/실행 조건), "
            "warnings(주의·금지·예외), metrics(보고서의 핵심 지표·결론), "
            "glossary(term과 definition 객체 배열)를 포함한 JSON 객체만 출력하세요. "
            "기술 문서·매뉴얼은 전제 조건과 경고를, 보고서는 지표와 결론을 우선하세요."
        )
    elif document_mode == "general" and kind == "keywords":
        instruction = (
            f"문서 페이지에서 실제로 등장한 고급 영어 어휘와 전문 키워드를 추출하세요. "
            f"고급 어휘는 SAT/GRE 또는 CEFR C1~C2 수준만 선택하고 적격 항목이 적으면 개수를 채우지 마세요. "
            f"기능어, 기초 어휘, 숫자, 단순 고유명사는 제외하고 같은 표제어는 하나로 합치세요. "
            f"기술 용어·제품명·API명은 technical_terms로 분리하세요. 각 항목은 term, lemma, part_of_speech, "
            f"meaning({target_lang}), example(원문 일부), level(SAT|GRE|SAT·GRE), char_start, char_end, occurrence, bbox(null)를 포함하세요. "
            f"원문에 없는 단어와 위치를 만들지 마세요. JSON 객체 {{\"advanced_words\": [], \"technical_terms\": []}}만 출력하세요."
        )
    elif document_mode == "general" and kind == "summary":
        instruction = (
            f"일반 문서 {doc_title!r}의 이 페이지를 {target_lang}로 3~5문장 이내로 요약하세요. "
            "절차, 요구사항, 예외, 경고, 수치와 조건을 우선하고 문서에 없는 내용을 추가하지 마세요."
        )

    from services.document_policy import COMMON_SAFETY_RULES
    prompt = f"{COMMON_SAFETY_RULES}\n{instruction}\n\n원문:\n{text}"

    provider = get_analysis_provider()
    model = get_analysis_model()

    if provider == "antigravity":
        async for token in stream_antigravity(prompt, model=model, session_id=session_id, usage_label="insight"):
            yield token
        return
    elif provider == "claude_code":
        async for token in stream_claude_code(prompt, model=model, session_id=session_id, usage_label="insight"):
            yield token
        return
    elif provider == "codex":
        async for token in stream_codex(prompt, model=model, session_id=session_id, usage_label="insight"):
            yield token
        return

    messages = [{"role": "user", "content": prompt}]
    if provider == "openai":
        async for token in stream_openai(messages, model=model, temperature=0.3):
            yield token
        return
    elif provider == "gemini":
        async for token in stream_gemini(messages, model=model, temperature=0.3):
            yield token
        return
    elif provider == "claude":
        async for token in stream_claude(messages, model=model, temperature=0.3):
            yield token
        return

    # Ollama 폴백
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
    }
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream("POST", f"{get_ollama_host()}/api/chat", json=payload) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                        token = data.get("message", {}).get("content", "")
                        if token:
                            yield token
                        if data.get("done", False):
                            break
                    except json.JSONDecodeError:
                        continue
    except httpx.ConnectError:
        raise RuntimeError(f"Ollama 서버에 연결할 수 없습니다. ({get_ollama_host()})")
    except httpx.TimeoutException:
        raise RuntimeError("답변 생성 시간이 초과되었습니다.")
    except httpx.HTTPStatusError as e:
        raise RuntimeError(f"Ollama HTTP 오류: {e.response.status_code}")


_PRIMER_LINE_RE = re.compile(
    r'^[\s\-\*>]*\**\s*(HOOK|LINEAGE|FEYNMAN|Q1|Q2|Q3|CHECK1|CHECK2|CHECK3|'
    r'HYPOTHESIS1|HYPOTHESIS2|HYPOTHESIS3|METHOD1|METHOD2|METHOD3|'
    r'RESULT1|RESULT2|RESULT3|GLOSSARY1|GLOSSARY2|GLOSSARY3|GLOSSARY4|GLOSSARY5|'
    r'REC1|REC2|REC3|REC4|REC5)\**\s*[:.\)]\s*(.+)$',
    re.IGNORECASE,
)


async def generate_reading_primer(
    title: str,
    sections: dict,
    candidate_terms: list,
    target_lang: str = "한국어",
    session_id: str = None,
) -> dict:
    """
    논문 제목과 섹션별 발췌(services.section_parser.detect_sections 결과)로 "읽기 전
    브리핑" 콘텐츠를 생성합니다: 훅 문장, 연구 계보(LINEAGE), 파인만 기법 설명(FEYNMAN),
    예측 질문 3개, 체크리스트 3개, 가설/실험/결과 흐름 최대 3세트, 논문 고유 용어집 최대
    5개, 관련 논문 추천 최대 5개. 채팅(Chat) 프로바이더/모델 설정을 재사용하며,
    stream_page_insight와 마찬가지로 세션이 지속되는 CLI provider는 번역/채팅/인사이트와
    동일한 문서당 공유 세션(session_id)을 그대로 사용합니다.

    이전에는 인트로 2페이지(3000자)만 봤지만, 계보(기존 한계→해결)와 실험 흐름을 뽑아
    내려면 서론만으로는 근거가 부족하다. section_parser가 논문 전체를 스캔해 서론/관련
    연구, 방법론/실험 결과, 결론 세 버킷으로 미리 압축해 넘겨주므로, 여기서는 원문
    전체를 그대로 프롬프트에 넣지 않고도 전체 문서 맥락을 반영할 수 있다.

    용어집(GLOSSARY)은 term_extractor가 정규식으로 뽑은 "논문 고유 용어 후보"를 참고
    자료로 제공하고, 이 논문이 실제로 새로 정의한 용어인지 최종 판단은 LLM에 맡긴다 -
    후보 추출은 재현율을 우선하므로 흔한 배경지식 용어(CNN 등)가 섞여 들어올 수 있어,
    프롬프트에서 배경지식 용어는 제외하라고 명시한다.

    관련 논문은 이 논문의 참고문헌 목록을 텍스트로 기계적으로 매칭하지 않고, LLM이 자기
    지식으로 직접 추천하게 한다 - 참고문헌 목록 매칭 방식은 인용 형식이 지저분하거나
    따옴표로 감싼 제목이 없는 스타일이면 매칭 개수가 너무 적고, 매칭되더라도 이 논문의
    참고문헌으로 한정돼 "관련성"이 아니라 "우연히 잘 파싱된 것"에 가까웠다. LLM 추천은
    환각 위험이 있으므로, 호출부(primer.py)에서 실제로 존재하는 논문인지 OpenAlex로
    다시 검증한 뒤에만 채택한다.
    """
    instruction = (
        f"다음은 학술 논문 '{title}'에서 발췌한 원문입니다. 이 논문을 읽기 전 독자가 "
        f"호기심을 갖고 몰입하며 스스로 학습하고 인사이트를 얻을 수 있도록 아래 형식에 "
        f"맞춰 {target_lang}로 작성해주세요.\n\n"
        f"- 약어 표기 규칙(아래 모든 항목 공통): 약어나 두문자어(예: CNN, RAG, SOTA, LLM)를 "
        f"사용할 때는 반드시 처음 등장하는 자리에서 그 뒤에 괄호로 전체 명칭을 함께 "
        f"표기하세요(예: \"CNN(합성곱 신경망)\"). 이미 널리 알려진 약어라도 예외 없이 "
        f"전체 명칭을 병기하세요.\n"
        f"- HOOK: 이 논문이 다루는 문제를 흥미로운 질문 형태로 재구성한 한두 문장. 초록을 "
        f"그대로 요약하지 말고 \"왜 이 문제가 어려운가/왜 흥미로운가\"를 짚어 궁금증을 유발하세요.\n"
        f"- LINEAGE: 기존 접근법이 어떤 한계를 가지고 있었고, 이 논문이 그 한계를 어떻게 "
        f"해결해서 어떤 성능/결과 개선을 이뤘는지를 \"기존에는 ~해서 ~한계가 있었는데, 이 "
        f"논문은 ~함으로써 ~했다\" 형태의 발전 계보로 2~3문장에 담으세요. 줄바꿈 없이 한 "
        f"줄로 쓰세요.\n"
        f"- FEYNMAN: 전문용어를 최대한 배제하고 일상적인 비유를 사용해 이 논문의 핵심 "
        f"아이디어를 비전문가에게 설명하듯 2~4문장으로 쉽게 풀어 쓰세요(파인만 기법). "
        f"줄바꿈 없이 한 줄로 쓰세요.\n"
        f"- Q1/Q2/Q3: 독자가 본문을 읽기 전 스스로 답을 예측해볼 만한 질문 3개. 각각 한 문장.\n"
        f"- CHECK1/CHECK2/CHECK3: 본문을 읽는 동안 확인하면 좋을 구체적인 포인트(예: 비교 대상, "
        f"핵심 수치, 한계점 등) 3개. 각각 한 문장.\n"
        f"- HYPOTHESIS1~3/METHOD1~3/RESULT1~3: 저자가 세운 가설, 그것을 검증하기 위해 "
        f"설계한 실험/방법, 실제로 나온 결과를 최대 3개 세트로 정리하세요. 한 세트는 "
        f"HYPOTHESIS/METHOD/RESULT를 모두 채워야 하고, 각각 한 문장입니다. 근거가 2세트뿐 "
        f"이면 2세트만 쓰고 3번째 세트는 통째로 생략하세요.\n"
        f"- GLOSSARY1~5: 아래 '용어 후보' 목록을 참고해, 이 논문이 새로 만들었거나 이 "
        f"논문의 맥락에서만 특별한 의미로 쓰이는 용어만 골라 쉬운 말로 정의하세요. "
        f"Convolutional Neural Network, GPU처럼 이미 널리 알려진 일반 배경지식 용어는 "
        f"절대 포함하지 마세요. 새로 만든 용어가 없다고 판단되면 GLOSSARY 항목을 하나도 "
        f"쓰지 마세요. 형식: \"GLOSSARY1: 용어 :: 정의(한 문장)\"\n"
        f"- REC1~REC5: 이 논문을 이해하는 데 도움이 되는, 실제로 존재하는 유명하거나 핵심적인 "
        f"관련/선행 연구 논문 제목을 최대 5개까지 추천하세요. 반드시 실존하는 논문의 정확한 "
        f"원제(영어 원문 그대로, 번역하지 말 것)만 쓰고, 확신이 없거나 제목이 정확히 기억나지 "
        f"않으면 억지로 채우지 말고 그 줄은 생략하세요. 각 줄에는 논문 제목만 쓰고 저자·연도· "
        f"설명은 붙이지 마세요.\n\n"
        f"반드시 아래 형식으로만 출력하세요(HYPOTHESIS/METHOD/RESULT, GLOSSARY, REC 항목은 "
        f"확신하는 만큼만 채우고 나머지는 통째로 생략). 다른 설명이나 서론은 절대 추가하지 "
        f"마세요.\n"
        f"HOOK: <내용>\nLINEAGE: <내용>\nFEYNMAN: <내용>\nQ1: <내용>\nQ2: <내용>\nQ3: <내용>\n"
        f"CHECK1: <내용>\nCHECK2: <내용>\nCHECK3: <내용>\nHYPOTHESIS1: <내용>\nMETHOD1: <내용>\n"
        f"RESULT1: <내용>\n...\nGLOSSARY1: <용어> :: <정의>\n...\nREC1: <논문 원제>\n..."
    )

    context_parts = []
    if sections.get("intro_related"):
        context_parts.append(f"[서론/관련 연구 발췌]\n{sections['intro_related']}")
    if sections.get("method_results"):
        context_parts.append(f"[방법론/실험 결과 발췌]\n{sections['method_results']}")
    if sections.get("conclusion"):
        context_parts.append(f"[결론 발췌]\n{sections['conclusion']}")
    context_text = "\n\n".join(context_parts)

    terms_text = ""
    if candidate_terms:
        term_lines = [f"- {t['term']}: \"...{t['context_sentence']}...\"" for t in candidate_terms]
        terms_text = "\n\n[용어 후보]\n" + "\n".join(term_lines)

    prompt = f"{instruction}\n\n원문 발췌:\n{context_text}{terms_text}"

    provider = get_analysis_provider()
    model = get_analysis_model()

    # 브리핑은 계보/파인만/실험 흐름/용어집까지 한 번에 뽑아내느라 항목이 많아,
    # 사용자가 채팅용으로 설정해둔 effort를 그대로 쓰면 CLI가 오래 침묵하다 stall
    # 타임아웃(120초)에 걸리는 경우가 실측됐다. claude_code/codex는 "모델|effort"
    # 파이프 표기를 지원해 --effort를 별도로 얹어도 안전하지만, antigravity는
    # (Gemini Flash 계열처럼) effort가 모델 이름 자체에 이미 포함된 경우가 있어
    # --effort를 별도로 얹으면 "--effort is not supported for model ..."로 CLI가
    # 즉시 거부한다 - 실제로 이 때문에 매 폴링(3초)마다 즉시 실패·재시도가
    # 반복되어 백엔드 CPU를 독점하는 장애가 있었다. 그래서 antigravity에는
    # effort를 강제하지 않고 사용자가 설정한 모델/effort를 그대로 쓴다.
    PRIMER_EFFORT = "low"

    async def _call_once() -> str:
        tokens = []
        if provider == "antigravity":
            async for token in stream_antigravity(prompt, model=model, session_id=session_id, usage_label="primer"):
                tokens.append(token)
        elif provider == "claude_code":
            async for token in stream_claude_code(prompt, model=model, session_id=session_id, usage_label="primer", effort_override=PRIMER_EFFORT):
                tokens.append(token)
        elif provider == "codex":
            async for token in stream_codex(prompt, model=model, session_id=session_id, usage_label="primer", effort_override=PRIMER_EFFORT):
                tokens.append(token)
        elif provider in ("openai", "gemini", "claude"):
            messages = [{"role": "user", "content": prompt}]
            if provider == "openai":
                async for token in stream_openai(messages, model=model, temperature=0.5):
                    tokens.append(token)
            elif provider == "gemini":
                async for token in stream_gemini(messages, model=model, temperature=0.5):
                    tokens.append(token)
            else:
                async for token in stream_claude(messages, model=model, temperature=0.5):
                    tokens.append(token)
        else:
            # Ollama 폴백
            payload = {
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
                # num_predict을 지정하지 않으면 모델이 지시를 벗어나 장황하게
                # 늘어지는 경우 생성이 끝없이 길어져 아래 타임아웃까지 그대로
                # 소모할 수 있다(실측: 로컬 8~9B 모델에서 360초 타임아웃을 실제로
                # 초과하는 경우를 확인). 항목이 최대 28줄인 이 응답 형식은 2048
                # 토큰이면 충분히 넉넉하므로 상한을 걸어 최악의 경우를 방지한다.
                "options": {"temperature": 0.5, "num_ctx": 16384, "num_predict": 2048},
            }
            # LINEAGE/FEYNMAN/실험 흐름/용어집이 추가되며 응답 항목이 늘어나
            # 로컬 CPU/GPU 환경에서 1~3분씩 걸리는 경우를 실측했다 - 기존
            # 360초보다 여유를 더 둔다(위 num_predict 상한과 함께 이중 안전장치).
            async with httpx.AsyncClient(timeout=480.0) as client:
                resp = await client.post(f"{get_ollama_host()}/api/chat", json=payload)
                resp.raise_for_status()
                data = resp.json()
                tokens.append(data.get("message", {}).get("content", ""))
        return "".join(tokens)

    def _parse(raw: str) -> dict:
        result = {
            "hook": "",
            "lineage": "",
            "feynman": "",
            "questions": [],
            "checklist": [],
            "experiment_flow": [],
            "glossary": [],
            "recommended_titles": [],
        }
        hypotheses, methods, results = {}, {}, {}
        for line in raw.splitlines():
            m = _PRIMER_LINE_RE.match(line.strip())
            if not m:
                continue
            key, value = m.group(1).upper(), m.group(2).strip().rstrip('*').strip()
            if key == "HOOK":
                result["hook"] = value
            elif key == "LINEAGE":
                result["lineage"] = value
            elif key == "FEYNMAN":
                result["feynman"] = value
            elif key in ("Q1", "Q2", "Q3"):
                result["questions"].append(value)
            elif key.startswith("CHECK"):
                result["checklist"].append(value)
            elif key.startswith("HYPOTHESIS"):
                hypotheses[key[-1]] = value
            elif key.startswith("METHOD"):
                methods[key[-1]] = value
            elif key.startswith("RESULT"):
                results[key[-1]] = value
            elif key.startswith("GLOSSARY"):
                if "::" in value:
                    term, _, definition = value.partition("::")
                    term, definition = term.strip(), definition.strip()
                    if term and definition:
                        result["glossary"].append({"term": term, "definition": definition})
            elif key.startswith("REC"):
                result["recommended_titles"].append(value)

        for idx in ("1", "2", "3"):
            if idx in hypotheses and idx in methods and idx in results:
                result["experiment_flow"].append({
                    "hypothesis": hypotheses[idx],
                    "method": methods[idx],
                    "result": results[idx],
                })
        return result

    # CLI 기반 provider(특히 claude_code)가 드물게 지시를 완전히 무시하고 입력
    # 원문 일부를 그대로 돌려주는 현상을 실측으로 확인했다(같은 프롬프트를 5번
    # 중 3번꼴로 실패, 재시도하면 정상 응답). 파싱 결과가 통째로 비어있으면(형식이
    # 하나도 안 맞았다는 뜻) 한 번만 더 시도한다 - 매번 재시도하면 정상적으로
    # "REC 항목 없음"처럼 일부만 비는 경우까지 불필요하게 다시 호출하게 되므로,
    # 완전 실패로 보이는 경우로만 좁힌다.
    result = _parse(await _call_once())
    if not any((result["hook"], result["questions"], result["checklist"], result["recommended_titles"])):
        result = _parse(await _call_once())
    return result


_SUGGESTED_QUESTION_LINE_RE = re.compile(r'^[\s\-\*>]*\**\s*(SQ1|SQ2|SQ3)\**\s*[:.\)]\s*(.+)$', re.IGNORECASE)


async def generate_suggested_questions(
    paper_text: str,
    history_messages: list,
    doc_title: str = "",
    session_id: str = None,
    document_mode: str = "research",
    document_type: str = "research_paper",
) -> list:
    """
    직전 어시스턴트 답변까지의 대화 흐름과 논문 본문 일부를 참고해, 사용자가 이어서
    물어볼 만한 후속 질문 3개를 생성합니다. 채팅(Chat) 프로바이더/모델 설정을 그대로
    재사용하며, generate_reading_primer와 동일하게 세션이 지속되는 CLI provider는
    채팅과 동일한 문서당 공유 세션(session_id)을 사용합니다. 챗 답변 자체가 아니라
    보조 UI(추천 질문 칩)용 생성이므로 채팅 기록(chats 테이블)에는 남기지 않습니다.
    """
    convo_lines = []
    for msg in history_messages[-6:]:
        role_label = "사용자" if msg.get("role") == "user" else "어시스턴트"
        content = (msg.get("content") or "").strip()
        if content:
            convo_lines.append(f"{role_label}: {content[:800]}")
    convo_text = "\n".join(convo_lines)

    from services.document_policy import COMMON_SAFETY_RULES, get_policy
    policy = get_policy(document_mode, document_type)
    noun = "학술 논문" if document_mode == "research" else "문서"
    action_hint = ", ".join(policy.quick_actions)
    instruction = (
        f"{COMMON_SAFETY_RULES}\n다음은 {noun} '{doc_title}'을 읽으며 사용자와 AI 어시스턴트가 나눈 대화입니다. "
        f"이 대화의 마지막 어시스턴트 답변을 참고해, 사용자가 이어서 궁금해할 만한 자연스러운 "
        f"후속 질문을 정확히 3개 제안하세요.\n\n"
        f"- 각 질문은 아래 {noun} 본문 발췌 내용에 근거해 답할 수 있는 구체적인 질문이어야 합니다.\n"
        f"- 방금 나온 답변을 반복하지 말고 문서 종류에 맞는 관점으로 확장하세요. "
        f"권장 관점: {action_hint}.\n"
        f"- 각 질문은 물음표로 끝나는 한 문장의 자연스러운 한국어 질문으로, 서로 겹치지 않게 "
        f"작성하세요.\n\n"
        f"반드시 아래 형식으로만 출력하고 다른 설명이나 서론은 절대 추가하지 마세요.\n"
        f"SQ1: <질문>\nSQ2: <질문>\nSQ3: <질문>"
    )

    prompt = f"{instruction}\n\n[{noun} 본문 발췌]\n{paper_text[:6000]}\n\n[대화 내역]\n{convo_text}"

    provider = get_chat_provider()
    model = get_chat_model()

    async def _call_once() -> str:
        tokens = []
        if provider == "antigravity":
            async for token in stream_antigravity(prompt, model=model, session_id=session_id, usage_label="suggestions"):
                tokens.append(token)
        elif provider == "claude_code":
            async for token in stream_claude_code(prompt, model=model, session_id=session_id, usage_label="suggestions"):
                tokens.append(token)
        elif provider == "codex":
            async for token in stream_codex(prompt, model=model, session_id=session_id, usage_label="suggestions"):
                tokens.append(token)
        elif provider in ("openai", "gemini", "claude"):
            messages = [{"role": "user", "content": prompt}]
            if provider == "openai":
                async for token in stream_openai(messages, model=model, temperature=0.6):
                    tokens.append(token)
            elif provider == "gemini":
                async for token in stream_gemini(messages, model=model, temperature=0.6):
                    tokens.append(token)
            else:
                async for token in stream_claude(messages, model=model, temperature=0.6):
                    tokens.append(token)
        else:
            # Ollama 폴백
            payload = {
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
                "options": {"temperature": 0.6, "num_ctx": 8192, "num_predict": 512},
            }
            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(f"{get_ollama_host()}/api/chat", json=payload)
                resp.raise_for_status()
                data = resp.json()
                tokens.append(data.get("message", {}).get("content", ""))
        return "".join(tokens)

    raw = await _call_once()
    questions = []
    for line in raw.splitlines():
        m = _SUGGESTED_QUESTION_LINE_RE.match(line.strip())
        if m:
            q = m.group(2).strip().rstrip('*').strip()
            if q:
                questions.append(q)
    return questions[:3]


async def check_ollama_health() -> dict:
    """Ollama 서버 상태를 확인합니다."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{get_ollama_host()}/api/tags")
            resp.raise_for_status()
            models = [m["name"] for m in resp.json().get("models", [])]
            # Ollama를 번역이나 채팅 둘 중 하나에서 쓰고 있다면 그 모델이 있는지 점검
            check_model = get_trans_model() if get_trans_provider() == "ollama" else get_chat_model()
            model_available = any(check_model in m for m in models)
            return {
                "status": "ok",
                "model_available": model_available,
                "available_models": models,
            }
    except Exception as e:
        return {"status": "error", "detail": str(e), "model_available": False}


# 문서(session_id)당 하나의 Claude Code 대화 세션만 사용하도록 직렬화하는 락.
# 번역/채팅/카테고리 태깅 호출이 모두 같은 --session-id를 공유하므로,
# 동시 호출이 세션 생성/재개 순서를 어긋나게 하지 않도록 보장한다.
_claude_code_session_locks: dict = {}


def _get_claude_code_session_lock(session_id: str):
    import asyncio
    if not session_id:
        return asyncio.Lock()
    if session_id not in _claude_code_session_locks:
        _claude_code_session_locks[session_id] = asyncio.Lock()
    return _claude_code_session_locks[session_id]


async def stream_claude_code(prompt: str, model: str = None, session_id: str = None, is_chat: bool = False, usage_label: str = None, effort_override: str = None) -> AsyncGenerator[str, None]:
    import asyncio
    import os
    import codecs
    from config import LIBRARY_DIR

    claude_path = get_claude_code_path()
    if not os.path.exists(claude_path):
        claude_path = "claude"

    # 세션(session_id)마다 project root가 아니라 그 문서 전용 격리 폴더
    # (LIBRARY_DIR/{session_id} - document.pdf/번역 캐시/채팅 캡처 이미지가
    # 이미 저장되는 바로 그 폴더)를 cwd로 쓴다. project root를 그대로 cwd로
    # 쓰면서 Read 도구를 켜면 .env를 포함한 프로젝트 전체 파일에 접근 가능해져
    # (실측 확인됨) 캡처 이미지 하나만 안전하게 읽게 할 방법이 없었다 - 이제
    # cwd 자체가 이 문서 데이터만 있는 폴더로 격리되므로, 악성 PDF의 프롬프트
    # 인젝션이 Read 도구를 쓰게 만들어도 이 문서 자신의 데이터 밖으로는 못
    # 나간다. LIBRARY_DIR는 Tauri 패키징 앱에서 app_data_dir/library(항상
    # 쓰기 가능한 OS별 사용자 데이터 디렉토리)로 주입되므로, 사실상 폴백 값일
    # 뿐인 project root보다 오히려 더 안전하다.
    if session_id:
        session_cwd = os.path.abspath(os.path.join(LIBRARY_DIR, session_id))
        os.makedirs(session_cwd, exist_ok=True)
    else:
        session_cwd = get_project_root()

    # --print - : stdin으로 프롬프트를 받아 처리 (--print 인자로 넘기면 Claude가 수학 기호를 _MB_N 으로 치환하는 버그 발생)
    #
    # --permission-mode dontAsk는 비대화형 실행에 필수(TTY 없이 승인 프롬프트를
    # 띄우면 그냥 멈춘다)이지만, 이것만 있으면 세션이 Bash/Write/Edit 등 모든
    # 도구를 승인 없이 실제로 실행할 수 있게 된다. cwd가 위에서 문서 전용 폴더로
    # 격리되어 있으므로 Read 도구만 열어(캡처 이미지 첨부 질문에 실제로 답할 수
    # 있어야 하니) 나머지(Bash/Write/Edit 등)는 여전히 막아둔다 - 격리 폴더
    # 안에도 굳이 실행/수정 도구까지 열어줄 이유는 없다.
    base_cmd = [claude_path, "--permission-mode", "dontAsk", "--tools", "Read", "--output-format", "text", "--print", "-"]

    # Prepare custom HOME for Claude Code session isolation to prevent concurrent locks
    env = get_agy_env()
    if session_id:
        import shutil
        cache_dir = os.path.join(get_project_root(), "cache")
        home_dir = os.path.join(cache_dir, f"claude_home_{session_id}")
        claude_dir = os.path.join(home_dir, ".claude")
        os.makedirs(claude_dir, exist_ok=True)

        orig_credentials = os.path.expanduser("~/.claude/.credentials.json")
        dest_credentials = os.path.join(claude_dir, ".credentials.json")
        if os.path.exists(orig_credentials) and not os.path.exists(dest_credentials):
            shutil.copy2(orig_credentials, dest_credentials)

        orig_settings = os.path.expanduser("~/.claude/settings.json")
        dest_settings = os.path.join(claude_dir, "settings.json")
        if os.path.exists(orig_settings) and not os.path.exists(dest_settings):
            shutil.copy2(orig_settings, dest_settings)

        # ~/.claude/ 안의 credentials/settings만으로는 부족하다 - 최신 Claude Code CLI는
        # 최상위 ~/.claude.json(계정/세션 메타데이터)도 있어야 로그인 상태로 인식한다.
        # 이게 빠지면 격리된 $HOME에서는 자격증명을 그대로 복사해도 "Not logged in"으로
        # 실패한다.
        orig_top_level_config = os.path.expanduser("~/.claude.json")
        dest_top_level_config = os.path.join(home_dir, ".claude.json")
        if os.path.exists(orig_top_level_config) and not os.path.exists(dest_top_level_config):
            shutil.copy2(orig_top_level_config, dest_top_level_config)

        env["HOME"] = home_dir

    # model 값이 'sonnet|high' 처럼 파이프(|)로 모델과 effort를 구분할 수 있음
    model_name = None
    effort_level = None
    if model and model.strip() and model.strip().lower() not in ["custom", "default"]:
        raw = model.strip()
        if "|" in raw:
            parts = raw.split("|", 1)
            model_name = parts[0].strip() or None
            effort_level = parts[1].strip() or None
        else:
            model_name = raw

    # 호출부가 명시적으로 요청한 effort는 모델 문자열에 파이프로 박아둔 값보다
    # 우선한다(예: primer 생성은 사용자가 설정한 채팅 모델/effort와 무관하게
    # 항상 낮은 effort로 빠르게 생성하고 싶을 때 사용).
    if effort_override:
        effort_level = effort_override

    if model_name:
        base_cmd.extend(["--model", model_name])
    if effort_level:
        base_cmd.extend(["--effort", effort_level])

    # 한 문서(session_id)는 하나의 Claude Code 세션만 사용한다:
    # 처음에는 --resume으로 기존 세션 이어붙이기를 시도하고, 세션이 아직 없으면(최초 호출)
    # "No conversation found" 에러를 받고 --session-id로 새로 생성한다.
    # 같은 --session-id로 두 번 세션을 생성하려 하면 CLI가 즉시
    # "Session ID ... is already in use" 에러로 죽기 때문에, 최초 1회를 제외하고는
    # 항상 --resume을 써야 한다.
    session_flag = ["--resume", session_id] if session_id else []

    lock = _get_claude_code_session_lock(session_id)
    async with lock:
        # 락을 기다리는 동안 앞선 호출이 last_provider를 갱신했을 수 있으므로,
        # 실제 요청 직전에 전환 여부와 캐치업 문맥을 계산한다.
        last_provider = get_last_provider(session_id)
        provider_switched = last_provider is not None and last_provider != "claude_code"
        catchup_prefix = _build_catchup_prefix(session_id) if (is_chat and provider_switched) else ""

        # 프롬프트에 직접 출력 포맷 지시 추가 (뷰어가 markdown+LaTeX를 렌더링하므로 그대로 출력 허용)
        guided_prompt = (
            "You are a direct-output translation/QA assistant. "
            "Output ONLY the result — no preambles, no explanations, no commentary. "
            "You MAY use markdown and LaTeX ($...$, $$...$$) in your output since the viewer renders them. "
            "Do NOT wrap math variables in placeholder tokens — preserve them as-is or wrap in $...$. "
            "Start the output immediately.\n\n"
            f"{catchup_prefix}{prompt}"
        )
        encoded_prompt = guided_prompt.encode("utf-8")

        for attempt in range(2):
            cmd = base_cmd + session_flag
            try:
                process = await asyncio.create_subprocess_exec(
                    *_exec_args(cmd),
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=env,
                    cwd=session_cwd
                )
                stderr_task = _start_stderr_drain(process)

                process.stdin.write(encoded_prompt)
                await process.stdin.drain()
                process.stdin.close()

                decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
                produced_output = False

                while True:
                    chunk = await _read_chunk_with_timeout(process, label="Claude Code CLI")
                    if not chunk:
                        break
                    decoded = decoder.decode(chunk)
                    if decoded:
                        produced_output = True
                        yield decoded

                final_decoded = decoder.decode(b"", final=True)
                if final_decoded:
                    produced_output = True
                    yield final_decoded

                await _wait_with_timeout(process, label="Claude Code CLI")

                if process.returncode == 0:
                    try:
                        from services.usage_tracker import record_call
                        record_call(usage_label or ("translate" if not is_chat else "chat"))
                    except Exception:
                        pass
                    # provider_switched였을 때만이 아니라 매번 기록해야 한다 - 그래야
                    # antigravity를 한 번도 안 써서 ai_session.json이 아예 없던
                    # claude_code 전용 문서도 "claude_code가 마지막으로 썼다"는
                    # 기록이 남아, 나중에 antigravity로 바꿨을 때 그 전환을
                    # 올바르게 감지해 캐치업 문맥을 붙일 수 있다.
                    if session_id:
                        save_provider_session_meta(session_id, provider="claude_code")
                    return

                stderr_out = await _finish_stderr_drain(stderr_task)

                # --resume 대상 세션이 아직 존재하지 않는 최초 호출인 경우에만
                # --session-id로 세션을 새로 만들며 1회 재시도한다. (provider가
                # 바뀐 경우뿐 아니라, cwd를 project root에서 문서별 격리
                # 폴더로 바꾸는 배포 시점처럼 이전에 다른 cwd에서 만들어진
                # 세션이라 이번 cwd에서는 못 찾는 경우도 여기로 들어온다.)
                if (
                    not produced_output
                    and attempt == 0
                    and session_flag[:1] == ["--resume"]
                    and "No conversation found" in stderr_out
                ):
                    session_flag = ["--session-id", session_id]
                    # 위의 provider_switched 캐치업과 동일한 이유: 새로 만드는
                    # 세션은 이전 대화 내용을 전혀 모르므로, catchup_prefix가
                    # 아직 안 붙어 있었다면(= provider_switched로는 감지되지
                    # 않았던 케이스) 여기서 DB 채팅 이력을 붙여 대화가 끊긴
                    # 것처럼 보이지 않게 한다.
                    if is_chat and not catchup_prefix:
                        catchup_prefix = _build_catchup_prefix(session_id)
                        guided_prompt = (
                            "You are a direct-output translation/QA assistant. "
                            "Output ONLY the result — no preambles, no explanations, no commentary. "
                            "You MAY use markdown and LaTeX ($...$, $$...$$) in your output since the viewer renders them. "
                            "Do NOT wrap math variables in placeholder tokens — preserve them as-is or wrap in $...$. "
                            "Start the output immediately.\n\n"
                            f"{catchup_prefix}{prompt}"
                        )
                        encoded_prompt = guided_prompt.encode("utf-8")
                    continue

                logger.error(f"Claude Code CLI 실패: code={process.returncode} stderr={stderr_out}")
                # 실패를 조용히 삼키고 그냥 return하면, 호출부는 빈 결과를 "정상
                # 번역 완료"로 착각해 빈 문자열을 캐시에 영구 저장해버린다.
                # 예외를 던져서 라우터/job 쪽의 기존 실패 처리 로직(에러 응답,
                # failed_pages 기록 등)이 실제로 작동하게 한다.
                raise RuntimeError(
                    f"Claude Code CLI 실행 실패 (code={process.returncode}): "
                    f"{stderr_out.strip()[:500] or '알 수 없는 오류'}"
                )
            except Exception as e:
                logger.error(f"Claude Code CLI 실행 예외: {e}")
                raise


_codex_session_locks = {}

def _get_codex_session_lock(session_id: str) -> asyncio.Lock:
    if not session_id:
        return asyncio.Lock()
    if session_id not in _codex_session_locks:
        _codex_session_locks[session_id] = asyncio.Lock()
    return _codex_session_locks[session_id]


async def stream_codex(prompt: str, model: str = None, session_id: str = None, is_chat: bool = False, usage_label: str = None, effort_override: str = None, image_path: str = None) -> AsyncGenerator[str, None]:
    """Codex CLI(`codex exec`)로 번역/채팅/인사이트를 생성합니다.

    codex exec --json은 claude/antigravity와 달리 토큰 단위 스트리밍을 제공하지
    않고, 한 턴이 끝나면 완성된 메시지를 item.completed 이벤트 하나로 통째로
    내려준다. 그래서 응답을 받은 뒤 작은 조각으로 나눠 짧은 지연을 두고
    순차적으로 yield해 다른 provider와 동일한 점진적 스트리밍 UX를 흉내낸다.
    """
    import asyncio
    import os
    from config import LIBRARY_DIR

    codex_path = get_codex_path()
    if not os.path.exists(codex_path):
        codex_path = "codex"

    env = get_agy_env()

    # project root 대신 문서 전용 격리 폴더(LIBRARY_DIR/{session_id})를 cwd로
    # 쓴다 - sandbox_mode=read-only라 하더라도 cwd 하위 파일을 읽을 수는 있어,
    # project root를 그대로 두면 .env까지 그 범위 안에 들어간다. codex의
    # resume은 cwd가 달라져도 대화 내용을 그대로 유지하는 것을 실측으로
    # 확인했으므로 안전하게 바꿀 수 있다. LIBRARY_DIR는 Tauri 패키징 앱에서
    # app_data_dir/library로 주입되므로 이 편이 project root보다 더 안전하다.
    if session_id:
        session_cwd = os.path.abspath(os.path.join(LIBRARY_DIR, session_id))
        os.makedirs(session_cwd, exist_ok=True)
    else:
        session_cwd = get_project_root()

    # model 값이 'gpt-5.6-terra|high'처럼 파이프(|)로 모델과 reasoning effort를 구분할 수 있음
    model_name = None
    effort_level = None
    if model and model.strip() and model.strip().lower() not in ["custom", "default"]:
        raw = model.strip()
        if "|" in raw:
            parts = raw.split("|", 1)
            model_name = parts[0].strip() or None
            effort_level = parts[1].strip() or None
        else:
            model_name = raw

    # 호출부가 명시적으로 요청한 effort는 모델 문자열에 파이프로 박아둔 값보다 우선한다.
    if effort_override:
        effort_level = effort_override

    def build_cmd(resume_id):
        cmd = [codex_path, "exec"]
        if resume_id:
            cmd += ["resume", resume_id]
        # 순수 텍스트 생성 용도이므로 파일 수정/명령 실행 권한이 필요 없다 -
        # 혹시라도 모델이 툴을 사용하려 들 경우를 대비해 read-only 샌드박스로 제한한다.
        # (`-s/--sandbox`는 `codex exec resume` 서브커맨드에서는 지원되지 않으므로,
        # resume에도 공통으로 통하는 `-c sandbox_mode=` config override를 사용한다.)
        cmd += ["--json", "--skip-git-repo-check", "-c", "sandbox_mode=read-only"]
        if model_name:
            cmd += ["-m", model_name]
        if effort_level:
            cmd += ["-c", f"model_reasoning_effort={effort_level}"]
        # codex CLI는 -i/--image로 로컬 이미지 파일을 프롬프트에 직접 첨부하는
        # 기능을 공식 지원한다(exec, exec resume 서브커맨드 모두). agy처럼 모델이
        # 파일 도구로 직접 열어보게 유도할 필요 없이, CLI 자체가 이미지를 읽어
        # 메시지에 실어 보내므로 sandbox_mode=read-only와도 무관하게 안전하다.
        if image_path:
            cmd += ["-i", image_path]
        cmd += ["-"]
        return cmd

    # 한 문서(session_id)는 하나의 Codex 세션(thread)만 사용한다: resume 대상
    # thread가 더 이상 존재하지 않으면(세션 파일 소실 등) 새 세션으로 1회 재시도한다.
    lock = _get_codex_session_lock(session_id)
    async with lock:
        # 락을 기다리는 동안 앞선 호출이 새 thread를 만들었을 수 있으므로,
        # 실제 요청 직전에 provider별 메타데이터를 조회한다.
        last_provider = get_last_provider(session_id)
        provider_switched = last_provider is not None and last_provider != "codex"
        provider_meta = get_provider_session_meta(session_id, "codex")
        thread_id = provider_meta.get("conversation_id") if provider_meta else None
        catchup_prefix = _build_catchup_prefix(session_id) if (is_chat and provider_switched) else ""

        # 프롬프트에 직접 출력 포맷 지시 추가 (뷰어가 markdown+LaTeX를 렌더링하므로 그대로 출력 허용)
        guided_prompt = (
            "You are a direct-output translation/QA assistant. "
            "Output ONLY the result — no preambles, no explanations, no commentary. "
            "You MAY use markdown and LaTeX ($...$, $$...$$) in your output since the viewer renders them. "
            "Do NOT wrap math variables in placeholder tokens — preserve them as-is or wrap in $...$. "
            "Start the output immediately.\n\n"
            f"{catchup_prefix}{prompt}"
        )
        encoded_prompt = guided_prompt.encode("utf-8")

        for attempt in range(2):
            cmd = build_cmd(thread_id)
            try:
                process = await asyncio.create_subprocess_exec(
                    *_exec_args(cmd),
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=env,
                    cwd=session_cwd
                )
                stderr_task = _start_stderr_drain(process)

                process.stdin.write(encoded_prompt)
                await process.stdin.drain()
                process.stdin.close()

                new_thread_id = None
                message_parts = []

                while True:
                    line = await _readline_with_timeout(process, label="Codex CLI")
                    if not line:
                        break
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    ev_type = event.get("type")
                    if ev_type == "thread.started":
                        new_thread_id = event.get("thread_id")
                    elif ev_type == "item.completed":
                        item = event.get("item") or {}
                        if item.get("type") == "agent_message":
                            text = item.get("text") or ""
                            if text:
                                message_parts.append(text)

                await _wait_with_timeout(process, label="Codex CLI")
                final_text = "".join(message_parts)

                if process.returncode == 0 and final_text:
                    try:
                        from services.usage_tracker import record_call
                        record_call(usage_label or ("translate" if not is_chat else "chat"))
                    except Exception:
                        pass
                    CHUNK_SIZE = 24
                    for i in range(0, len(final_text), CHUNK_SIZE):
                        yield final_text[i:i + CHUNK_SIZE]
                        await asyncio.sleep(0.012)

                    if session_id:
                        # resume한 기존 thread는 new_thread_id 이벤트가 없을 수 있어도,
                        # 이 provider가 마지막으로 사용됐다는 정보는 갱신해야 한다.
                        save_provider_session_meta(session_id, provider="codex", conversation_id=new_thread_id)
                    return

                stderr_out = await _finish_stderr_drain(stderr_task)

                # resume 대상 세션이 더 이상 존재하지 않는 경우에만 새 세션으로 1회 재시도한다.
                if (
                    not final_text
                    and attempt == 0
                    and thread_id
                    and ("no rollout found" in stderr_out or "thread/resume" in stderr_out)
                ):
                    thread_id = None
                    continue

                logger.error(f"Codex CLI 실패: code={process.returncode} stderr={stderr_out}")
                # 실패를 조용히 삼키고 그냥 return하면, 호출부는 빈 결과를 "정상
                # 번역 완료"로 착각해 빈 문자열을 캐시에 영구 저장해버린다.
                # 예외를 던져서 라우터/job 쪽의 기존 실패 처리 로직(에러 응답,
                # failed_pages 기록 등)이 실제로 작동하게 한다.
                raise RuntimeError(
                    f"Codex CLI 실행 실패 (code={process.returncode}): "
                    f"{stderr_out.strip()[:500] or '알 수 없는 오류'}"
                )
            except Exception as e:
                logger.error(f"Codex CLI 실행 예외: {e}")
                raise


def _ai_session_meta_path(session_id: str) -> str:
    import os
    from config import LIBRARY_DIR
    return os.path.join(LIBRARY_DIR, session_id, "ai_session.json")

_session_meta_locks: dict = {}
_session_meta_locks_guard = threading.Lock()


def _get_session_meta_lock(session_id: str) -> threading.RLock:
    """한 논문의 ai_session.json read-modify-write를 보호합니다."""
    with _session_meta_locks_guard:
        if session_id not in _session_meta_locks:
            _session_meta_locks[session_id] = threading.RLock()
        return _session_meta_locks[session_id]


def _normalize_session_meta(meta: dict) -> dict:
    """기존 단일-provider 형식을 새 provider별 형식으로 해석합니다."""
    if not isinstance(meta, dict):
        return {"providers": {}}
    if isinstance(meta.get("providers"), dict):
        result = {
            "providers": {
                name: dict(value) if isinstance(value, dict) else {}
                for name, value in meta["providers"].items()
                if isinstance(name, str)
            }
        }
        if meta.get("last_provider"):
            result["last_provider"] = meta["last_provider"]
        return result

    provider = meta.get("provider")
    if not provider:
        return {"providers": {}}
    provider_meta = {}
    if meta.get("conversation_id"):
        provider_meta["conversation_id"] = meta["conversation_id"]
    if meta.get("chat_context_sent"):
        provider_meta["chat_context_sent"] = True
    return {"last_provider": provider, "providers": {provider: provider_meta}}


def _load_session_meta(session_id: str) -> dict | None:
    import os
    path = _ai_session_meta_path(session_id)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return _normalize_session_meta(json.load(f))
    except Exception:
        return None


def get_ai_session_meta(session_id: str) -> dict | None:
    """논문의 provider별 AI 세션 메타데이터를 반환합니다."""
    if not session_id:
        return None
    with _get_session_meta_lock(session_id):
        return _load_session_meta(session_id)


def get_provider_session_meta(session_id: str, provider: str) -> dict | None:
    """provider가 실제 resume에 사용할 세션 메타데이터를 반환합니다."""
    if not session_id or not provider:
        return None
    meta = get_ai_session_meta(session_id)
    provider_meta = (meta or {}).get("providers", {}).get(provider)
    return dict(provider_meta) if isinstance(provider_meta, dict) else None


def get_last_provider(session_id: str) -> str | None:
    """가장 최근에 이 논문을 사용한 provider를 반환합니다."""
    return (get_ai_session_meta(session_id) or {}).get("last_provider")


def _write_session_meta(path: str, data: dict) -> None:
    """완성된 파일만 보이도록 원자적으로 메타데이터 파일을 교체합니다."""
    atomic_write_text(path, json.dumps(data))


def save_provider_session_meta(session_id: str, provider: str, conversation_id: str = None) -> None:
    """특정 provider의 세션만 갱신하고 다른 provider 항목은 보존합니다."""
    if not session_id or not provider:
        return
    try:
        with _get_session_meta_lock(session_id):
            existing = _load_session_meta(session_id) or {"providers": {}}
            provider_meta = existing.setdefault("providers", {}).setdefault(provider, {})
            if conversation_id:
                provider_meta["conversation_id"] = conversation_id
            existing["last_provider"] = provider
            _write_session_meta(_ai_session_meta_path(session_id), existing)
    except Exception as e:
        logger.error(f"save_provider_session_meta 실패: {e}")

def _chat_context_already_sent(session_id: str, provider: str) -> bool:
    """이 문서(session_id)의 현재 provider 네이티브 세션에 이미 채팅 풀 컨텍스트
    (논문 원문+답변 가이드라인)를 보낸 적이 있는지 확인한다."""
    meta = get_provider_session_meta(session_id, provider)
    return bool(meta and meta.get("chat_context_sent"))

def _mark_chat_context_sent(session_id: str, provider: str) -> None:
    """방금 이 provider 세션에 채팅 풀 컨텍스트를 보냈음을 기록한다. 기존
    provider/conversation_id는 그대로 보존한다."""
    if not session_id or not provider:
        return
    try:
        with _get_session_meta_lock(session_id):
            existing = _load_session_meta(session_id) or {"providers": {}}
            provider_meta = existing.setdefault("providers", {}).setdefault(provider, {})
            provider_meta["chat_context_sent"] = True
            existing["last_provider"] = provider
            _write_session_meta(_ai_session_meta_path(session_id), existing)
    except Exception as e:
        logger.error(f"_mark_chat_context_sent 실패: {e}")

# 하위 호환: 기존 conversation_id.txt만 남아있는 문서를 위한 폴백 판독
def get_mapped_conversation_id(session_id: str) -> str:
    if not session_id:
        return None
    import os
    from config import LIBRARY_DIR
    path = os.path.join(LIBRARY_DIR, session_id, "conversation_id.txt")
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return f.read().strip()
        except Exception:
            pass
    return None

def get_antigravity_session_meta(session_id: str) -> dict | None:
    """Antigravity 메타를 반환하고, 더 오래된 conversation_id.txt도 지원합니다."""
    meta = get_provider_session_meta(session_id, "antigravity")
    if meta is not None:
        return meta
    legacy_id = get_mapped_conversation_id(session_id)
    return {"conversation_id": legacy_id} if legacy_id else None

def _build_catchup_prefix(session_id: str) -> str:
    """AI provider가 방금 바뀌어 새 세션으로 넘어갈 때, 예전 provider 세션이
    갖고 있던 대화 맥락을 우리 DB의 채팅 이력에서 짧게 뽑아 새 세션의 첫
    프롬프트 앞에 붙일 캐치업 문맥을 만듭니다. provider CLI끼리는 서로의 내부
    세션 상태를 직접 읽을 수 없으므로, 우리가 이미 갖고 있는(우리 DB에 저장된)
    대화 이력을 대신 활용하는 절충안입니다. 토큰 낭비를 줄이기 위해 최근
    몇 턴만 포함하고, provider가 안 바뀐 평소 호출에는 전혀 쓰이지 않습니다."""
    if not session_id:
        return ""
    try:
        from services.db import db_get_chat_history
        history = db_get_chat_history(session_id)
    except Exception:
        return ""
    if not history:
        return ""
    recent = history[-8:]
    lines = []
    for msg in recent:
        role_label = "사용자" if msg.get("role") == "user" else "어시스턴트"
        content = (msg.get("content") or "").strip()
        if len(content) > 500:
            content = content[:500] + "..."
        lines.append(f"{role_label}: {content}")
    recap = "\n".join(lines)
    return (
        "[이전 대화 요약 - 다른 AI 세션에서 이어짐]\n"
        f"{recap}\n"
        "[요약 끝, 아래는 현재 질문]\n\n"
    )

_antigravity_session_locks = {}

def _get_antigravity_lock(session_id: str) -> asyncio.Lock:
    if not session_id:
        return None
    if session_id not in _antigravity_session_locks:
        _antigravity_session_locks[session_id] = asyncio.Lock()
    return _antigravity_session_locks[session_id]


def _serialize_antigravity_session(func):
    """같은 문서의 Antigravity 대화는 응답 스트림 종료까지 한 번에 처리합니다."""
    @functools.wraps(func)
    async def wrapped(*args, **kwargs):
        session_id = kwargs.get("session_id")
        if session_id is None and len(args) >= 3:
            session_id = args[2]
        lock = _get_antigravity_lock(session_id)
        if lock is None:
            async for token in func(*args, **kwargs):
                yield token
            return
        async with lock:
            async for token in func(*args, **kwargs):
                yield token
    return wrapped


@_serialize_antigravity_session
async def stream_antigravity(
    prompt: str,
    model: str = None,
    session_id: str = None,
    is_chat: bool = False,
    usage_label: str = None,
    effort_override: str = None
) -> AsyncGenerator[str, None]:
    import asyncio
    import os
    import re
    from config import LIBRARY_DIR

    agy_path = get_agy_path()
    if not os.path.exists(agy_path):
        agy_path = "agy"

    # project root 대신 문서 전용 격리 폴더(LIBRARY_DIR/{session_id})를 cwd로
    # 쓴다 - agy는 --dangerously-skip-permissions로 cwd 하위 파일/터미널 접근
    # 권한을 이미 갖고 있어서, project root를 그대로 cwd로 쓰면 .env를 포함한
    # 프로젝트 전체가 그 범위 안에 들어가 버린다. 이 폴더에는 해당 문서
    # 데이터(PDF/번역 캐시/채팅 캡처 이미지)만 있어 비밀값이 없고, agy의
    # --conversation resume은 cwd가 달라져도 대화 내용을 그대로 유지하는 것을
    # 실측으로 확인했으므로(claude code의 --resume과 달리 cwd에 묶여있지
    # 않음) 안전하게 바꿀 수 있다. LIBRARY_DIR는 Tauri 패키징 앱에서
    # app_data_dir/library로 주입되므로 이 편이 project root보다 더 안전하다.
    if session_id:
        session_cwd = os.path.abspath(os.path.join(LIBRARY_DIR, session_id))
        os.makedirs(session_cwd, exist_ok=True)
    else:
        session_cwd = get_project_root()

    # 문서(session_id)당 Antigravity 대화(conversation)를 하나만 만들어 재사용한다.
    # 번역뿐 아니라 채팅도 세션이 없으면 만들 수 있어야 한다 - "채팅은 절대 세션을
    # 안 만든다"고 해봤더니, agy는 --conversation 없이 호출하면 그때마다 자기
    # 내부적으로 새 임시 세션을 만들어버려서(우리가 추적만 안 할 뿐 실제로는
    # 매번 새로 생김), 번역이 아직 세션을 못 만든 상태에서 채팅을 여러 번 쓰면
    # 매 메시지가 새 세션을 낭비하는 문제가 실제로 있었다(실측: 채팅 3번에
    # 새 세션 3개). stream_antigravity 전체가 문서별 락으로 보호되므로,
    # 초기화와 실제 요청 사이에 다른 요청이 같은 대화에 끼어들 수 없다.
    session_meta = get_antigravity_session_meta(session_id)

    # 이 문서를 마지막으로 쓴 provider가 antigravity가 아니면(예: claude code로
    # 갔다가 다시 돌아온 경우), 캐치업 문맥은 붙이되 provider별로 보존한 기존
    # 대화 ID를 실제 resume 대상으로 계속 사용한다.
    last_provider = get_last_provider(session_id)
    provider_switched = last_provider is not None and last_provider != "antigravity"
    target_conv_id = session_meta.get("conversation_id") if session_meta else None

    catchup_prefix = _build_catchup_prefix(session_id) if (is_chat and provider_switched) else ""

    if session_id and not target_conv_id:
        # 함수 데코레이터가 이미 동일한 세션 락을 보유한다. 락을 기다리는 동안
        # 다른 호출이 먼저 만들었을 수 있으므로 실제 초기화 직전에 재확인한다.
        session_meta = get_antigravity_session_meta(session_id)
        last_provider = get_last_provider(session_id)
        provider_switched = last_provider is not None and last_provider != "antigravity"
        target_conv_id = session_meta.get("conversation_id") if session_meta else None

        if not target_conv_id:
            # session_cwd는 이미 절대경로다(위에서 os.path.abspath로 계산).
            # 예전에는 LIBRARY_DIR("./library") 상대경로를 그대로 써서, 우리
            # 프로세스의 cwd(backend/) 기준과 agy 서브프로세스의 cwd(당시
            # project root) 기준이 서로 달라 로그 파일을 엉뚱한 위치에서
            # 찾는 버그가 있었다 - 지금은 서브프로세스 cwd 자체가 session_cwd라
            # 이 문제가 구조적으로 사라졌지만, 명시성을 위해 그대로 절대경로로 둔다.
            temp_log_path = os.path.join(session_cwd, f"agy_init_{os.urandom(4).hex()}.log")

            # --dangerously-skip-permissions는 비대화형 실행에 필수(TTY 없이
            # 승인 프롬프트를 띄우면 그냥 멈춘다)이지만, 이것만 있으면 세션이
            # 터미널 명령/파일 조작을 승인 없이 실제로 실행할 수 있게 된다.
            # --sandbox로 터미널 사용에 제약을 걸어, 세션 초기화 프롬프트에
            # 프롬프트 인젝션이 섞여도(우리가 직접 만든 고정 문자열이라 이
            # 지점 자체는 안전하지만, 아래 실제 번역/채팅 호출과 동일한
            # 세션·설정을 공유하므로 일관되게 적용) 영향 범위를 최소화한다.
            init_cmd = [agy_path, "--dangerously-skip-permissions", "--sandbox"]
            if model and model.strip() and model.strip().lower() != "custom":
                init_cmd.extend(["--model", model.strip()])
            if effort_override:
                init_cmd.extend(["--effort", effort_override])
            init_cmd.extend(["--log-file", temp_log_path])
            init_prompt = (
                "You are a direct-output assistant. Output ONLY 'OK'.\n\n"
                "Initialize session."
            )
            init_cmd.extend(["--print", init_prompt])

            try:
                init_proc = await asyncio.create_subprocess_exec(
                    *_exec_args(init_cmd),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=get_agy_env(),
                    cwd=session_cwd
                )
                # 출력을 계속 읽어서 소비해야 한다 - 읽지 않으면 파이프 버퍼가
                # 가득 차서 프로세스가 멈출 수 있다(communicate가 자동으로 처리).
                # 이 호출은 문서(session_id)당 락 아래서 실행되므로, agy가 멈추면
                # (예: 인증 프롬프트 대기) 타임아웃 없이는 그 문서의 세션 초기화가
                # 서버 재시작 전까지 영원히 막히게 된다.
                try:
                    await asyncio.wait_for(init_proc.communicate(), timeout=CLI_STALL_TIMEOUT_SECONDS)
                except asyncio.TimeoutError:
                    await _kill_process_safely(init_proc)
                    raise RuntimeError(f"Antigravity 세션 초기화가 {CLI_STALL_TIMEOUT_SECONDS}초 이상 응답이 없어 중단했습니다.")

                if os.path.exists(temp_log_path):
                    with open(temp_log_path, "r", encoding="utf-8") as lf:
                        log_content = lf.read()
                    match = re.search(r"Created conversation\s+([a-f0-9\-]{36})", log_content)
                    if match:
                        new_conv_id = match.group(1)
                        save_provider_session_meta(session_id, provider="antigravity", conversation_id=new_conv_id)
                        logger.info(f"[stream_antigravity] 세션 {session_id} -> Antigravity 대화 {new_conv_id} 초기화 완료")
                        target_conv_id = new_conv_id
                    else:
                        logger.warning("[stream_antigravity] 초기화 로그에서 대화 ID를 찾지 못함")
                else:
                    logger.warning(f"[stream_antigravity] 로그 파일이 생성되지 않음: {temp_log_path}")
            except Exception as ie:
                logger.warning(f"[stream_antigravity] 세션 초기화 오류: {ie}")
            finally:
                if os.path.exists(temp_log_path):
                    try:
                        os.remove(temp_log_path)
                    except Exception:
                        pass

    # PDF에서 추출한 텍스트를 그대로 프롬프트에 담아 보내는 순수 번역/채팅
    # 용도라 터미널/파일 조작 권한이 전혀 필요 없다(codex 경로의
    # sandbox_mode=read-only와 동일한 이유) - 악성 PDF에 프롬프트 인젝션이
    # 심어져 있어도 --sandbox로 실행 수단 자체를 제한해 영향 범위를 최소화한다.
    cmd = [agy_path, "--dangerously-skip-permissions", "--sandbox"]
    if model and model.strip() and model.strip().lower() != "custom":
        cmd.extend(["--model", model.strip()])
    if effort_override:
        cmd.extend(["--effort", effort_override])
    if target_conv_id:
        cmd.extend(["--conversation", target_conv_id])

    # 충분한 제약을 주어서 확실하게 완전한 출력을 유도
    guided_prompt = (
        "You are a direct-output assistant. "
        "Output ONLY the result — no preambles, no explanations, no 'Here is the translation', "
        "no markdown code fences around the entire output, no commentary at the start or end. "
        "Start the output immediately with the translated/answered content.\n\n"
        f"{catchup_prefix}{prompt}"
    )
    cmd.extend(["--print", guided_prompt])

    try:
        process = await asyncio.create_subprocess_exec(
            *_exec_args(cmd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=get_agy_env(),
            cwd=session_cwd
        )
        stderr_task = _start_stderr_drain(process)

        import codecs
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")

        while True:
            chunk = await _read_chunk_with_timeout(process, label="Antigravity CLI")
            if not chunk:
                break
            decoded = decoder.decode(chunk)
            if decoded:
                yield decoded

        final_decoded = decoder.decode(b"", final=True)
        if final_decoded:
            yield final_decoded

        await _wait_with_timeout(process, label="Antigravity CLI")

        # stderr 코드가 0이 아닌 경우 실패로 처리한다. 예전에는 로그만 남기고
        # 넘어가서 호출부가 빈 결과를 "정상 번역 완료"로 착각해 캐시에 영구
        # 저장해버렸다. 예외를 던져서 라우터/job 쪽의 기존 실패 처리 로직
        # (에러 응답, failed_pages 기록 등)이 실제로 작동하게 한다.
        if process.returncode and process.returncode != 0:
            stderr_out = await _finish_stderr_drain(stderr_task)
            logger.error(f"Antigravity CLI 실패: code={process.returncode} stderr={stderr_out[:500]}")
            raise RuntimeError(
                f"Antigravity CLI 실행 실패 (code={process.returncode}): "
                f"{stderr_out.strip()[:500] or '알 수 없는 오류'}"
            )
        if session_id:
            # 이미 존재하던 conversation을 resume한 호출도 마지막 provider를
            # 갱신해야 이후 다른 provider로 전환할 때 캐치업 문맥을 붙일 수 있다.
            save_provider_session_meta(
                session_id,
                provider="antigravity",
                conversation_id=target_conv_id,
            )

        try:
            from services.usage_tracker import record_call
            record_call(usage_label or ("translate" if not is_chat else "chat"))
        except Exception:
            pass

    except Exception as e:
        # 에러 문자열을 그대로 yield하면 그 문자열 자체가 번역/분류 결과인 것처럼
        # 캐시에 영구 저장되는 버그가 있었다(실제로 "[Antigravity CLI 실행
        # 에러: ...]"라는 문자열이 논문 카테고리로 분류된 사례가 있었음).
        # 반드시 예외로 전파해 호출부가 실패로 인식하게 해야 한다.
        logger.error(f"Antigravity CLI 실행 예외: {e}")
        raise

from typing import List

async def classify_paper_tags(title: str, abstract: str, session_id: str = None) -> dict:
    """Classify a paper into the versioned, role-aware closed tag ontology."""
    from services.paper_tags import build_paper_tag_prompt, normalize_tag_items

    items = await _llm_json_array_with_retry(
        build_paper_tag_prompt(title, abstract[:5000]),
        session_id=session_id,
        log_label="논문 구조화 태그 분류",
        required_key="name",
        config_group="analysis",
    )
    paper_tags = normalize_tag_items(items, source="ai")
    if not paper_tags.get("primary_topics"):
        return {}
    return paper_tags


async def classify_paper_category(title: str, text: str, session_id: str = None) -> List[str]:
    """Backward-compatible flattened view for older callers."""
    from services.paper_tags import flatten_categories

    return flatten_categories(await classify_paper_tags(title, text, session_id=session_id))


def _parse_json_array_response(raw: str, required_key: str = "concept") -> list:
    """LLM 응답에서 JSON 배열을 뽑아낸다. 마크다운 코드펜스(```json ... ```)로
    감싸져 오는 경우가 흔하고, 프롬프트로 순수 JSON만 요구해도 모델이 종종
    설명 문구를 앞뒤에 붙이거나 펜스를 씌우므로, 우선 펜스를 제거한 뒤
    json.loads를 시도한다. 파싱된 결과가 dict 리스트가 아니거나 각 항목에
    required_key 키가 없으면 호출부가 재시도할 수 있도록 ValueError를 던진다.
    기본값 "concept"은 extract_paper_concepts 계열이 쓰던 것 그대로이며,
    다른 배열 형태(예: 추천 논문의 "title")를 검증할 때는 이 값을 바꿔 넣는다."""
    text = (raw or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    text = text.strip()

    parsed = json.loads(text)
    if not isinstance(parsed, list):
        raise ValueError("JSON 응답이 배열이 아닙니다.")
    for item in parsed:
        if not isinstance(item, dict) or required_key not in item:
            raise ValueError(f"배열 항목이 dict가 아니거나 '{required_key}' 키가 없습니다.")
    return parsed


async def _llm_json_array_with_retry(
    prompt: str,
    session_id: str = None,
    attempts: int = 3,
    log_label: str = "LLM JSON 배열 응답",
    required_key: str = "concept",
    config_group: str = "library",
) -> list:
    """공용: 프롬프트를 보내 JSON 배열 응답을 받아 파싱까지 재시도한다
    (extract_paper_concepts/match_question_to_concepts/find_similar_concepts가
    공유하는 멀티 프로바이더 분기 + 재시도 로직). LLM이 마크다운 펜스를
    씌우거나 출력이 중간에 잘리면 파싱이 깨지기 쉬워서 최대 `attempts`회
    재시도하고, 모두 실패해도 예외를 던지지 않고 빈 리스트를 반환한다 -
    이 계열 기능은 전부 부가 정보일 뿐이라 파이프라인 자체를 막아서는 안 된다."""
    messages = [{"role": "user", "content": prompt}]
    if config_group == "analysis":
        provider, model = get_analysis_provider(), get_analysis_model()
    elif config_group == "chat":
        provider, model = get_chat_provider(), get_chat_model()
    elif config_group == "library":
        provider, model = get_library_provider(), get_library_model()
    else:
        raise ValueError(f"지원하지 않는 LLM 설정 그룹입니다: {config_group}")

    for attempt in range(attempts):
        tokens = []
        try:
            if provider == "openai":
                async for token in stream_openai(messages, model=model, temperature=0.1):
                    tokens.append(token)
            elif provider == "gemini":
                async for token in stream_gemini(messages, model=model, temperature=0.1):
                    tokens.append(token)
            elif provider == "claude":
                async for token in stream_claude(messages, model=model, temperature=0.1):
                    tokens.append(token)
            elif provider == "antigravity":
                async for token in stream_antigravity(prompt, model=model, session_id=session_id):
                    tokens.append(token)
            elif provider == "claude_code":
                async for token in stream_claude_code(prompt, model=model, session_id=session_id):
                    tokens.append(token)
            elif provider == "codex":
                async for token in stream_codex(prompt, model=model, session_id=session_id):
                    tokens.append(token)
            else:
                # Fallback to Ollama chat api
                payload = {
                    "model": model,
                    "messages": messages,
                    "stream": False,
                    "options": {"temperature": 0.1}
                }
                async with httpx.AsyncClient(timeout=30.0) as client:
                    response = await client.post(f"{get_ollama_host()}/api/chat", json=payload)
                    if response.status_code == 200:
                        data = response.json()
                        tokens.append(data.get("message", {}).get("content", ""))

            raw = "".join(tokens).strip()
            return _parse_json_array_response(raw, required_key=required_key)
        except Exception as e:
            logger.warning(f"{log_label} 파싱 실패 (시도 {attempt + 1}/{attempts}): {e}")
            continue

    return []


async def extract_paper_concepts(title: str, text: str, session_id: str = None) -> List[dict]:
    """논문 제목과 서두 텍스트에서 핵심 개념 3~7개를 추출한다.
    반환값: [{"concept": str, "kind": str|None}, ...]"""
    prompt = f"""You are an academic paper analyst. Analyze the following paper title and beginning text (abstract/introduction) and extract 3 to 7 core concepts (methods, tasks, datasets, metrics, or theories) discussed in the paper.

Output ONLY a pure JSON array, with no markdown code fences, no explanations, and no extra prose. Each element must be an object with a "concept" key (the concept name, in a few words) and a "kind" key (one of: "method", "task", "dataset", "metric", "theory", or null if unclear).

Example output:
[{{"concept": "Attention Mechanism", "kind": "method"}}, {{"concept": "Machine Translation", "kind": "task"}}]

Title: {title}
Beginning Text:
{text[:2000]}

JSON Array:"""
    return await _llm_json_array_with_retry(
        prompt, session_id=session_id, log_label="논문 개념 추출", config_group="analysis"
    )


async def match_question_to_concepts(question: str, concept_names: List[str], session_id: str = None) -> List[dict]:
    """질문이 주어진 기존 개념 목록 중 어떤 것과 관련 있는지 고른다(폐쇄형
    분류 - 새 개념을 만들지 않는다. concept_names에 없는 이름을 만들어내면
    안 된다는 것을 프롬프트로 명시한다). 반환값: [{"concept": str}, ...]
    (concept_names의 부분집합)."""
    if not concept_names:
        return []
    names_list = "\n".join(f"- {n}" for n in concept_names)
    prompt = f"""You are an academic assistant. A user asked the following question about a paper. From the list of concepts already identified for this paper, pick ONLY the ones this question is actually about. Do not invent new concepts - only choose from the given list, and if none apply, return an empty array.

Output ONLY a pure JSON array, with no markdown code fences, no explanations, and no extra prose. Each element must be an object with a "concept" key whose value is copied EXACTLY (verbatim) from the list below.

Concept List:
{names_list}

Question: {question}

JSON Array:"""
    return await _llm_json_array_with_retry(
        prompt, session_id=session_id, log_label="질문-개념 매칭", config_group="chat"
    )


async def find_similar_concepts(new_name: str, existing_names: List[str], session_id: str = None) -> List[dict]:
    """new_name과 의미상 사실상 같은 개념(동의어/약어 관계 등, 예: "LLM"과
    "Large Language Model")을 existing_names 중에서 고른다. 느슨하게 관련된
    정도로는 고르지 않고, 정말 같은 개념을 가리키는 경우만 선택하도록
    프롬프트에 명시한다. 반환값: [{"concept": str}, ...] (existing_names의 부분집합)."""
    if not existing_names:
        return []
    names_list = "\n".join(f"- {n}" for n in existing_names)
    prompt = f"""You are an academic terminology expert. Given a new concept name and a list of existing concept names, identify ONLY the existing names that refer to the EXACT SAME concept as the new one (synonyms, abbreviations, or equivalent phrasing - e.g. "LLM" and "Large Language Model"). Do not include merely related-but-distinct concepts. If none match, return an empty array.

Output ONLY a pure JSON array, with no markdown code fences, no explanations, and no extra prose. Each element must be an object with a "concept" key whose value is copied EXACTLY (verbatim) from the existing list below.

New Concept: {new_name}

Existing Concepts:
{names_list}

JSON Array:"""
    return await _llm_json_array_with_retry(
        prompt, session_id=session_id, log_label="유사 개념 탐색", config_group="library"
    )


async def score_paper_concept_relevance(title: str, text: str, concept_names: List[str], session_id: str = None) -> List[dict]:
    """논문 제목+서두 텍스트를 근거로, 주어진 개념 목록 각각을 이 논문이 얼마나
    깊이/중심적으로 다루는지 0.0~1.0으로 채점한다(Concept Heatmap 매트릭스의
    셀 값). match_question_to_concepts와 같은 폐쇄형 목록(concept_names에
    없는 개념을 지어내면 안 됨)이지만, 부분집합을 고르는 대신 목록 전체에
    점수를 매긴다는 점이 다르다. 반환값: [{"concept": str, "score": number}, ...]
    (concept_names와 정확히 같은 이름, 순서는 무관)."""
    if not concept_names:
        return []
    names_list = "\n".join(f"- {n}" for n in concept_names)
    prompt = f"""You are an academic paper analyst. Given a paper's title and beginning text (abstract/introduction), score how deeply and centrally EACH concept in the list below is discussed in this paper, on a scale from 0.0 (not discussed at all / irrelevant) to 1.0 (a central, deeply discussed topic of the paper).

Output ONLY a pure JSON array, with no markdown code fences, no explanations, and no extra prose. Each element must be an object with a "concept" key whose value is copied EXACTLY (verbatim) from the list below, and a "score" key (a number between 0.0 and 1.0). You MUST include EVERY concept from the list, even if its score is 0.0.

Concept List:
{names_list}

Title: {title}
Beginning Text:
{text[:2000]}

JSON Array:"""
    return await _llm_json_array_with_retry(
        prompt,
        session_id=session_id,
        log_label="논문-개념 관련도 채점",
        required_key="concept",
        config_group="library",
    )


async def generate_reading_recommendations(titles: List[str], categories: List[str], session_id: str = None) -> List[dict]:
    """읽은 논문 제목/카테고리를 근거로 다음에 읽으면 좋을 논문 후보와 그
    이유를 추천한다. 반환값: [{"title": str, "reason": str}, ...]. 여기서
    추천된 제목은 LLM의 환각(존재하지 않는 논문을 지어내는 것)이 섞여 있을
    수 있고, 호출부(knowledge_graph.get_reading_recommendations)의 OpenAlex
    검증에서 일부가 걸러지므로, 최종 노출 목표(5개 이상)보다 넉넉하게
    8~12개를 요청해 필터링 후에도 충분한 개수가 남게 한다."""
    titles_list = "\n".join(f"- {t}" for t in titles)
    categories_line = ", ".join(categories) if categories else "(알 수 없음)"
    prompt = f"""You are an expert research advisor. A researcher has read the following papers (research areas: {categories_line}). Recommend 8 to 12 OTHER real, existing academic papers they should read next to deepen or extend this line of research, with a short reason for each.

Output ONLY a pure JSON array, with no markdown code fences, no explanations, and no extra prose. Each element must be an object with a "title" key (the paper's real title) and a "reason" key (one short sentence, in Korean, explaining why it's a good next read).

Already Read:
{titles_list}

JSON Array:"""
    return await _llm_json_array_with_retry(
        prompt,
        session_id=session_id,
        log_label="읽을 논문 추천",
        required_key="title",
        config_group="library",
    )


async def generate_dashboard_insights(profile: dict, session_id: str = None) -> List[dict]:
    """사용자의 최근 질문/메모 내용, 읽은 논문 통계, 관심 개념/카테고리를 근거로
    대시보드 "AI 인사이트" 카드에 표시할 개인화된 인사이트 3~5개를 생성한다.
    규칙 기반 격차 감지(knowledge_graph.get_knowledge_gaps)처럼 매번 똑같은 두
    문구를 반복하는 대신, 지도교수가 실제로 학생의 질문/메모를 읽고 1:1 면담에서
    해줄 법한 - 이해 부족/개념 공백을 콕 짚어주고, 스스로를 돌아보게 하는 관점을
    던지는 - 실질적인 조언을 생성하도록 유도한다. 반환값:
    [{"type": str, "message": str}, ...]. profile 형태는
    knowledge_graph.get_ai_insights가 만든다: {"stats": {...}, "notes": [str],
    "questions": [str], "concepts": [str], "categories": [str],
    "gap_hints": [str]}."""
    stats = profile.get("stats") or {}
    notes_block = "\n".join(f"- {n}" for n in profile.get("notes") or []) or "(없음)"
    questions_block = "\n".join(f"- {q}" for q in profile.get("questions") or []) or "(없음)"
    concepts_line = ", ".join(profile.get("concepts") or []) or "(없음)"
    categories_line = ", ".join(profile.get("categories") or []) or "(알 수 없음)"
    gap_hints_block = "\n".join(f"- {g}" for g in profile.get("gap_hints") or []) or "(없음)"

    prompt = f"""You are an experienced professor and thesis advisor mentoring this researcher on their reading and research practice, reviewing their actual recent questions and notes below before a 1-on-1 meeting. Do NOT write generic praise or generic advice that could apply to anyone - every insight must be clearly traceable to something specific in the data given.

Write 3 to 5 short insights in Korean, covering a MIX of these four angles (skip an angle entirely if there isn't real evidence for it - never force a filler insight):

1. "gap_diagnosis" (이해도 진단) - Read the QUESTIONS closely for signs of shallow or missing understanding: repeated confusion about the same concept, a surface-level question about something conceptually deep, or a prerequisite concept they seem to be missing given what they're reading. When you spot one, name the specific concept and suggest a concrete next step (what to review, what paper/section to revisit, or a sharper question to ask themselves).
2. "mentor_advice" (교수자의 조언) - Give the kind of pointed, sometimes candid feedback a thesis advisor gives about research direction, reading habits, or blind spots - grounded in the actual pattern of what they've read/asked/noted, not generic productivity tips.
3. "perspective" (바라보는 관점) - Help them step back and see their own recent activity from an angle they probably haven't noticed themselves: a connection between papers/concepts, a shift in focus over time, or a way to reframe what they're working on.
4. "encouragement" (근거 있는 격려) - When there is concrete evidence of real progress (a well-formed question, growing depth, consistent effort), name that evidence specifically. Do not hand out generic cheerleading with no basis.

Research areas: {categories_line}
Frequently studied concepts: {concepts_line}
Stats: papers {stats.get('total_papers', 0)}, read {stats.get('read_papers', 0)}, questions {stats.get('total_questions', 0)}, notes {stats.get('total_notes', 0)}

Recent notes (memo excerpts, [paper title] content):
{notes_block}

Recent questions asked (excerpts, [paper title] content):
{questions_block}

Rule-detected gaps (for reference only, rephrase naturally and go deeper instead of copying verbatim):
{gap_hints_block}

Output ONLY a pure JSON array, with no markdown code fences, no explanations, and no extra prose. Each element must be an object with:
- "type": exactly one of "gap_diagnosis", "mentor_advice", "perspective", "encouragement"
- "message": the insight itself, in Korean, one to three sentences, specific enough that the researcher would recognize exactly what it's referring to.

JSON Array:"""
    return await _llm_json_array_with_retry(
        prompt,
        session_id=session_id,
        log_label="AI 인사이트 생성",
        required_key="message",
        config_group="library",
    )
