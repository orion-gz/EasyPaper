"""Extract reader overlay coordinates only for pages near the viewport."""
from contextlib import ExitStack
import hashlib
import json
import logging
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time

import fitz

from config import CACHE_DIR
from services.atomic_io import atomic_write_text
from services.cache import IMAGES_LABEL_VERSION, get_cached_images, get_cached_pages
from services.reparse import _worker_command, document_parse_lock

_ORIG_SUBPROCESS_RUN = subprocess.run
_jobs_lock = threading.Lock()
_active_window_jobs: dict[str, "_WindowJob"] = {}
_stopping_window_jobs: dict[str, "_WindowJob"] = {}
_last_preempted_info: dict[str, dict] = {}
_failed_window_identities: set[tuple[str, str]] = set()

_HEAVY_ENGINES = {"marker", "mineru"}
_HEAVY_WINDOW_RADIUS = 4
_DEFAULT_WINDOW_RADIUS = 15


def _cache_identity(doc_id, doc, pdf_path):
    engine = doc.get("parser_engine") or "pymupdf"
    version = doc.get("parser_version")
    revision = int(doc.get("content_revision") or 1)
    stat = os.stat(pdf_path)
    parts = (doc_id, engine, version, revision, stat.st_mtime_ns, stat.st_size, IMAGES_LABEL_VERSION)
    return hashlib.sha256(str(parts).encode()).hexdigest()


def _page_cache_path(cache_dir: str | Path, doc_id: str, identity: str, page_num: int) -> Path:
    return Path(cache_dir) / f"{doc_id}_{identity}_{page_num}_images_extract.json"


def _provisional_cache_path(cache_dir: str | Path, doc_id: str, identity: str, page_num: int) -> Path:
    return Path(cache_dir) / f"{doc_id}_{identity}_{page_num}_provisional_images.json"


def _read_json_list(path: Path) -> list[dict]:
    try:
        if path.exists():
            data = json.loads(path.read_text())
            if isinstance(data, list):
                return data
    except (OSError, ValueError):
        pass
    return []


class _WindowJob:
    """Preemptive single-slot background extraction job for heavy parsers (marker/mineru).

    When the user scrolls to a new window, any older pending/running job for the same
    document is immediately terminated and removed so stale requests never pile up or
    waste RAM/VRAM.
    """

    def __init__(self, doc_id: str, identity: str, engine: str, pdf_path: str, pages: tuple[int, ...], cache_dir: str):
        self.doc_id = doc_id
        self.identity = identity
        self.engine = engine
        self.pdf_path = pdf_path
        self.pages = pages
        self.cache_dir = cache_dir
        self.cancelled = False
        self.done = False
        self.status = "running"
        self.started_at = time.monotonic()
        self.current_page = pages[0] if pages else 1
        self.percent = 10
        self.process: subprocess.Popen | None = None
        self._lock = threading.Lock()
        self.thread: threading.Thread | None = None

    def snapshot_progress(self) -> dict:
        pages = list(self.pages)
        if not pages:
            return {"state": "idle", "page": 1, "start_page": 1, "end_page": 1, "percent": 0}
        if self.status == "running" and not self.done and not self.cancelled:
            elapsed = max(0.0, time.monotonic() - self.started_at)
            # Estimate intra-batch progress smoothly between 15% and 88% while worker runs
            est_ratio = min(0.88, 0.15 + (elapsed / max(2.5, len(pages) * 1.2)) * 0.73)
            pct = max(self.percent, int(round(est_ratio * 100)))
            idx = min(len(pages) - 1, int(est_ratio * len(pages)))
            cur_page = pages[idx]
        else:
            pct = self.percent
            cur_page = self.current_page
        return {
            "state": "stopping" if self.cancelled or self.status == "stopping" else self.status,
            "page": cur_page,
            "start_page": pages[0],
            "end_page": pages[-1],
            "pages": pages,
            "percent": max(0, min(99, int(pct))),
        }

    def cancel(self) -> None:
        with self._lock:
            self.cancelled = True
            self.status = "stopping"
            proc = self.process
        if proc is not None and proc.poll() is None:
            pid = getattr(proc, "pid", None)
            if isinstance(pid, int) and pid > 0 and hasattr(os, "killpg"):
                try:
                    os.killpg(pid, signal.SIGTERM)
                except OSError:
                    pass
            try:
                proc.terminate()
                try:
                    proc.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    if isinstance(pid, int) and pid > 0 and hasattr(os, "killpg"):
                        try:
                            os.killpg(pid, signal.SIGKILL)
                        except OSError:
                            pass
                    proc.kill()
            except OSError:
                pass


def cancel_window_jobs(doc_id: str | None = None) -> int:
    """Stop and remove active/queued window extraction jobs (for a document or globally)."""
    with _jobs_lock:
        if doc_id is None:
            jobs = list(_active_window_jobs.values()) + list(_stopping_window_jobs.values())
            _active_window_jobs.clear()
            _stopping_window_jobs.clear()
            _last_preempted_info.clear()
            _failed_window_identities.clear()
        else:
            job = _active_window_jobs.pop(doc_id, None)
            stopping = _stopping_window_jobs.pop(doc_id, None)
            _last_preempted_info.pop(doc_id, None)
            jobs = [j for j in (job, stopping) if j is not None]
            for key in [k for k in _failed_window_identities if k[0] == doc_id]:
                _failed_window_identities.discard(key)
    for job in jobs:
        job.cancel()
    return len(jobs)


def _run_precise_window_job(job: _WindowJob) -> None:
    try:
        if job.cancelled:
            return
        missing = [
            n for n in job.pages
            if not _page_cache_path(job.cache_dir, job.doc_id, job.identity, n).exists()
        ]
        if not missing or job.cancelled:
            return
        with tempfile.TemporaryDirectory() as tmp:
            subset_path = os.path.join(tmp, "window.pdf")
            output_path = os.path.join(tmp, "images.json")
            with fitz.open(job.pdf_path) as source, fitz.open() as subset:
                for n in missing:
                    subset.insert_pdf(source, from_page=n - 1, to_page=n - 1)
                subset.save(subset_path)
            if job.cancelled:
                return
            command, env = _worker_command(job.engine, subset_path, output_path)
            with job._lock:
                if job.cancelled:
                    return
                proc = subprocess.Popen(
                    [*command, "--images-only"],
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    start_new_session=True,
                )
                job.process = proc
            try:
                _, stderr = proc.communicate(timeout=1800)
            except subprocess.TimeoutExpired:
                job.cancel()
                proc.communicate()
                return
            if job.cancelled or proc.returncode != 0:
                if not job.cancelled and proc.returncode != 0:
                    with _jobs_lock:
                        _failed_window_identities.add((job.doc_id, job.identity))
                    logging.getLogger(__name__).warning(
                        "Background image window extraction failed for %s (%s): %s",
                        job.doc_id, job.engine, (stderr or b"").decode(errors="replace")[-500:],
                    )
                return
            output_file = Path(output_path)
            if not output_file.exists() or job.cancelled:
                return
            by_page = {n: [] for n in missing}
            for item in _read_json_list(output_file):
                idx = int(item.get("page", 0)) - 1
                if 0 <= idx < len(missing):
                    n = missing[idx]
                    by_page[n].append({**item, "page": n})
            if job.cancelled:
                return
            for idx_written, (n, items) in enumerate(by_page.items(), start=1):
                if job.cancelled:
                    return
                job.current_page = n
                job.percent = min(99, 88 + int(11 * idx_written / max(1, len(by_page))))
                with document_parse_lock(f"image-window-{job.identity}-{n}"):
                    target = _page_cache_path(job.cache_dir, job.doc_id, job.identity, n)
                    atomic_write_text(str(target), json.dumps(items))
    except Exception:
        if not job.cancelled:
            job.status = "error"
            with _jobs_lock:
                _failed_window_identities.add((job.doc_id, job.identity))
            logging.getLogger(__name__).exception("Unexpected error in background image window job for %s", job.doc_id)
    finally:
        job.done = True
        with _jobs_lock:
            if _active_window_jobs.get(job.doc_id) is job:
                _active_window_jobs.pop(job.doc_id, None)
            if _stopping_window_jobs.get(job.doc_id) is job:
                _stopping_window_jobs.pop(job.doc_id, None)


def schedule_precise_window_job(
    doc_id: str,
    identity: str,
    engine: str,
    pdf_path: str,
    pages: list[int],
    *,
    cache_dir: str | None = None,
) -> _WindowJob | None:
    """Replace any older window extraction job for doc_id with the latest requested pages."""
    target_pages = tuple(sorted(set(pages)))
    if not target_pages:
        return None
    resolved_cache_dir = str(cache_dir or CACHE_DIR)
    prev_to_cancel: _WindowJob | None = None
    with _jobs_lock:
        if (doc_id, identity) in _failed_window_identities:
            return None
        existing = _active_window_jobs.get(doc_id)
        if existing is not None and not existing.done and not existing.cancelled:
            if existing.identity == identity and set(target_pages).issubset(existing.pages):
                return existing
            prev_to_cancel = existing
            _active_window_jobs.pop(doc_id, None)
            snap = existing.snapshot_progress()
            _stopping_window_jobs[doc_id] = existing
            _last_preempted_info[doc_id] = {**snap, "at": time.monotonic()}
        job = _WindowJob(doc_id, identity, engine, pdf_path, target_pages, resolved_cache_dir)
        _active_window_jobs[doc_id] = job
    if prev_to_cancel is not None:
        prev_to_cancel.cancel()
        with _jobs_lock:
            if _stopping_window_jobs.get(doc_id) is prev_to_cancel:
                _stopping_window_jobs.pop(doc_id, None)
    thread = threading.Thread(
        target=_run_precise_window_job,
        args=(job,),
        name=f"image-window-{doc_id}",
        daemon=True,
    )
    job.thread = thread
    thread.start()
    return job


def _build_extraction_status(doc_id: str, identity: str, start: int, end: int, job: _WindowJob | None) -> dict:
    with _jobs_lock:
        failed = (doc_id, identity) in _failed_window_identities
        stopping = _stopping_window_jobs.get(doc_id)
        preempted = _last_preempted_info.pop(doc_id, None)
        active = job or _active_window_jobs.get(doc_id)
    if failed:
        return {
            "state": "error",
            "page": start,
            "start_page": start,
            "end_page": end,
            "percent": 0,
        }
    if stopping is not None and not stopping.done:
        snap = stopping.snapshot_progress()
        return {**snap, "state": "stopping", "preempted": True}
    if active is not None and not active.done and not active.cancelled:
        snap = active.snapshot_progress()
        if preempted and (time.monotonic() - preempted.get("at", 0)) < 2.0:
            snap["preempted"] = True
            snap["stopped_page"] = preempted.get("page")
            snap["stopped_start_page"] = preempted.get("start_page")
            snap["stopped_end_page"] = preempted.get("end_page")
            snap["stopped_percent"] = preempted.get("percent", 0)
        return snap
    return {
        "state": "idle",
        "page": start,
        "start_page": start,
        "end_page": end,
        "percent": 100,
    }


def _extract_inprocess_pymupdf_pages(source, pdf_path: str, pages: list[int], path_fn) -> None:
    from services.pdf_parser import _extract_pdf_images_from_doc

    extracted = _extract_pdf_images_from_doc(source, pdf_path, "pymupdf", page_numbers=pages)
    by_page = {n: [] for n in pages}
    for item in extracted:
        p = item.get("page")
        if p in by_page:
            by_page[p].append(item)
    for n, items in by_page.items():
        atomic_write_text(str(path_fn(n)), json.dumps(items))


def load_image_window(doc_id, doc, pdf_path, page, *, single=False):
    engine = doc.get("parser_engine") or "pymupdf"
    version = doc.get("parser_version")
    revision = int(doc.get("content_revision") or 1)
    identity = _cache_identity(doc_id, doc, pdf_path)
    custom_runner = subprocess.run is not _ORIG_SUBPROCESS_RUN

    def cache_path(n):
        return _page_cache_path(CACHE_DIR, doc_id, identity, n)

    def provisional_path(n):
        return _provisional_cache_path(CACHE_DIR, doc_id, identity, n)

    with fitz.open(pdf_path) as source:
        total_pages = len(source)
        if total_pages == 0:
            return {"start": 1, "end": 0, "images": []}
        center = min(max(1, page), total_pages)
        if single:
            radius = 0
        elif engine in _HEAVY_ENGINES and not custom_runner:
            radius = _HEAVY_WINDOW_RADIUS
        else:
            radius = _DEFAULT_WINDOW_RADIUS
        start, end = max(1, center - radius), min(total_pages, center + radius)
        cached = get_cached_images(doc_id, pdf_path, engine, version, revision)
        if cached is not None:
            images = [item for item in cached if start <= item["page"] <= end]
            return {"start": start, "end": end, "images": images}

        with ExitStack() as locks:
            for n in range(start, end + 1):
                locks.enter_context(document_parse_lock(f"image-window-{identity}-{n}"))
            missing = [n for n in range(start, end + 1) if not cache_path(n).exists()]

            if missing and engine in _HEAVY_ENGINES and not custom_runner:
                # Always schedule the full surrounding heavy window (center ± _HEAVY_WINDOW_RADIUS)
                # so the immediate follow-up single=False request reuses the running worker
                # instead of preempting the single=True worker.
                bg_start = max(1, center - _HEAVY_WINDOW_RADIUS)
                bg_end = min(total_pages, center + _HEAVY_WINDOW_RADIUS)
                bg_missing = [n for n in range(bg_start, bg_end + 1) if not cache_path(n).exists()]
                job = schedule_precise_window_job(
                    doc_id, identity, engine, pdf_path, bg_missing, cache_dir=str(CACHE_DIR),
                )
                missing_provisional = [n for n in missing if not provisional_path(n).exists()]
                if missing_provisional:
                    _extract_inprocess_pymupdf_pages(source, pdf_path, missing_provisional, provisional_path)
                images = []
                for n in range(start, end + 1):
                    p_file = cache_path(n) if cache_path(n).exists() else provisional_path(n)
                    images.extend(_read_json_list(p_file))
                # If the background worker failed permanently for this identity, stop asking
                # the client to poll repeatedly.
                return {
                    "start": start,
                    "end": end,
                    "images": images,
                    "provisional": job is not None,
                    "extraction_status": _build_extraction_status(doc_id, identity, bg_start, bg_end, job),
                }

            if missing:
                if engine == "pymupdf" and not custom_runner:
                    _extract_inprocess_pymupdf_pages(source, pdf_path, missing, cache_path)
                else:
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
                        for item in _read_json_list(Path(output)):
                            idx = int(item.get("page", 0)) - 1
                            if 0 <= idx < len(missing):
                                n = missing[idx]
                                by_page[n].append({**item, "page": n})
                        for n, items in by_page.items():
                            atomic_write_text(str(cache_path(n)), json.dumps(items))
            images = []
            for n in range(start, end + 1):
                images.extend(_read_json_list(cache_path(n)))
    return {"start": start, "end": end, "images": images}


def resolve_figure(doc_id, doc, pdf_path, label, source_page):
    """Try existing region caches before searching caption lines in the PDF."""
    from services.pdf_parser import _match_label_from_caption_text

    identity = _cache_identity(doc_id, doc, pdf_path)
    root = Path(CACHE_DIR)
    complete = get_cached_images(doc_id, pdf_path, doc.get("parser_engine"),
                                 doc.get("parser_version"), doc.get("content_revision"))
    matches = [item for item in complete or [] if item.get("label") == label]
    for pattern in (
        f"{doc_id}_{identity}_*_images_extract.json",
        f"{doc_id}_{identity}_*_provisional_images.json",
    ):
        for path in root.glob(pattern):
            matches.extend(item for item in _read_json_list(path) if item.get("label") == label)
    if matches:
        return min(matches, key=lambda item: abs(item["page"] - source_page))

    index_path = root / f"{doc_id}_{identity}_caption_pages.json"
    with document_parse_lock("caption-pages-" + identity):
        if index_path.exists():
            try:
                index = json.loads(index_path.read_text())
            except (OSError, ValueError):
                index = {}
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
