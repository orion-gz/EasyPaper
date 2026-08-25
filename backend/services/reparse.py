"""Candidate parser previews and atomic content-revision application."""
from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from typing import Any

from config import LIBRARY_DIR
from services.db import get_db
from services.pdf_diagnostics import diagnose_pages, parser_identity, pdf_fingerprint

_ALLOWED_ENGINES = {"pymupdf", "pdfplumber", "marker", "mineru"}
_preview_workers: dict[str, asyncio.Task] = {}
_apply_locks: dict[str, asyncio.Lock] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _decode_json(value: str | None) -> dict | None:
    if not value:
        return None
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return None


def _preview_row(task_id: str) -> dict | None:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM reparse_previews WHERE id = ?", (task_id,)).fetchone()
    if not row:
        return None
    result = dict(row)
    result["current_report"] = _decode_json(result.get("current_report"))
    result["candidate_report"] = _decode_json(result.get("candidate_report"))
    result.pop("staging_path", None)
    return result


def get_preview(task_id: str) -> dict | None:
    return _preview_row(task_id)


def get_diagnostics(doc_id: str, revision: int | None = None) -> dict | None:
    with get_db() as conn:
        if revision is None:
            row = conn.execute(
                """SELECT p.report FROM parsing_diagnostics p JOIN documents d ON d.id = p.doc_id
                   WHERE p.doc_id = ? AND p.content_revision = d.content_revision""",
                (doc_id,),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT report FROM parsing_diagnostics WHERE doc_id = ? AND content_revision = ?",
                (doc_id, int(revision)),
            ).fetchone()
    return _decode_json(row["report"]) if row else None



def save_diagnostics(doc_id: str, revision: int, report: dict) -> None:
    with get_db() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO parsing_diagnostics
               (doc_id, content_revision, parser_engine, parser_version, report, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                doc_id, int(revision), report.get("parser_engine") or "unknown",
                report.get("parser_version"), json.dumps(report, ensure_ascii=False), _now(),
            ),
        )
        conn.commit()


def _staging_path(doc_id: str, task_id: str) -> str:
    return os.path.join(LIBRARY_DIR, doc_id, "reparse_previews", f"{task_id}.json")


def _worker_command(engine: str, pdf_path: str, output_path: str) -> tuple[list[str], dict[str, str]]:
    import venv_manager

    env = dict(os.environ)
    python_executable = sys.executable
    if not venv_manager.is_packaged_desktop():
        target_venv = venv_manager.required_venv_for_engine(engine)
        if venv_manager.is_venv_available(target_venv):
            python_executable = venv_manager.venv_python(target_venv)
    elif engine != "pymupdf":
        package_dir = venv_manager.parser_packages_dir(engine)
        existing = env.get("PYTHONPATH")
        env["PYTHONPATH"] = package_dir if not existing else os.pathsep.join((package_dir, existing))

    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    command = [
        python_executable,
        os.path.join(backend_dir, "parser_worker.py"),
        "--pdf", pdf_path,
        "--engine", engine,
        "--output", output_path,
    ]
    return command, env



def parse_document_isolated(pdf_path: str, engine: str) -> dict:
    """Run an applied advanced parser in its managed environment without changing globals."""
    import subprocess
    import tempfile

    with tempfile.TemporaryDirectory(prefix="easypaper-parser-") as temp_dir:
        output_path = os.path.join(temp_dir, "result.json")
        command, env = _worker_command(engine, pdf_path, output_path)
        result = subprocess.run(
            command,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=1800,
            check=False,
        )
        if result.returncode != 0:
            message = result.stderr.decode("utf-8", errors="replace")[-1000:]
            raise RuntimeError(message or "isolated parser failed")
        with open(output_path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    if payload.get("parser_engine") != engine or not isinstance(payload.get("pages"), list):
        raise RuntimeError("isolated parser returned invalid output")
    return payload


async def _run_preview(task_id: str, pdf_path: str) -> None:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM reparse_previews WHERE id = ?", (task_id,)).fetchone()
        if not row:
            return
        preview = dict(row)
        conn.execute(
            "UPDATE reparse_previews SET status = 'running', updated_at = ? WHERE id = ?",
            (_now(), task_id),
        )
        conn.commit()

    output_path = preview["staging_path"]
    command, env = _worker_command(preview["candidate_engine"], pdf_path, output_path)
    process = None
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL,
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=1800)
        if process.returncode != 0:
            message = stderr.decode("utf-8", errors="replace")[-1000:]
            raise RuntimeError(message or stdout.decode("utf-8", errors="replace")[-1000:])
        with open(output_path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        report = payload.get("diagnostics")
        if not isinstance(report, dict):
            raise ValueError("candidate diagnostics missing")
        with get_db() as conn:
            conn.execute(
                """UPDATE reparse_previews
                   SET status = 'succeeded', candidate_report = ?, last_error_code = NULL, updated_at = ?
                   WHERE id = ?""",
                (json.dumps(report, ensure_ascii=False), _now(), task_id),
            )
            conn.commit()
    except asyncio.CancelledError:
        if process is not None and process.returncode is None:
            process.kill()
            await process.wait()
        with get_db() as conn:
            conn.execute(
                "UPDATE reparse_previews SET status = 'cancelled', updated_at = ? WHERE id = ?",
                (_now(), task_id),
            )
            conn.commit()
        raise
    except Exception as exc:
        if process is not None and process.returncode is None:
            process.kill()
            await process.wait()
        code = "parser_unavailable" if "unavailable" in str(exc).lower() or "no such file" in str(exc).lower() else "reparse_failed"
        with get_db() as conn:
            conn.execute(
                """UPDATE reparse_previews
                   SET status = 'failed', last_error_code = ?, updated_at = ? WHERE id = ?""",
                (code, _now(), task_id),
            )
            conn.commit()
    finally:
        if _preview_workers.get(task_id) is asyncio.current_task():
            _preview_workers.pop(task_id, None)



def recover_reparse_previews() -> None:
    """Resume queued/running candidate parser workers after a server restart."""
    from services.library import get_pdf_path
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, doc_id FROM reparse_previews WHERE status IN ('queued','running') ORDER BY created_at"
        ).fetchall()
    for row in rows:
        if row["id"] in _preview_workers:
            continue
        pdf_path = get_pdf_path(row["doc_id"])
        if not pdf_path:
            with get_db() as conn:
                conn.execute(
                    """UPDATE reparse_previews SET status = 'failed',
                       last_error_code = 'pdf_not_found', updated_at = ? WHERE id = ?""",
                    (_now(), row["id"]),
                )
                conn.commit()
            continue
        task = asyncio.create_task(_run_preview(row["id"], pdf_path))
        _preview_workers[row["id"]] = task


def create_preview(doc: dict, pages: list[dict], pdf_path: str, engine: str,
                   current_images: list[dict] | None = None) -> dict:
    normalized = (engine or "").strip().lower()
    if normalized not in _ALLOWED_ENGINES:
        raise ValueError("unsupported parser engine")
    task_id = str(uuid.uuid4())
    current_engine = doc.get("parser_engine") or next(
        (page.get("parser_engine") for page in pages if page.get("parser_engine")), "pymupdf"
    )
    current_version = doc.get("parser_version") or parser_identity(current_engine)[1]
    current_report = diagnose_pages(pages, current_images or [], current_engine, current_version)
    output_path = _staging_path(doc["id"], task_id)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    now = _now()
    with get_db() as conn:
        conn.execute(
            """INSERT INTO reparse_previews
               (id, doc_id, candidate_engine, status, source_revision, source_pdf_fingerprint, staging_path,
                current_report, created_at, updated_at)
               VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)""",
            (
                task_id, doc["id"], normalized, int(doc.get("content_revision") or 1),
                pdf_fingerprint(pdf_path), output_path,
                json.dumps(current_report, ensure_ascii=False), now, now,
            ),
        )
        conn.commit()
    task = asyncio.create_task(_run_preview(task_id, pdf_path))
    _preview_workers[task_id] = task
    return _preview_row(task_id)


def _preview_with_path(task_id: str) -> dict | None:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM reparse_previews WHERE id = ?", (task_id,)).fetchone()
    return dict(row) if row else None


def preview_impact(doc_id: str, source_revision: int) -> dict[str, Any]:
    with get_db() as conn:
        translations = conn.execute(
            "SELECT COUNT(*) AS count FROM translations WHERE doc_id = ? AND content_revision = ?",
            (doc_id, source_revision),
        ).fetchone()["count"]
        insights = conn.execute(
            "SELECT COUNT(*) AS count FROM page_insights WHERE doc_id = ? AND content_revision = ?",
            (doc_id, source_revision),
        ).fetchone()["count"]
        tasks = conn.execute(
            """SELECT COUNT(*) AS count FROM document_tasks
               WHERE doc_id = ? AND status IN ('queued','running','retry_wait')""",
            (doc_id,),
        ).fetchone()["count"]
    return {
        "translations_to_regenerate": int(translations),
        "insights_to_regenerate": int(insights),
        "running_tasks_to_cancel": int(tasks),
        "preserved": ["memos", "annotations", "chat_history"],
    }


def _cancel_derived_tasks(doc_id: str) -> None:
    from services.document_tasks import recoverable_tasks, request_cancel
    for task in recoverable_tasks():
        if task["doc_id"] == doc_id and task["kind"] != "parse":
            request_cancel(task["id"])
    from services.translation_job import cancel_job
    from services.insight_job import cancel_insight_job
    cancel_job(doc_id)
    cancel_insight_job(doc_id, "keywords")
    cancel_insight_job(doc_id, "summary")
    try:
        from routers.primer import cancel_primer_generation
        cancel_primer_generation(doc_id)
    except ImportError:
        pass


async def apply_preview(doc_id: str, task_id: str, sessions: dict) -> dict:
    lock = _apply_locks.setdefault(doc_id, asyncio.Lock())
    async with lock:
        preview = _preview_with_path(task_id)
        if not preview or preview["doc_id"] != doc_id:
            raise KeyError("preview not found")
        if preview["status"] != "succeeded":
            raise ValueError("preview not ready")
        with open(preview["staging_path"], "r", encoding="utf-8") as handle:
            payload = json.load(handle)


        if (
            payload.get("parser_engine") != preview["candidate_engine"]
            or not isinstance(payload.get("pages"), list)
            or not isinstance(payload.get("diagnostics"), dict)
        ):
            raise RuntimeError("invalid_staging_result")

        from services.library import get_pdf_path
        pdf_path = get_pdf_path(doc_id)
        candidate_fingerprint = payload.get("pdf_fingerprint")
        source_fingerprint = preview.get("source_pdf_fingerprint")
        if (
            not pdf_path
            or not source_fingerprint
            or candidate_fingerprint != source_fingerprint
            or candidate_fingerprint != pdf_fingerprint(pdf_path)
        ):
            raise RuntimeError("pdf_revision_conflict")

        with get_db() as conn:
            revision_row = conn.execute(
                "SELECT content_revision FROM documents WHERE id = ?", (doc_id,)
            ).fetchone()
        if (
            not revision_row
            or int(revision_row["content_revision"]) != int(preview["source_revision"])
        ):
            raise RuntimeError("content_revision_conflict")

        impact = preview_impact(doc_id, int(preview["source_revision"]))
        _cancel_derived_tasks(doc_id)
        pages = payload["pages"]
        images = payload.get("images") or []
        report = payload["diagnostics"]
        engine = payload["parser_engine"]
        version = payload["parser_version"]
        from services.languages import detect_document_language
        detection = detect_document_language(pages)
        from services.context_retrieval import chunk_pages
        chunks = chunk_pages(pages)
        now = _now()

        with get_db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            doc = conn.execute(
                "SELECT content_revision, metadata FROM documents WHERE id = ?", (doc_id,)
            ).fetchone()
            if not doc or int(doc["content_revision"]) != int(preview["source_revision"]):
                conn.rollback()
                raise RuntimeError("content_revision_conflict")
            new_revision = int(doc["content_revision"]) + 1
            try:
                metadata = json.loads(doc["metadata"]) if doc["metadata"] else {}
            except (TypeError, json.JSONDecodeError):
                metadata = {}
            for key in ("bibliography", "references", "reference_list"):
                metadata.pop(key, None)
            conn.execute(
                """UPDATE documents
                   SET total_pages = ?, metadata = ?, content_revision = ?,
                       parser_engine = ?, parser_version = ?,
                       detected_source_language = ?, source_language_confidence = ?
                   WHERE id = ?""",
                (
                    len(pages), json.dumps(metadata, ensure_ascii=False), new_revision,
                    engine, version, str(detection["language"]), float(detection["confidence"]), doc_id,
                ),
            )
            conn.execute(
                """INSERT INTO parsing_diagnostics
                   (doc_id, content_revision, parser_engine, parser_version, report, created_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (doc_id, new_revision, engine, version, json.dumps(report, ensure_ascii=False), now),
            )
            conn.execute(
                "UPDATE reparse_previews SET status = 'applied', updated_at = ? WHERE id = ?",
                (now, task_id),
            )
            conn.execute("DELETE FROM document_chunks_fts WHERE doc_id = ?", (doc_id,))
            conn.executemany(
                "INSERT INTO document_chunks_fts(doc_id,page_num,ordinal,section,content) VALUES(?,?,?,?,?)",
                [(doc_id, chunk["page_num"], chunk["ordinal"], chunk["section"], chunk["content"])
                 for chunk in chunks],
            )
            conn.commit()

        from services.cache import clear_session_cache, save_images_cache, save_pages_cache
        clear_session_cache(doc_id)
        save_pages_cache(doc_id, pdf_path, pages, engine, version)
        save_images_cache(doc_id, pdf_path, images, engine, version)
        from services.pdf_parser import clear_parser_memory_cache
        clear_parser_memory_cache()
        indexed_chunks = len(chunks)

        existing = sessions.get(doc_id, {})
        sessions[doc_id] = {
            **existing,
            "pdf_path": pdf_path,
            "pages": pages,
            "total_pages": len(pages),
            "metadata": metadata,
            "detected_source_language": str(detection["language"]),
            "source_language_confidence": float(detection["confidence"]),
            "content_revision": new_revision,
            "parser_engine": engine,
            "parser_version": version,
        }
        return {
            "status": "applied",
            "content_revision": new_revision,
            "parser_engine": engine,
            "parser_version": version,
            "total_pages": len(pages),
            "indexed_chunks": indexed_chunks,
            "stale_results": impact,
        }
