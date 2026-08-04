"""
논문 원문 텍스트를 "서론/관련 연구", "방법론/실험 결과", "결론" 세 버킷으로
나누는 순수 텍스트 처리 로직 (네트워크 호출 없음).

읽기 전 브리핑(primer)이 "연구 계보"(기존 한계 → 해결 → 성능 향상)와
"실험 흐름"(가설 → 방법 → 결과) 서사를 뽑아내려면 인트로 2페이지만으로는
근거가 부족하다. 이 모듈은 논문 전체 페이지를 훑어 관련 섹션 헤더를 찾고,
헤더 탐지가 실패하는 논문(포맷이 특이한 경우)에는 페이지 위치 기반
휴리스틱으로 폴백한다.

헤더 매칭은 reference_parser.py의 _HEADER_PREFIX_RE와 동일한 원칙(드롭캡
대응을 위해 글자 사이 공백 허용)을 따르고, References 섹션 시작 위치도
reference_parser의 헤더 매처를 그대로 재사용해 "결론 발췌에 참고문헌이
섞여 들어가는 것"을 막는다.
"""

import re
from typing import Dict, List, Optional

from services.reference_parser import find_reference_start_page_index

_INTRO_RELATED_MAX_CHARS = 4000
_METHOD_RESULTS_MAX_CHARS = 4000
_CONCLUSION_MAX_CHARS = 1500

_NUM_PREFIX = r"(?:\d{1,2}[.)]?\s*|[ivx]{1,4}[.)]\s*)?"

_INTRO_HEADER_RE = re.compile(
    _NUM_PREFIX + r"(?:i\s*n\s*t\s*r\s*o\s*d\s*u\s*c\s*t\s*i\s*o\s*n|서\s*론|들\s*어\s*가\s*며)\b",
    re.IGNORECASE | re.MULTILINE,
)
_RELATED_WORK_HEADER_RE = re.compile(
    _NUM_PREFIX + r"(?:r\s*e\s*l\s*a\s*t\s*e\s*d\s*w\s*o\s*r\s*k|b\s*a\s*c\s*k\s*g\s*r\s*o\s*u\s*n\s*d|관\s*련\s*연\s*구)\b",
    re.IGNORECASE | re.MULTILINE,
)
_METHOD_HEADER_RE = re.compile(
    _NUM_PREFIX + r"(?:m\s*e\s*t\s*h\s*o\s*d\s*(?:o\s*l\s*o\s*g\s*y)?|a\s*p\s*p\s*r\s*o\s*a\s*c\s*h|방\s*법\s*론?)\b",
    re.IGNORECASE | re.MULTILINE,
)
_RESULTS_HEADER_RE = re.compile(
    _NUM_PREFIX + r"(?:r\s*e\s*s\s*u\s*l\s*t\s*s?|e\s*x\s*p\s*e\s*r\s*i\s*m\s*e\s*n\s*t\s*s?|실\s*험|결\s*과)\b",
    re.IGNORECASE | re.MULTILINE,
)
_CONCLUSION_HEADER_RE = re.compile(
    _NUM_PREFIX + r"(?:c\s*o\s*n\s*c\s*l\s*u\s*s\s*i\s*o\s*n\s*s?|d\s*i\s*s\s*c\s*u\s*s\s*s\s*i\s*o\s*n|결\s*론|맺\s*음\s*말)\b",
    re.IGNORECASE | re.MULTILINE,
)


def _first_match_pos(pattern: "re.Pattern", text: str) -> Optional[int]:
    m = pattern.search(text)
    return m.start() if m else None


def _min_found(*positions: Optional[int]) -> Optional[int]:
    found = [p for p in positions if p is not None]
    return min(found) if found else None


def _find_reference_start_offset(page_texts: List[str]) -> Optional[int]:
    """References/참고문헌 섹션이 시작하는 페이지를 찾아 전체 텍스트 기준
    글자 오프셋으로 변환한다. 결론 발췌 끝을 여기서 잘라 참고문헌 목록이
    섞여 들어가지 않게 하는 데 쓴다(페이지 탐지 자체는 reference_parser.
    find_reference_start_page_index와 동일 로직을 공유)."""
    ref_start_page_idx = find_reference_start_page_index([{"text": t} for t in page_texts])
    if ref_start_page_idx is None:
        return None
    return sum(len(page_texts[i]) + 1 for i in range(ref_start_page_idx))


def _positional_fallback(full_text: str, doc_end: int) -> Dict[str, str]:
    """헤더 탐지가 실패했을 때 페이지(글자) 위치 비율로 대체 분할한다:
    앞 30% → 서론/관련 연구, 중간 55% → 방법론/실험, 마지막 15% → 결론."""
    intro_end = int(doc_end * 0.3)
    conclusion_start = int(doc_end * 0.85)
    return {
        "intro_related": full_text[:intro_end].strip(),
        "method_results": full_text[intro_end:conclusion_start].strip(),
        "conclusion": full_text[conclusion_start:doc_end].strip(),
    }


def detect_sections(pages: List[dict]) -> Dict[str, str]:
    """페이지 목록(각 {"text": ...} 포함)에서 서론/관련 연구, 방법론/실험 결과,
    결론 발췌를 뽑아낸다. 실패해도 예외를 던지지 않고 빈 문자열들을 반환한다
    (호출부가 이 실패를 전체 기능 중단으로 이어가지 않도록)."""
    try:
        return _detect_sections_impl(pages)
    except Exception:
        return {"intro_related": "", "method_results": "", "conclusion": ""}


def _detect_sections_impl(pages: List[dict]) -> Dict[str, str]:
    page_texts = [p.get("text", "") or "" for p in pages]
    full_text = "\n".join(page_texts)
    if not full_text.strip():
        return {"intro_related": "", "method_results": "", "conclusion": ""}

    ref_start_offset = _find_reference_start_offset(page_texts)
    doc_end = ref_start_offset if ref_start_offset is not None else len(full_text)

    intro_pos = _first_match_pos(_INTRO_HEADER_RE, full_text)
    related_pos = _first_match_pos(_RELATED_WORK_HEADER_RE, full_text)
    method_pos = _first_match_pos(_METHOD_HEADER_RE, full_text)
    results_pos = _first_match_pos(_RESULTS_HEADER_RE, full_text)
    conclusion_pos = _first_match_pos(_CONCLUSION_HEADER_RE, full_text)

    intro_related_start = _min_found(intro_pos, related_pos)
    method_start = _min_found(method_pos, results_pos)

    # 방법론/결론 헤더가 서론보다 앞에서(오탐으로) 잡히면 순서가 뒤집히므로 무시한다.
    if method_start is not None and intro_related_start is not None and method_start <= intro_related_start:
        method_start = None
    if conclusion_pos is not None:
        earliest = method_start if method_start is not None else intro_related_start
        if earliest is not None and conclusion_pos <= earliest:
            conclusion_pos = None

    intro_related_end = method_start if method_start is not None else (
        conclusion_pos if conclusion_pos is not None else doc_end
    )
    method_end = conclusion_pos if conclusion_pos is not None else doc_end

    sections = {"intro_related": "", "method_results": "", "conclusion": ""}
    if intro_related_start is not None:
        sections["intro_related"] = full_text[intro_related_start:intro_related_end].strip()
    if method_start is not None:
        sections["method_results"] = full_text[method_start:method_end].strip()
    if conclusion_pos is not None:
        sections["conclusion"] = full_text[conclusion_pos:doc_end].strip()

    if not sections["intro_related"] and not sections["method_results"] and not sections["conclusion"]:
        sections = _positional_fallback(full_text, doc_end)
    elif not sections["intro_related"]:
        # 계보/파인만 설명의 최소 근거는 항상 확보한다 - 방법론/결론 헤더만
        # 잡히고 서론 헤더 탐지에만 실패하는 경우를 대비.
        sections["intro_related"] = full_text[: int(doc_end * 0.3)].strip()

    return {
        "intro_related": sections["intro_related"][:_INTRO_RELATED_MAX_CHARS],
        "method_results": sections["method_results"][:_METHOD_RESULTS_MAX_CHARS],
        "conclusion": sections["conclusion"][:_CONCLUSION_MAX_CHARS],
    }
