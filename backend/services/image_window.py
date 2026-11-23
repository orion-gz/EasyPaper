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
from services.cache import IMAGES_LABEL_VERSION, get_cached_images
from services.reparse import _worker_command, document_parse_lock


def load_image_window(doc_id, doc, pdf_path, page, *, single=False):
    engine = doc.get("parser_engine") or "pymupdf"
    version = doc.get("parser_version")
    revision = int(doc.get("content_revision") or 1)
    stat = os.stat(pdf_path)
    identity = hashlib.sha256(str((doc_id, engine, version, revision, stat.st_mtime_ns,
                                   stat.st_size, IMAGES_LABEL_VERSION)).encode()).hexdigest()

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
