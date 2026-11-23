"""Per-document table bbox cache.

``Page.find_tables()`` is the most expensive per-page step of PDF parsing and
both layout normalization and figure/table extraction need it. Compute it once
per page and share the result between them.
"""
from __future__ import annotations

import os
import threading
from collections import OrderedDict
from functools import lru_cache

_MAX_DOCS = 4
_cache: "OrderedDict[str, dict[int, list[list[float]]]]" = OrderedDict()
_lock = threading.Lock()


@lru_cache(maxsize=32)
def _fingerprint(path: str, mtime_ns: int, size: int) -> str:
    from services.pdf_diagnostics import pdf_fingerprint
    return pdf_fingerprint(path)


def page_table_bboxes(page, pdf_path: str) -> list[list[float]]:
    """Return table bboxes of ``page``; detection failures yield an empty list."""
    stat = os.stat(pdf_path)
    key = _fingerprint(pdf_path, stat.st_mtime_ns, stat.st_size)
    with _lock:
        pages = _cache.setdefault(key, {})
        _cache.move_to_end(key)
        while len(_cache) > _MAX_DOCS:
            _cache.popitem(last=False)
        if page.number in pages:
            return [list(b) for b in pages[page.number]]
    try:
        boxes = [list(t.bbox) for t in page.find_tables().tables]
    except Exception:
        boxes = []
    with _lock:
        pages[page.number] = boxes
    return [list(b) for b in boxes]
