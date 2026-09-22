"""Deterministic protected-literal checks for general-document translation."""
from __future__ import annotations
import re

_URL = re.compile(r"https?://[^\s<>()\]]+")
_INLINE_CODE = re.compile(r"`([^`\n]+)`")
# A unit must end here: the 's' in 'Figure 2.20 shows' is not seconds.
_NUMBER_UNIT = re.compile(r"(?<![\w.])(?:[-+]?\d+(?:[.,]\d+)*\s?(?:%|ms|s|MB|GB|KB|Hz|kHz|MHz|GHz|°C|V|A|mA|kg|km|cm|mm)(?!\w)|[-+]?\d+(?:[.,]\d+)*(?![%\w.]))")
_COMMAND = re.compile(r"(?m)^(?:\$\s*)?((?:sudo|curl|wget|npm|npx|pnpm|yarn|pip|python|docker|kubectl|git)\s+[^\n]+)$")
_PATH = re.compile(r"(?<![:/\w])(?:/(?:[\w-]+/)*[\w-]+(?:\.[\w-]+)*|[A-Za-z]:\\(?:[^\s\\]+\\)*[^\s\\]+)")


# English decades are calendar values, not durations in seconds. Preserve the
# year while allowing the suffix to be translated (1960s -> 1960년대).
_DECADE = re.compile(r"\b((?:1[0-9]|20)[0-9]0)(?:['’]?s)\b")


class TranslationIntegrityError(ValueError):
    document_task_error_code = "translation_integrity_failed"

    def __init__(self, message: str, missing=()):
        super().__init__(message)
        self.error_params = {"missing": ", ".join(str(value)[:100] for value in missing[:5])}


def protected_literals(source: str) -> list[str]:
    values = []
    for pattern in (_URL, _INLINE_CODE, _COMMAND, _PATH, _NUMBER_UNIT):
        text = source or ""
        if pattern is _NUMBER_UNIT:
            text = _DECADE.sub(r"\1 ", text)
        for match in pattern.finditer(text):
            value = match.group(1) if pattern in (_INLINE_CODE, _COMMAND) else match.group(0)
            value = value.rstrip(".,;:") if pattern is _URL else value
            if value and value not in values:
                values.append(value)
    return values


def validate_translation_integrity(source: str, translation: str) -> dict:
    protected = protected_literals(source)
    missing = [value for value in protected if value not in (translation or "")]
    return {"valid": not missing, "protected_count": len(protected), "missing": missing}


def assert_translation_integrity(source: str, translation: str) -> None:
    result = validate_translation_integrity(source, translation)
    if result["missing"]:
        preview = ", ".join(repr(item) for item in result["missing"][:5])
        raise TranslationIntegrityError(f"보호해야 할 코드·URL·수치가 번역에서 변경되었습니다: {preview}", result["missing"])


def check_translation_integrity(source: str, translation: str, *, style: str = "academic",
                                ignore_math: bool = False, ignore_table: bool = False,
                                ignore_refs: bool = False) -> list[dict]:
    """Full-page literal checks cannot distinguish intentional omissions from loss.

    Parsers may flatten tables into prose, so excluding only Markdown tables is
    insufficient. Surface missing literals as warnings for selective requests;
    keep strict rejection for full translations and always reject empty output.
    """
    from services.generation_errors import GenerationError

    if not translation.strip():
        raise GenerationError("translation_empty", "Translation returned no text.")
    try:
        assert_translation_integrity(source, translation)
    except TranslationIntegrityError as exc:
        if not (ignore_math or ignore_table or ignore_refs or style == "summary"):
            raise
        return [{"code": "translation_integrity_warning", "params": exc.error_params,
                 "fallback": "Some source values are absent. Omission options or summary style may explain this; compare with the original."}]
    return []
