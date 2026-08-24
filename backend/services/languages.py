"""Supported document languages, BCP 47 validation, and local detection."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Iterable

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DocumentLanguage:
    code: str
    english_name: str
    translation_key: str


_LANGUAGE_ROWS = (
    ("ko", "Korean"), ("en", "English"), ("ja", "Japanese"),
    ("zh-Hans", "Simplified Chinese"), ("zh-Hant", "Traditional Chinese"),
    ("es", "Spanish"), ("fr", "French"), ("de", "German"),
    ("pt-BR", "Brazilian Portuguese"), ("pt-PT", "European Portuguese"),
    ("it", "Italian"), ("nl", "Dutch"), ("ru", "Russian"),
    ("uk", "Ukrainian"), ("pl", "Polish"), ("cs", "Czech"),
    ("sk", "Slovak"), ("bg", "Bulgarian"), ("hr", "Croatian"),
    ("sr", "Serbian"), ("sl", "Slovenian"), ("sv", "Swedish"),
    ("da", "Danish"), ("no", "Norwegian"), ("fi", "Finnish"),
    ("et", "Estonian"), ("lv", "Latvian"), ("lt", "Lithuanian"),
    ("el", "Greek"), ("tr", "Turkish"), ("ar", "Arabic"),
    ("he", "Hebrew"), ("hi", "Hindi"), ("bn", "Bengali"),
    ("id", "Indonesian"), ("vi", "Vietnamese"), ("th", "Thai"),
    ("sw", "Swahili"),
)

DOCUMENT_LANGUAGES = tuple(
    DocumentLanguage(code, name, f"language.{code}") for code, name in _LANGUAGE_ROWS
)
DOCUMENT_LANGUAGE_CODES = frozenset(item.code for item in DOCUMENT_LANGUAGES)
SPECIAL_SOURCE_LANGUAGE_CODES = frozenset({"auto", "mul", "und"})
UI_LOCALES = frozenset({"ko", "en"})
DEFAULT_TARGET_LANGUAGE = "ko"

_BY_CODE = {item.code: item for item in DOCUMENT_LANGUAGES}
_CANONICAL_CASE = {code.lower(): code for code in DOCUMENT_LANGUAGE_CODES}
_SAFE_BCP47 = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")
_LEGACY_TARGET_VALUES = {
    "한국어": "ko", "영어": "en", "일본어": "ja", "중국어": "zh-Hans",
    "korean": "ko", "english": "en", "japanese": "ja",
}


def normalize_document_language(value: str, *, allow_auto: bool = False,
                                allow_detected_special: bool = False,
                                allow_legacy: bool = False) -> str:
    """Return a canonical supported BCP 47 tag or raise ``ValueError``."""
    raw = (value or "").strip()
    if allow_legacy:
        raw = _LEGACY_TARGET_VALUES.get(raw.lower(), _LEGACY_TARGET_VALUES.get(raw, raw))
    canonical = _CANONICAL_CASE.get(raw.lower())
    if canonical:
        return canonical
    if allow_auto and raw.lower() == "auto":
        return "auto"
    if allow_detected_special and raw.lower() in {"mul", "und"}:
        return raw.lower()
    raise ValueError(f"Unsupported language tag: {value}")


def normalize_ui_locale(value: str) -> str:
    locale = (value or "").strip().lower().replace("_", "-")
    if locale in UI_LOCALES:
        return locale
    raise ValueError(f"Unsupported UI locale: {value}")


def normalize_detected_language(value: str) -> str:
    """Normalize a detector result without treating it as translatable."""
    raw = (value or "").strip().replace("_", "-")
    lowered = raw.lower()
    if lowered in {"und", "mul"}:
        return lowered
    canonical = _CANONICAL_CASE.get(lowered)
    if canonical:
        return canonical
    if not _SAFE_BCP47.fullmatch(raw):
        return "und"
    parts = raw.split("-")
    return "-".join([parts[0].lower(), *[
        part.title() if len(part) == 4 and part.isalpha()
        else part.upper() if len(part) == 2 and part.isalpha()
        else part.lower()
        for part in parts[1:]
    ]])


def resolve_source_language(session: dict, requested: str, *, require_supported: bool = False) -> str:
    """Validate a requested source and resolve auto against detector state."""
    normalized = normalize_document_language(requested, allow_auto=True)
    resolved = normalize_detected_language(
        session.get("detected_source_language", "und")
    ) if normalized == "auto" else normalized
    if require_supported and resolved not in DOCUMENT_LANGUAGE_CODES:
        raise ValueError(resolved)
    return resolved


def language_name(code: str) -> str:
    if code in SPECIAL_SOURCE_LANGUAGE_CODES:
        return {"auto": "Auto-detect", "mul": "Multiple languages", "und": "Undetermined"}[code]
    return _BY_CODE[normalize_document_language(code)].english_name


def language_catalog() -> list[dict[str, str]]:
    return [{"code": item.code, "translation_key": item.translation_key} for item in DOCUMENT_LANGUAGES]


_URL = re.compile(r"https?://\S+|www\.\S+", re.IGNORECASE)


def _sample_text(pages: Iterable[dict], max_pages: int = 5, max_chars: int = 20_000) -> tuple[str, list[str]]:
    page_list = list(pages)
    if not page_list:
        return "", []
    count = min(max_pages, len(page_list))
    indexes = sorted({round(i * (len(page_list) - 1) / max(1, count - 1)) for i in range(count)})
    samples: list[str] = []
    remaining = max_chars
    for index in indexes:
        useful = []
        for raw_line in str(page_list[index].get("text", "")).splitlines():
            line = _URL.sub(" ", raw_line).strip()
            letters = sum(char.isalpha() for char in line)
            if letters >= 12 and letters / max(1, len(line)) >= 0.35:
                useful.append(line)
        sample = "\n".join(useful)[:remaining]
        if sample:
            samples.append(sample)
            remaining -= len(sample)
        if remaining <= 0:
            break
    return "\n\n".join(samples), samples


_LINGUA_TO_BCP47 = {
    "KOREAN": "ko", "ENGLISH": "en", "JAPANESE": "ja", "CHINESE": "zh-Hans",
    "SPANISH": "es", "FRENCH": "fr", "GERMAN": "de", "PORTUGUESE": "pt-PT",
    "ITALIAN": "it", "DUTCH": "nl", "RUSSIAN": "ru", "UKRAINIAN": "uk",
    "POLISH": "pl", "CZECH": "cs", "SLOVAK": "sk", "BULGARIAN": "bg",
    "CROATIAN": "hr", "SERBIAN": "sr", "SLOVENE": "sl", "SWEDISH": "sv",
    "DANISH": "da", "BOKMAL": "no", "NYNORSK": "no", "FINNISH": "fi",
    "ESTONIAN": "et", "LATVIAN": "lv", "LITHUANIAN": "lt", "GREEK": "el",
    "TURKISH": "tr", "ARABIC": "ar", "HEBREW": "he", "HINDI": "hi",
    "BENGALI": "bn", "INDONESIAN": "id", "VIETNAMESE": "vi", "THAI": "th",
    "SWAHILI": "sw",
}
_TRADITIONAL_CHINESE = frozenset("體國學會為這個來時說對開關門書車馬魚鳥龍臺萬與專業東絲種識語檔並驗準據從將無務發後裡")
_BRAZILIAN_PORTUGUESE = re.compile(r"\b(?:você|vocês|ônibus|trem|arquivo|acadêmic[oa]|fato|equipe)\b", re.IGNORECASE)


@lru_cache(maxsize=1)
def _detector():
    from lingua import LanguageDetectorBuilder
    return LanguageDetectorBuilder.from_all_languages().with_preloaded_language_models().build()


def _language_code(language, text: str) -> str | None:
    code = _LINGUA_TO_BCP47.get(getattr(language, "name", str(language)).upper())
    if code == "zh-Hans" and any(char in _TRADITIONAL_CHINESE for char in text):
        return "zh-Hant"
    # Lingua detects Portuguese but not region. Default to pt-PT and promote to
    # pt-BR only when strong Brazilian lexical/orthographic markers occur.
    if code == "pt-PT" and _BRAZILIAN_PORTUGUESE.search(text):
        return "pt-BR"
    if code:
        return code
    iso = getattr(language, "iso_code_639_1", None)
    iso_name = getattr(iso, "name", None)
    if iso_name and iso_name.upper() != "NONE":
        return normalize_detected_language(iso_name)
    return None


def _confident_sample_codes(detector, samples: Iterable[str]) -> set[str]:
    codes: set[str] = set()
    for sample in samples:
        values = detector.compute_language_confidence_values(sample)
        if values and float(values[0].value) >= 0.55:
            code = _language_code(values[0].language, sample)
            if code:
                codes.add(code)
    return codes


def detect_document_language(pages: Iterable[dict]) -> dict[str, object]:
    """Detect source language locally. Failure is represented as ``und``."""
    text, page_samples = _sample_text(pages)
    if len(text) < 40:
        return {"language": "und", "confidence": 0.0, "supported": False}
    try:
        detector = _detector()
        values = detector.compute_language_confidence_values(text)
        if not values:
            return {"language": "und", "confidence": 0.0, "supported": False}
        best = values[0]
        confidence = float(best.value)
        code = _language_code(best.language, text)
        if confidence < 0.35:
            return {"language": "und", "confidence": round(confidence, 4), "supported": False}
        confident_pages = _confident_sample_codes(detector, page_samples)
        chunks = [chunk.strip() for chunk in re.split(r"\n\s*\n|\n", text)
                  if sum(char.isalpha() for char in chunk) >= 40]
        if len(confident_pages | _confident_sample_codes(detector, chunks[:40])) > 1:
            return {"language": "mul", "confidence": round(confidence, 4), "supported": False}
        if code is None:
            return {"language": "und", "confidence": round(confidence, 4), "supported": False}
        return {"language": code, "confidence": round(confidence, 4), "supported": code in DOCUMENT_LANGUAGE_CODES}
    except Exception:
        logger.exception("Document language detection failed; preserving upload as und")
        return {"language": "und", "confidence": 0.0, "supported": False}


def api_language_error(value: str, *, source: bool = False) -> dict[str, object]:
    return {
        "code": "unsupported_source_language" if source else "unsupported_target_language",
        "params": {"language": value},
        "fallback": "The selected language is not supported.",
    }
