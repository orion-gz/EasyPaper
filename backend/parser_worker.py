"""Isolated parser worker used by reparse previews."""
from __future__ import annotations

import argparse
import json
import os
import sys

from services.atomic_io import atomic_write_text
from services.pdf_diagnostics import diagnose_pages, parser_version, pdf_fingerprint
from services.pdf_parser import extract_pages, extract_pdf_images


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--engine", required=True, choices=("pymupdf", "pdfplumber", "marker", "mineru"))
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    pages = extract_pages(args.pdf, engine=args.engine)
    actual_engines = {str(page.get("parser_engine") or "") for page in pages}
    if not pages or actual_engines != {args.engine}:
        actual = ", ".join(sorted(actual_engines)) or "no output"
        raise RuntimeError(f"{args.engine} parser unavailable; worker returned {actual}")

    images = extract_pdf_images(args.pdf, engine=args.engine)
    version = parser_version(args.engine)
    payload = {
        "pdf_fingerprint": pdf_fingerprint(args.pdf),
        "parser_engine": args.engine,
        "parser_version": version,
        "pages": pages,
        "images": images,
        "diagnostics": diagnose_pages(pages, images, args.engine, version),
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    atomic_write_text(args.output, json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"parser_worker_failed: {exc}", file=sys.stderr)
        raise
