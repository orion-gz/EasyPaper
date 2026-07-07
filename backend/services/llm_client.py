import httpx
import json
from typing import AsyncGenerator
from config import (
    get_ollama_host,
    get_trans_provider,
    get_trans_model,
    get_chat_provider,
    get_chat_model,
    get_openai_api_key,
    get_gemini_api_key,
    get_claude_api_key,
    get_agy_path,
    get_agy_env,
    get_claude_code_path,
    get_translation_prompt_template
)


async def stream_translation(
    text: str,
    target_lang: str = "한국어",
    style: str = "academic",
    ignore_math: bool = False,
    ignore_table: bool = True,
    ignore_refs: bool = False,
    doc_title: str = "",
    prev_context: str = ""
) -> AsyncGenerator[str, None]:
    """
    Ollama /api/chat 엔드포인트를 사용해 번역 결과를 스트리밍합니다.
    사용자의 요구에 따른 언어, 번역 스타일, 제외 요소 옵션에 맞춰 프롬프트를 동적으로 구성합니다.
    """
    # 1. 번역 목적어 설정
    lang_instruction = f"다음 영어 논문 텍스트를 자연스러운 {target_lang}로 번역하세요."
    
    # 2. 번역 스타일 문구 조립
    if style == "literal":
        style_instruction = f"자연스러운 직역을 수행하고 원문의 어순을 가능한 한 유지하여 단어 대조가 쉽도록 번역하세요."
    elif style == "summary":
        style_instruction = f"문단의 핵심 연구 내용을 요약하여 짧고 명확한 개조식 또는 설명글 형태로 요약 번역하세요."
    else:  # "academic" (의역/학술용 다듬기)
        style_instruction = f"자연스럽고 명확한 {target_lang} 학술 문체를 사용하고, 문맥에 맞게 번역문을 매끄럽게 다듬으세요."

    rules = [
        f"학술 전문 용어는 자연스럽게 번역 후 필요한 경우 괄호에 영어 원문을 병기하세요 (예: 심층 학습(Deep Learning)).",
        "문단 구조(빈 줄)를 원문과 동일하게 유지하세요.",
        "URL, DOI, 저자명, 이메일 주소 등은 번역하지 말고 원문 그대로 유지하세요.",
        "논문 리뷰용 줄 번호(예: 001 002)나 페이지 헤더/푸터 정보는 번역에서 제외하세요.",
        "설명이나 메모, 서론(예: '여기에 번역이 있습니다')은 절대 추가하지 말고 번역 결과만 즉시 출력하세요.",
        "번역문은 반드시 경어체(예: '~합니다', '~입니다', '~바랍니다')로만 작성하고, 평어체(예: '~한다', '~다')를 절대 섞어 쓰지 마세요.",
        "중요: 입력 텍스트의 각 문장 시작 부분에 [S0], [S1], [S2] 등과 같은 문장 식별자 태그가 포함되어 있습니다. 번역 결과에서도 각 번역된 문장 앞에 일치하는 태그(예: [S0], [S1]...)를 반드시 그대로 유지하여 출력하세요. 태그의 순서를 바꾸거나 누락하지 마세요."
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
        
    if ignore_table:
        rules.append("Markdown 표(Table) 형식의 출력은 절대 하지 말고, 표 데이터는 번역에서 완전히 제외하세요.")
    else:
        rules.append("표(Table) 내의 정보도 학술적 문맥에 맞춰 깔끔하게 번역하고 마크다운 표 형태를 유지하세요.")
        
    if ignore_refs:
        rules.append("참고문헌(References) 목록이나 각주 정보는 번역하지 말고 목록에서 제외하세요.")
        
    n = len(rules)
    rules_text = "\n".join(f"{idx+1}. {rule}" for idx, rule in enumerate(rules))
    
    # 4. 문맥 정보 추가 (Context-aware Translation)
    context_part = ""
    if doc_title:
        context_part += f"- 논문 제목 (Document Title): {doc_title}\n"
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

    provider = get_trans_provider()
    model = get_trans_model()
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
    elif provider == "antigravity":
        async for token in stream_antigravity(prompt, model=model):
            yield token
        return
    elif provider == "claude_code":
        async for token in stream_claude_code(prompt, model=model):
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
                if response.status_code != 200:
                    body = await response.aread()
                    raise RuntimeError(f"OpenAI API 오류 (HTTP {response.status_code}): {body.decode()[:200]}")
                    
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
    except httpx.ConnectError:
        raise RuntimeError("OpenAI 서버에 연결할 수 없습니다.")
    except httpx.TimeoutException:
        raise RuntimeError("OpenAI 요청 시간이 초과되었습니다.")


async def stream_gemini(messages: list, model: str, temperature: float = 0.5) -> AsyncGenerator[str, None]:
    api_key = get_gemini_api_key()
    if not api_key:
        raise RuntimeError("Gemini API Key가 설정되지 않았습니다. 설정에서 입력해 주세요.")
        
    headers = {
        "Content-Type": "application/json"
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
            
    payload = {
        "contents": gemini_contents,
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": 8192,   # 번역 절단 방지: Gemini 기본값(~2048)이 너무 작음
        }
    }
    if system_instruction:
        payload["systemInstruction"] = system_instruction
        
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?key={api_key}"
    
    try:
        async with httpx.AsyncClient(timeout=360.0) as client:
            async with client.stream(
                "POST",
                url,
                headers=headers,
                json=payload
            ) as response:
                if response.status_code != 200:
                    body = await response.aread()
                    raise RuntimeError(f"Gemini API 오류 (HTTP {response.status_code}): {body.decode()[:200]}")

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

    except httpx.ConnectError:
        raise RuntimeError("Gemini 서버에 연결할 수 없습니다.")
    except httpx.TimeoutException:
        raise RuntimeError("Gemini 요청 시간이 초과되었습니다.")


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
                if response.status_code != 200:
                    body = await response.aread()
                    raise RuntimeError(f"Claude API 오류 (HTTP {response.status_code}): {body.decode()[:200]}")
                    
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
    except httpx.ConnectError:
        raise RuntimeError("Claude 서버에 연결할 수 없습니다.")
    except httpx.TimeoutException:
        raise RuntimeError("Claude 요청 시간이 초과되었습니다.")


async def stream_chat(
    system_prompt: str,
    history_messages: list
) -> AsyncGenerator[str, None]:
    """
    논문 관련 질문 답변 결과를 스트리밍합니다. (선택된 AI Provider에 따름)
    """
    messages = [{"role": "system", "content": system_prompt}] + history_messages

    provider = get_chat_provider()
    model = get_chat_model()
    if provider == "openai":
        async for token in stream_openai(messages, model=model, temperature=0.5):
            yield token
        return
    elif provider == "gemini":
        async for token in stream_gemini(messages, model=model, temperature=0.5):
            yield token
        return
    elif provider == "claude":
        async for token in stream_claude(messages, model=model, temperature=0.5):
            yield token
        return
    elif provider == "antigravity":
        try:
            from services.usage_tracker import record_call
            record_call("chat")
        except Exception:
            pass
        formatted_prompt = []
        formatted_prompt.append(f"System instructions:\n{system_prompt}\n")
        formatted_prompt.append("Conversation history:")
        for msg in history_messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            role_label = "User" if role == "user" else "Assistant"
            formatted_prompt.append(f"[{role_label}]: {content}")
        
        chat_prompt = "\n".join(formatted_prompt)
        async for token in stream_antigravity(chat_prompt, model=model):
            yield token
        return
    elif provider == "claude_code":
        try:
            from services.usage_tracker import record_call
            record_call("chat")
        except Exception:
            pass
        formatted_prompt = []
        formatted_prompt.append(f"System instructions:\n{system_prompt}\n")
        formatted_prompt.append("Conversation history:")
        for msg in history_messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            role_label = "User" if role == "user" else "Assistant"
            formatted_prompt.append(f"[{role_label}]: {content}")
        
        chat_prompt = "\n".join(formatted_prompt)
        async for token in stream_claude_code(chat_prompt, model=model):
            yield token
        return

    # Fallback to Ollama:
    payload = {
        "model": model,
        "messages": messages,
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


async def stream_claude_code(prompt: str, model: str = None) -> AsyncGenerator[str, None]:
    import asyncio
    import os
    
    claude_path = get_claude_code_path()
    if not os.path.exists(claude_path):
        claude_path = "claude"
        
    # --print - : stdin으로 프롬프트를 받아 처리 (--print 인자로 넘기면 Claude가 수학 기호를 _MB_N 으로 치환하는 버그 발생)
    cmd = [claude_path, "--permission-mode", "dontAsk", "--output-format", "text", "--print", "-"]

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

    if model_name:
        cmd.extend(["--model", model_name])
    if effort_level:
        cmd.extend(["--effort", effort_level])

    # 프롬프트에 직접 출력 포맷 지시 추가 (뷰어가 markdown+LaTeX를 렌더링하므로 그대로 출력 허용)
    guided_prompt = (
        "You are a direct-output translation/QA assistant. "
        "Output ONLY the result — no preambles, no explanations, no commentary. "
        "You MAY use markdown and LaTeX ($...$, $$...$$) in your output since the viewer renders them. "
        "Do NOT wrap math variables in placeholder tokens — preserve them as-is or wrap in $...$. "
        "Start the output immediately.\n\n"
        f"{prompt}"
    )

    try:
        from services.usage_tracker import record_call
        record_call("translate")
    except Exception:
        pass

    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=get_agy_env()
        )
        
        # 프롬프트를 stdin으로 전달 후 닫기
        encoded_prompt = guided_prompt.encode("utf-8")
        process.stdin.write(encoded_prompt)
        await process.stdin.drain()
        process.stdin.close()
        
        import codecs
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        
        while True:
            chunk = await process.stdout.read(1024)
            if not chunk:
                break
            decoded = decoder.decode(chunk)
            if decoded:
                yield decoded
        
        final_decoded = decoder.decode(b"", final=True)
        if final_decoded:
            yield final_decoded
            
        await process.wait()
        
        if process.returncode and process.returncode != 0:
            stderr_out = await process.stderr.read()
            print(f"[Claude Code CLI Error] code={process.returncode} stderr={stderr_out.decode('utf-8', errors='replace')}")
    except Exception as e:
        print(f"[Claude Code CLI Exec Error] {e}")


async def stream_antigravity(prompt: str, model: str = None) -> AsyncGenerator[str, None]:
    import asyncio
    import os
    
    agy_path = get_agy_path()
    if not os.path.exists(agy_path):
        agy_path = "agy"
        
    cmd = [agy_path, "--dangerously-skip-permissions"]
    if model and model.strip() and model.strip().lower() != "custom":
        cmd.extend(["--model", model.strip()])

    # agy --print 는 단일 프롬프트를 받아 출력을 스트리밍함
    # 충분한 제약을 주어서 확실하게 완전한 출력을 유도
    guided_prompt = (
        "You are a direct-output assistant. "
        "Output ONLY the result — no preambles, no explanations, no 'Here is the translation', "
        "no markdown code fences around the entire output, no commentary at the start or end. "
        "Start the output immediately with the translated/answered content.\n\n"
        f"{prompt}"
    )
    # 사용량 기록
    try:
        from services.usage_tracker import record_call
        record_call("translate")
    except Exception:
        pass

    cmd.extend(["--print", guided_prompt])
    
    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=get_agy_env()
        )
        
        import codecs
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        
        while True:
            chunk = await process.stdout.read(1024)
            if not chunk:
                break
            decoded = decoder.decode(chunk)
            if decoded:
                yield decoded
        
        final_decoded = decoder.decode(b"", final=True)
        if final_decoded:
            yield final_decoded
            
        await process.wait()
        
        # stderr 코드가 0이 아닌 경우 stderr 내용을 로그
        if process.returncode and process.returncode != 0:
            stderr_out = await process.stderr.read()
            print(f"[Antigravity stderr]: {stderr_out.decode('utf-8', errors='ignore')[:500]}")
        
    except Exception as e:
        yield f"\n[Antigravity CLI 실행 에러: {str(e)}]"

from typing import List

async def classify_paper_category(title: str, text: str) -> List[str]:
    prompt = f"""You are an academic paper classifier. Analyze the following paper title and beginning text (abstract) and classify it into one or two specific sub-categories of computer science / artificial intelligence (e.g. LLM, VLM, VLA, VAE, GAN, Diffusion, Optimizer, Object Detection, Segmentation, Speech Synthesis, RL, GNN, Transformer, etc.).
Output ONLY the category name(s) as a comma-separated list of words (e.g., "LLM" or "LLM, VLM" or "GAN, VAE" or "Optimizer"). Do not include any explanations, introduction, punctuation (other than commas), or markdown formatting. Keep the tags concise and uppercase if appropriate.

Title: {title}
Beginning Text:
{text[:2000]}

Category Tags:"""

    messages = [
        {"role": "user", "content": prompt}
    ]
    
    provider = get_trans_provider()
    model = get_trans_model()
    
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
            async for token in stream_antigravity(prompt, model=model):
                tokens.append(token)
        elif provider == "claude_code":
            async for token in stream_claude_code(prompt, model=model):
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
    except Exception as e:
        print(f"Classification failed: {e}")
        return []

    result = "".join(tokens).strip()
    result = result.replace("`", "").replace('"', "").replace("'", "")
    if result.endswith("."):
        result = result[:-1]
        
    tags = [t.strip() for t in result.split(",") if t.strip()]
    return tags

