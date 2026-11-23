"""Extract reader overlay coordinates only for pages near the viewport."""
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

import fitz

from config import CACHE_DIR
from services.atomic_io import atomic_write_text
from services.cache import IMAGES_LABEL_VERSION, get_cached_images, get_cached_pages
from services.reparse import _worker_command, document_parse_lock


def _cache_identity(doc_id, doc, pdf_path):
    engine = doc.get("parser_engine") or "pymupdf"
    version = doc.get("parser_version")
    revision = int(doc.get("content_revision") or 1)
    stat = os.stat(pdf_path)
    parts = (doc_id, engine, version, revision, stat.st_mtime_ns, stat.st_size, IMAGES_LABEL_VERSION)
    return hashlib.sha256(str(parts).encode()).hexdigest()


def load_image_window(doc_id, doc, pdf_path, page, *, single=False):
    engine = doc.get("parser_engine") or "pymupdf"
    version = doc.get("parser_version")
    revision = int(doc.get("content_revision") or 1)
    identity = _cache_identity(doc_id, doc, pdf_path)

    def cache_path(n):
        return Path(CACHE_DIR) / f"{doc_id}_{identity}_{n}_images_extract.json"

    with fitz.open(pdf_path) as source:
        center = min(page, len(source))
        radius = 0 if single else 15
        start, end = max(1, center - radius), min(len(source), center + radius)
        cached = get_cached_images(doc_id, pdf_path, engine, version, revision)
        if cached is not None:
            images = [item for item in cached if start <= item["page"] <= end]
            return {"start": start, "end": end, "images": images}
        with ExitStack() as locks:
            for n in range(start, end + 1):
                locks.enter_context(document_parse_lock(f"image-window-{identity}-{n}"))
            missing = [n for n in range(start, end + 1) if not cache_path(n).exists()]
            if missing:
                with tempfile.TemporaryDirectory() as tmp:
                    path = os.path.join(tmp, "window.pdf")
                    output = os.path.join(tmp, "images.json")
                    with fitz.open() as subset:
                        for n in missing:
                            subset.insert_pdf(source, from_page=n - 1, to_page=n - 1)
                        subset.save(path)
                    command, env = _worker_command(engine, path, output)
                    result = subprocess.run([*command, "--images-only"], env=env,
                                            capture_output=True, timeout=1800)
                    if result.returncode:
                        raise RuntimeError(result.stderr.decode(errors="replace")[-1000:])
                    by_page = {n: [] for n in missing}
                    for item in json.loads(Path(output).read_text()):
                        n = missing[item["page"] - 1]
                        by_page[n].append({**item, "page": n})
                    for n, items in by_page.items():
                        atomic_write_text(str(cache_path(n)), json.dumps(items))
            images = []
            for n in range(start, end + 1):
                images.extend(json.loads(cache_path(n).read_text()))
    return {"start": start, "end": end, "images": images}


def resolve_figure(doc_id, doc, pdf_path, label, source_page):
    """Try existing region caches before searching caption lines in the PDF."""
    from services.pdf_parser import _match_label_from_caption_text

    identity = _cache_identity(doc_id, doc, pdf_path)
    root = Path(CACHE_DIR)
    complete = get_cached_images(doc_id, pdf_path, doc.get("parser_engine"),
                                 doc.get("parser_version"), doc.get("content_revision"))
    matches = [item for item in complete or [] if item.get("label") == label]
    for path in root.glob(f"{doc_id}_{identity}_*_images_extract.json"):
        try:
            matches.extend(item for item in json.loads(path.read_text()) if item.get("label") == label)
        except (FileNotFoundError, ValueError):
            continue
    if matches:
        return min(matches, key=lambda item: abs(item["page"] - source_page))

    index_path = root / f"{doc_id}_{identity}_caption_pages.json"
    with document_parse_lock("caption-pages-" + identity):
        if index_path.exists():
            index = json.loads(index_path.read_text())
        else:
            index = {}
            with fitz.open(pdf_path) as pdf:
                for page in pdf:
                    for line in page.get_text().splitlines():
                        key, _ = _match_label_from_caption_text(line)
                        if key and key.startswith("Figure "):
                            pages = index.setdefault(key, [])
                            if not pages or pages[-1] != page.number + 1:
                                pages.append(page.number + 1)
            atomic_write_text(str(index_path), json.dumps(index))
    candidates = index.get(label, [])
    if not candidates:
        pages = get_cached_pages(doc_id, pdf_path, doc.get("parser_engine"),
                                 doc.get("parser_version"), doc.get("content_revision"))
        for page in pages or []:
            lines = (page.get("text") or "").splitlines()
            if any(_match_label_from_caption_text(line)[0] == label for line in lines):
                candidates.append(page["page_num"])
    for number in sorted(candidates, key=lambda n: abs(n - source_page)):
        window = load_image_window(doc_id, doc, pdf_path, number, single=True)
        for item in window["images"]:
            if item.get("label") == label:
                return item
    return None
