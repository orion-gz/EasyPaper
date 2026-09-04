"""Adaptive briefing schemas, type policies, and bounded source selection."""
from __future__ import annotations

from dataclasses import dataclass
import re


BRIEFING_SCHEMA_VERSION = 3
BRIEFING_PROMPT_VERSION = "adaptive-briefing-v3"
LONG_DOCUMENT_PAGE_THRESHOLD = 50
MAX_LONG_DOCUMENT_SEGMENTS = 16
MAX_LONG_DOCUMENT_CHARS = 16_000


@dataclass(frozen=True)
class BriefingSection:
    id: str
    title: str
    kind: str = "prose"


SECTION_POLICIES: dict[str, tuple[BriefingSection, ...]] = {
    "research_paper": (
        BriefingSection("research_question", "연구 문제"),
        BriefingSection("lineage", "연구 계보·기여"),
        BriefingSection("feynman", "쉬운 설명"),
        BriefingSection("experiment_flow", "가설–방법–결과", "triples"),
        BriefingSection("limitations", "한계", "bullets"),
        BriefingSection("related_papers", "관련 논문", "citation_graph"),
    ),
    "review_survey": tuple(BriefingSection(*item) for item in (
        ("scope", "조사 범위", "prose"), ("lineage", "연구 흐름", "prose"),
        ("taxonomy", "분류 체계", "bullets"), ("comparison", "접근법 비교", "bullets"),
        ("debates", "합의·논쟁", "bullets"), ("open_problems", "미해결 과제", "bullets"),
    )),
    "thesis": tuple(BriefingSection(*item) for item in (
        ("research_questions", "연구 질문", "bullets"), ("chapter_arguments", "장별 논지", "bullets"),
        ("theoretical_framework", "이론적 틀", "prose"), ("research_design", "연구 설계", "prose"),
        ("validation", "검증 과정", "bullets"), ("contribution", "전체 기여", "prose"),
    )),
    "preprint": tuple(BriefingSection(*item) for item in (
        ("claims", "핵심 주장", "bullets"), ("evidence", "증거 흐름", "bullets"),
        ("reproducibility", "재현 가능성", "bullets"), ("unverified", "미검증 사항", "bullets"),
        ("verification_checklist", "추가 검증 체크리스트", "bullets"),
    )),
    "academic_report": tuple(BriefingSection(*item) for item in (
        ("purpose_scope", "목적·범위", "prose"), ("data_methods", "데이터·방법", "prose"),
        ("metrics", "핵심 지표", "bullets"), ("results", "결과", "bullets"),
        ("recommendations", "권고", "bullets"), ("assumptions_risks", "가정·위험", "bullets"),
    )),
    "technical": tuple(BriefingSection(*item) for item in (
        ("compatibility", "버전·호환성", "bullets"), ("architecture", "구조", "prose"),
        ("setup", "설치·설정", "bullets"), ("io", "입출력", "bullets"),
        ("verification", "검증", "bullets"), ("troubleshooting", "오류 해결", "bullets"),
    )),
    "academic_book": tuple(BriefingSection(*item) for item in (
        ("prerequisites", "선수 지식", "bullets"), ("chapter_structure", "장 구조", "bullets"),
        ("core_concepts", "핵심 개념", "glossary"), ("definitions_theorems", "정의·정리", "bullets"),
        ("examples", "예제", "bullets"), ("chapter_connections", "장 간 연결", "prose"),
    )),
    "general_book": tuple(BriefingSection(*item) for item in (
        ("thesis", "중심 논지", "prose"), ("chapter_claims", "장별 주장", "bullets"),
        ("evidence", "사례·근거", "bullets"), ("counterarguments", "반론", "bullets"),
        ("actions", "실천 항목", "bullets"),
    )),
    "literary_work": tuple(BriefingSection(*item) for item in (
        ("characters_pov", "시점·인물", "bullets"), ("story_so_far", "현재까지의 서사", "prose"),
        ("themes_symbols", "주제·상징", "bullets"), ("style_mood", "문체·분위기", "prose"),
    )),
    "article": tuple(BriefingSection(*item) for item in (
        ("claim", "핵심 주장", "prose"), ("sources", "출처", "bullets"),
        ("fact_opinion", "사실·의견", "bullets"), ("stakeholders", "이해관계자", "bullets"),
        ("perspectives_omissions", "관점·누락", "bullets"),
    )),
    "report": tuple(BriefingSection(*item) for item in (
        ("methodology", "방법론", "prose"), ("baseline", "기준선", "bullets"),
        ("metrics", "지표", "bullets"), ("results_forecast", "결과·전망", "bullets"),
        ("assumptions", "가정", "bullets"), ("risks", "위험", "bullets"),
    )),
    "manual": tuple(BriefingSection(*item) for item in (
        ("prerequisites", "전제 조건", "bullets"), ("steps", "순서", "bullets"),
        ("warnings", "경고", "bullets"), ("expected_results", "기대 결과", "bullets"),
        ("verification", "검증", "bullets"), ("troubleshooting", "문제 해결", "bullets"),
    )),
    "legal_policy": tuple(BriefingSection(*item) for item in (
        ("scope", "적용 범위", "prose"), ("definitions", "정의", "glossary"),
        ("rights_duties", "권리·의무", "bullets"), ("prohibitions", "금지", "bullets"),
        ("exceptions", "예외", "bullets"), ("deadlines_procedure", "기한·절차", "bullets"),
    )),
    "presentation": tuple(BriefingSection(*item) for item in (
        ("purpose", "목적", "prose"), ("slide_flow", "슬라이드 흐름", "bullets"),
        ("messages", "핵심 메시지", "bullets"), ("visual_evidence", "도표 근거", "bullets"),
        ("conclusion", "결론", "prose"), ("missing_context", "누락 맥락", "bullets"),
    )),
    "other": tuple(BriefingSection(*item) for item in (
        ("purpose", "목적", "prose"), ("audience", "독자", "prose"),
        ("structure", "구조", "bullets"), ("key_content", "핵심 내용", "bullets"),
        ("cautions", "주의점", "bullets"), ("terms", "용어", "glossary"),
    )),
}


def section_policy(document_type: str) -> tuple[BriefingSection, ...]:
    return SECTION_POLICIES.get(document_type, SECTION_POLICIES["other"])


_TYPE_HEADING_TERMS: dict[str, tuple[str, ...]] = {
    "thesis": ("chapter", "introduction", "literature review", "method", "result", "conclusion", "장", "연구 방법", "결론"),
    "technical": ("overview", "architecture", "install", "configuration", "api", "input", "output", "troubleshoot", "구조", "설치", "설정", "오류"),
    "academic_book": ("chapter", "part", "definition", "theorem", "example", "장", "부", "정의", "정리", "예제"),
    "general_book": ("chapter", "part", "introduction", "conclusion", "장", "부", "서론", "결론"),
    "literary_work": ("chapter", "part", "prologue", "epilogue", "장", "부", "서문", "에필로그"),
    "article": ("headline", "introduction", "background", "analysis", "opinion", "source", "배경", "분석", "출처"),
    "report": ("executive summary", "methodology", "baseline", "results", "forecast", "risk", "요약", "방법론", "결과", "전망", "위험"),
    "manual": ("prerequisite", "installation", "procedure", "warning", "verify", "troubleshoot", "전제", "설치", "절차", "경고", "검증", "문제 해결"),
    "legal_policy": ("scope", "definition", "rights", "duties", "prohibition", "exception", "procedure", "적용 범위", "정의", "권리", "의무", "금지", "예외", "절차"),
    "presentation": ("agenda", "overview", "objective", "result", "conclusion", "목차", "목적", "결과", "결론"),
    "other": ("overview", "purpose", "introduction", "summary", "conclusion", "개요", "목적", "서론", "요약", "결론"),
}


def _short_type_positions(nonempty: list[tuple[int, dict]], document_type: str) -> list[int]:
    terms = _TYPE_HEADING_TERMS.get(document_type, ())
    matches = []
    for position, (_, page) in enumerate(nonempty):
        heading_text = "\n".join((page.get("text") or "").splitlines()[:35]).casefold()
        if any(re.search(rf"(?:^|\n)\s*{re.escape(term.casefold())}(?:\b|\s|[:：])", heading_text) for term in terms):
            matches.append(position)
    candidates = [0, *matches, len(nonempty) - 1]
    positions = []
    for position in candidates:
        if position not in positions:
            positions.append(position)
        if len(positions) >= MAX_LONG_DOCUMENT_SEGMENTS:
            break
    return sorted(positions)


def select_briefing_excerpts(pages: list[dict], document_type: str) -> tuple[str, str, list[int]]:
    nonempty = [(index, page) for index, page in enumerate(pages) if (page.get("text") or "").strip()]
    if not nonempty:
        return "", "long" if len(pages) >= LONG_DOCUMENT_PAGE_THRESHOLD else "short", []
    is_long = len(pages) >= LONG_DOCUMENT_PAGE_THRESHOLD
    if is_long:
        toc_positions = [
            position for position, (_, page) in enumerate(nonempty[:12])
            if re.search(r"(?:table\s+of\s+contents|contents|목\s*차)", page.get("text") or "", re.IGNORECASE)
        ]
        candidates = [0, len(nonempty) - 1, *toc_positions]
        candidates.extend(
            round(slot * (len(nonempty) - 1) / max(1, MAX_LONG_DOCUMENT_SEGMENTS - 1))
            for slot in range(MAX_LONG_DOCUMENT_SEGMENTS)
        )
        positions = []
        for position in candidates:
            if position not in positions:
                positions.append(position)
            if len(positions) >= MAX_LONG_DOCUMENT_SEGMENTS:
                break
        selected = [nonempty[pos] for pos in sorted(positions)]
        per_segment = max(400, MAX_LONG_DOCUMENT_CHARS // max(1, len(selected)))
    else:
        if document_type in {"research_paper", "review_survey", "preprint", "academic_report"}:
            from services.section_parser import detect_sections
            detected = detect_sections(pages)
            text = "\n\n".join(value for value in detected.values() if value)
            return text[:MAX_LONG_DOCUMENT_CHARS], "short", [page.get("page_num", index + 1) for index, page in nonempty]
        positions = _short_type_positions(nonempty, document_type)
        selected = [nonempty[position] for position in positions]
        per_segment = max(400, MAX_LONG_DOCUMENT_CHARS // max(1, len(selected)))
    chunks, used, page_numbers = [], 0, []
    for index, page in selected:
        number = int(page.get("page_num") or index + 1)
        prefix = f"--- Page {number} ---\n"
        chunk = prefix + (page.get("text") or "").strip()[:per_segment]
        chunk = chunk[:max(0, MAX_LONG_DOCUMENT_CHARS - used)]
        if chunk:
            chunks.append(chunk)
            used += len(chunk)
            page_numbers.append(number)
        if used >= MAX_LONG_DOCUMENT_CHARS:
            break
    return "\n\n".join(chunks)[:MAX_LONG_DOCUMENT_CHARS], "long" if is_long else "short", page_numbers


def normalize_briefing(value: dict, document_mode: str, document_type: str, length_policy: str) -> dict:
    raw_sections = value.get("sections") if isinstance(value, dict) else []
    allowed = {section.id: section for section in section_policy(document_type)}
    sections = []
    for raw in raw_sections or []:
        if not isinstance(raw, dict) or raw.get("id") not in allowed:
            continue
        policy = allowed[raw["id"]]
        kind = policy.kind
        content = str(raw.get("content") or "").strip()
        items = raw.get("items") if isinstance(raw.get("items"), list) else []
        if content or items:
            sections.append({"id": policy.id, "title": str(raw.get("title") or policy.title).strip()[:120], "kind": kind, "content": content, "items": items})
    return {
        "schema_version": BRIEFING_SCHEMA_VERSION,
        "document_mode": document_mode,
        "document_type": document_type,
        "length_policy": length_policy,
        "headline": str(value.get("headline") or "").strip(),
        "sections": sections,
        "suggested_questions": [str(item).strip() for item in (value.get("suggested_questions") or [])[:5] if str(item).strip()],
    }
