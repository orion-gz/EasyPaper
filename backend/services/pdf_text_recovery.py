"""Recover unmapped PDF glyphs locally; never interpret glyph IDs as Unicode."""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import fitz


class TextRecoveryError(RuntimeError):
    def __init__(self, code):
        super().__init__(code)
        self.document_task_error_code = code


def needs_text_recovery(page: fitz.Page) -> bool:
    text = page.get_text("text", flags=fitz.TEXTFLAGS_TEXT & ~fitz.TEXT_CID_FOR_UNKNOWN_UNICODE)
    visible = "".join(text.split())
    # A few missing symbols do not justify replacing otherwise usable text.
    return visible.count("\ufffd") >= 3 and visible.count("\ufffd") / len(visible) >= 0.02


def _ocr_config() -> tuple[str, list[str]]:
    try:
        result = subprocess.run(["tesseract", "--list-langs"], capture_output=True,
                                text=True, check=True, timeout=15)
        match = re.search(r'"([^"]+)"', result.stdout)
        directory = os.environ.get("TESSDATA_PREFIX") or (match.group(1) if match else "")
        languages = sorted(path.stem for path in Path(directory).glob("*.traineddata")
                           if path.stem not in {"osd", "equ"}) if directory else []
        if not languages:
            raise TextRecoveryError("pdf_ocr_unavailable")
        return directory, languages
    except (OSError, subprocess.SubprocessError) as exc:
        raise TextRecoveryError("pdf_ocr_unavailable") from exc


_SCRIPT_LANGUAGES = {
    "Japanese": {"jpn", "jpn_vert"}, "Korean": {"kor", "kor_vert"},
    "Han": {"chi_sim", "chi_tra", "jpn"},
    "Arabic": {"ara", "fas", "urd"}, "Hebrew": {"heb"},
    "Cyrillic": {"rus", "ukr", "bul", "srp"}, "Greek": {"ell"},
    "Devanagari": {"hin", "mar", "nep"}, "Bengali": {"ben"}, "Thai": {"tha"},
    "Latin": {"eng", "deu", "fra", "spa", "por", "ita", "nld", "pol", "ces",
              "slk", "hrv", "slv", "swe", "dan", "nor", "fin", "est", "lav",
              "lit", "tur", "ind", "vie", "swa"},
}


def recover_text(page: fitz.Page, context: dict) -> dict:
    """Return OCR blocks in the same unrotated point coordinates as get_text."""
    if "config" not in context:
        context["config"] = _ocr_config()
    directory, installed = context["config"]
    override = os.environ.get("EASYPAPER_OCR_LANGUAGES", "").strip()
    # Fonts may cover several scripts. Detect each page independently so a
    # multilingual document can reuse one font without reusing the wrong model.
    language = override
    if not language:
        supported = set().union(*_SCRIPT_LANGUAGES.values())
        selected = [lang for lang in installed if lang in supported]
        if not selected:
            raise TextRecoveryError("pdf_ocr_language_missing")
        try:
            pixmap = page.get_pixmap(dpi=120)
            result = subprocess.run(
                ["tesseract", "stdin", "stdout", "--psm", "0", "--tessdata-dir", directory],
                input=pixmap.tobytes("png"), capture_output=True, timeout=30,
                env={**os.environ, "OMP_THREAD_LIMIT": "1"},
            )
            script = re.search(r"^Script: (.+)$", result.stdout.decode(), re.MULTILINE)
            if script and script.group(1) in _SCRIPT_LANGUAGES:
                selected = [lang for lang in installed if lang in _SCRIPT_LANGUAGES[script.group(1)]]
                if not selected:
                    raise TextRecoveryError("pdf_ocr_language_missing")
                if "eng" in installed and "eng" not in selected:
                    selected.append("eng")
        except (OSError, subprocess.SubprocessError):
            pass
        language = "+".join(selected)
    if not set(language.split("+")).issubset(installed):
        raise TextRecoveryError("pdf_ocr_language_missing")
    try:
        textpage = page.get_textpage_ocr(language=language, dpi=200, full=True, tessdata=directory)
        result = textpage.extractDICT(sort=True)
        if not any(span.get("text", "").strip() for block in result["blocks"]
                   for line in block.get("lines", []) for span in line["spans"]):
            raise TextRecoveryError("pdf_ocr_failed")
        return result
    except TextRecoveryError:
        raise
    except Exception as exc:
        raise TextRecoveryError("pdf_ocr_failed") from exc
