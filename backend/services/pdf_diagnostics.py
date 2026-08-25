"""Parser identity, PDF fingerprints, and page-quality diagnostics."""
from __future__ import annotations

import hashlib
import importlib.metadata
import re
import unicodedata
from collections import Counter
from typing import Any, Iterable

PAGES_CACHE_SCHEMA_VERSION = 2
_PARSER_DISTRIBUTIONS = {
    "pymupdf": "PyMuPDF",
    "pdfplumber": "pdfplumber",
    "marker": "marker-pdf",
    "mineru": "mineru",
}
_MOJIBAKE_RE = re.compile(r"(?:Ã.|Â.|â€|\ufffd)")
_PRIVATE_INDENT_SENTINEL = "\ue000"


def pdf_fingerprint(pdf_path: str) -> str:
    digest = hashlib.sha256()
    with open(pdf_path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parser_version(engine: str) -> str:
    distribution = _PARSER_DISTRIBUTIONS.get((engine or "pymupdf").lower(), engine)
    try:
        return importlib.metadata.version(distribution)
    except (importlib.metadata.PackageNotFoundError, TypeError):
        return "unknown"


def parser_identity(engine: str | None = None) -> tuple[str, str]:
    if engine is None:
        try:
            from config import get_pdf_parser_engine
            engine = get_pdf_parser_engine()
        except Exception:
            engine = "pymupdf"
    normalized = (engine or "pymupdf").strip().lower()
    return normalized, parser_version(normalized)


def _abnormal_character_ratio(text: str) -> float:
    if not text:
        return 0.0
    abnormal = 0
    for char in text:
        if char == _PRIVATE_INDENT_SENTINEL or char.isspace():
            continue
        category = unicodedata.category(char)
        if char == "\ufffd" or category in {"Cc", "Cs", "Co", "Cn"}:
            abnormal += 1
    return abnormal / max(1, len(text))


def _repeated_lines(text: str) -> tuple[int, float]:
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines()]
    lines = [line for line in lines if len(line) >= 8]
    counts = Counter(lines)
    repeated = sum(count - 1 for count in counts.values() if count > 1)
    return repeated, repeated / max(1, len(lines))


def _block_count(page: dict) -> int:
    blocks = page.get("blocks")
    return len(blocks) if isinstance(blocks, list) else 0


def _suspicious_reading_order(page: dict) -> bool:
    explicit = page.get("reading_order_suspicious")
    if isinstance(explicit, bool):
        return explicit
    blocks = page.get("blocks")
    if not isinstance(blocks, list) or len(blocks) < 4:
        return False
    centers = []
    for block in blocks:
        bbox = block.get("bbox") if isinstance(block, dict) else None
        if not bbox or len(bbox) != 4:
            continue
        centers.append(((float(bbox[0]) + float(bbox[2])) / 2, float(bbox[1])))
    if len(centers) < 4:
        return False
    page_mid = (min(x for x, _ in centers) + max(x for x, _ in centers)) / 2
    sides = [x >= page_mid for x, _ in centers]
    switches = sum(a != b for a, b in zip(sides, sides[1:]))
    return bool(page.get("is_two_column")) and switches > 2


def _visual_counts(images: Iterable[dict], page_num: int) -> tuple[int, int]:
    image_count = 0
    table_count = 0
    for item in images:
        if int(item.get("page_num") or item.get("page") or 0) != page_num:
            continue
        label = str(item.get("label") or "").lower()
        kind = str(item.get("kind") or item.get("type") or "").lower()
        if label.startswith("table") or kind == "table":
            table_count += 1
        else:
            image_count += 1
    return image_count, table_count


def diagnose_pages(pages: list[dict], images: list[dict] | None = None,
                   engine: str | None = None, version: str | None = None) -> dict[str, Any]:
    images = images or []
    page_reports = []
    problem_pages = []
    for page in pages:
        page_num = int(page.get("page_num") or len(page_reports) + 1)
        text = str(page.get("text") or "")
        stripped = text.strip()
        replacement_count = len(_MOJIBAKE_RE.findall(text))
        broken_ratio = replacement_count / max(1, len(text))
        repeated_count, repeated_ratio = _repeated_lines(text)
        abnormal_ratio = _abnormal_character_ratio(text)
        image_count, table_count = _visual_counts(images, page_num)
        ocr_confidence = page.get("ocr_confidence")
        if not isinstance(ocr_confidence, (int, float)):
            ocr_confidence = None

        language = "und"
        language_confidence = 0.0
        if stripped:
            try:
                from services.languages import detect_document_language
                detected = detect_document_language([{"page_num": page_num, "text": text}])
                language = str(detected.get("language") or "und")
                language_confidence = float(detected.get("confidence") or 0.0)
            except Exception:
                pass

        suspicious_order = _suspicious_reading_order(page)
        issues = []
        if not stripped:
            issues.append("empty_text")
        if broken_ratio > 0.005:
            issues.append("broken_characters")
        if repeated_ratio > 0.15:
            issues.append("repeated_lines")
        if abnormal_ratio > 0.01:
            issues.append("abnormal_characters")
        if suspicious_order:
            issues.append("reading_order")
        if stripped and language_confidence < 0.35:
            issues.append("low_language_confidence")
        if issues:
            problem_pages.append(page_num)

        page_reports.append({
            "page_num": page_num,
            "empty_text": not bool(stripped),
            "broken_character_ratio": round(broken_ratio, 6),
            "repeated_line_count": repeated_count,
            "repeated_line_ratio": round(repeated_ratio, 6),
            "abnormal_character_ratio": round(abnormal_ratio, 6),
            "block_count": _block_count(page),
            "suspicious_reading_order": suspicious_order,
            "image_count": image_count,
            "table_count": table_count,
            "detected_language": language,
            "language_confidence": round(language_confidence, 6),
            "ocr_confidence": ocr_confidence,
            "issues": issues,
            "preview": stripped[:600],
        })

    resolved_engine = engine or next(
        (str(page.get("parser_engine")) for page in pages if page.get("parser_engine")), "unknown"
    )
    return {
        "parser_engine": resolved_engine,
        "parser_version": version or parser_version(resolved_engine),
        "page_count": len(pages),
        "problem_pages": problem_pages,
        "problem_page_count": len(problem_pages),
        "empty_page_count": sum(1 for page in page_reports if page["empty_text"]),
        "image_count": sum(page["image_count"] for page in page_reports),
        "table_count": sum(page["table_count"] for page in page_reports),
        "pages": page_reports,
    }
