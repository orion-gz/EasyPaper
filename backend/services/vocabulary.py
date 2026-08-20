"""Validation for structured general-document vocabulary insight results."""

import json
import re
from typing import Any

from services.vocabulary_candidates import (
    ADVANCED_CANDIDATES, CANDIDATE_LIST_LICENSE, CANDIDATE_LIST_VERSION,
)


VALID_LEVELS = {"SAT", "GRE", "SAT·GRE"}
MAX_ITEMS_PER_GROUP = 20
BASIC_WORDS = {
    "about", "after", "before", "between", "could", "first", "from", "have",
    "into", "more", "other", "should", "their", "there", "these", "this",
    "through", "using", "were", "which", "with", "would",
}


def _extract_json(raw: str) -> dict:
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE)
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("어휘 결과는 JSON 객체여야 합니다.")
    return value


def _occurrences(text: str, term: str) -> list[tuple[int, int]]:
    if not term:
        return []
    return [(m.start(), m.end()) for m in re.finditer(re.escape(term), text, re.IGNORECASE)]


def validate_vocabulary_result(raw: str, page_text: str, page_num: int) -> dict[str, Any]:
    value = _extract_json(raw)
    result = {
        "schema_version": 1,
        "candidate_filter_version": CANDIDATE_LIST_VERSION,
        "candidate_filter_license": CANDIDATE_LIST_LICENSE,
        "advanced_words": [],
        "technical_terms": [],
    }
    seen_lemmas = set()
    has_english_context = len(re.findall(r"\b[A-Za-z]{3,}\b", page_text)) >= 3
    if not has_english_context:
        result["advanced_words_notice"] = "영어 원문 페이지가 아니어서 고급 영어 어휘를 추출하지 않았습니다."

    for key in ("advanced_words", "technical_terms"):
        items = value.get(key, [])
        if not isinstance(items, list):
            continue
        for item in items[:MAX_ITEMS_PER_GROUP]:
            if not isinstance(item, dict):
                continue
            term = str(item.get("term", "")).strip()
            lemma = str(item.get("lemma") or term).strip().casefold()
            matches = _occurrences(page_text, term)
            meaning = str(item.get("meaning") or "").strip()
            if not term or not meaning or not matches or lemma in seen_lemmas:
                continue
            if key == "advanced_words":
                if not has_english_context or item.get("level") not in VALID_LEVELS:
                    continue
                if (lemma in BASIC_WORDS or lemma not in ADVANCED_CANDIDATES
                        or not re.fullmatch(r"[A-Za-z][A-Za-z'-]{3,}", term)):
                    continue

            requested_occurrence = item.get("occurrence", 1)
            try:
                occurrence = max(1, int(requested_occurrence))
            except (TypeError, ValueError):
                occurrence = 1
            occurrence = min(occurrence, len(matches))
            start, end = matches[occurrence - 1]

            clean = {
                "term": term,
                "lemma": str(item.get("lemma") or term).strip(),
                "part_of_speech": str(item.get("part_of_speech") or "").strip(),
                "meaning": meaning,
                "example": str(item.get("example") or "").strip(),
                "page_num": page_num,
                "char_start": start,
                "char_end": end,
                "occurrence": occurrence,
                "bbox": (
                    item.get("bbox")
                    if isinstance(item.get("bbox"), list)
                    and len(item["bbox"]) == 4
                    and all(isinstance(value, (int, float)) for value in item["bbox"])
                    else None
                ),
            }
            if key == "advanced_words":
                clean["level"] = item["level"]
            result[key].append(clean)
            seen_lemmas.add(lemma)

    return result
