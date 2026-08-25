import json
import subprocess
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

import fitz
import pytest


def _make_document(isolated_dirs, doc_id="reparse-doc"):
    library_dir = Path(isolated_dirs["library_dir"])
    doc_dir = library_dir / doc_id
    doc_dir.mkdir(parents=True)
    pdf_path = doc_dir / "document.pdf"
    pdf = fitz.open()
    page = pdf.new_page()
    page.insert_text((72, 72), "Original document text for parser diagnostics.")
    pdf.save(pdf_path)
    pdf.close()
    isolated_dirs["db"].db_save_document(
        doc_id, "testuser", "paper.pdf", str(pdf_path), 1,
        {"title": "Paper", "bibliography": {"old": True}},
        parser_engine="pymupdf", parser_version="test-old",
    )
    return pdf_path


def _insert_preview(isolated_dirs, doc_id, staging_path, source_revision=1, status="succeeded"):
    from services.pdf_diagnostics import pdf_fingerprint

    task_id = "preview-" + doc_id
    now = datetime.now(timezone.utc).isoformat()
    document = isolated_dirs["db"].db_get_document(doc_id)
    source_fingerprint = pdf_fingerprint(document["pdf_path"])
    with isolated_dirs["db"].get_db() as conn:
        conn.execute(
            """INSERT INTO reparse_previews
               (id, doc_id, candidate_engine, status, source_revision, source_pdf_fingerprint,
                staging_path, current_report, candidate_report, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (task_id, doc_id, "pdfplumber", status, source_revision, source_fingerprint,
             str(staging_path), "{}", "{}", now, now),
        )
        conn.commit()
    return task_id


def test_diagnostics_report_real_metrics_without_fake_ocr_confidence():
    from services.pdf_diagnostics import diagnose_pages

    pages = [
        {"page_num": 1, "text": "", "blocks": [], "parser_engine": "pymupdf"},
        {
            "page_num": 2,
            "text": "Repeated line\nRepeated line\nBad \ufffd text",
            "blocks": [{"bbox": [0, 0, 10, 10], "text": "x"}],
            "parser_engine": "pymupdf",
        },
    ]
    report = diagnose_pages(pages, [{"page": 2, "label": "Table 1"}], "pymupdf", "1.0")
    assert report["problem_pages"] == [1, 2]
    assert report["pages"][0]["empty_text"] is True
    assert report["pages"][1]["repeated_line_count"] == 1
    assert report["pages"][1]["table_count"] == 1
    assert report["pages"][1]["ocr_confidence"] is None


def test_pages_cache_invalidates_parser_engine_and_version(isolated_dirs, tmp_path):
    from services.cache import get_cached_pages, save_pages_cache

    pdf_path = tmp_path / "cache.pdf"
    pdf_path.write_bytes(b"%PDF cache identity")
    pages = [{"page_num": 1, "text": "cached", "parser_engine": "pymupdf"}]
    save_pages_cache("cache-doc", str(pdf_path), pages, "pymupdf", "1.0")
    assert get_cached_pages("cache-doc", str(pdf_path), "pymupdf", "1.0") == pages
    assert get_cached_pages("cache-doc", str(pdf_path), "pdfplumber", "1.0") is None
    assert get_cached_pages("cache-doc", str(pdf_path), "pymupdf", "2.0") is None


@pytest.mark.asyncio
async def test_apply_reparse_increments_revision_and_preserves_user_data(isolated_dirs, monkeypatch):
    from routers import upload
    from services import reparse
    from services.pdf_diagnostics import diagnose_pages, pdf_fingerprint

    pdf_path = _make_document(isolated_dirs)
    monkeypatch.setattr(reparse, "LIBRARY_DIR", str(isolated_dirs["library_dir"]))
    old_pages = [{"page_num": 1, "text": "Original text", "parser_engine": "pymupdf"}]
    new_pages = [{"page_num": 1, "text": "Improved candidate text", "parser_engine": "pdfplumber",
                  "blocks": [{"bbox": [0, 0, 100, 20], "text": "Improved candidate text", "type": 0}]}]
    report = diagnose_pages(new_pages, [], "pdfplumber", "test-new")
    staging_path = isolated_dirs["library_dir"] / "candidate.json"
    staging_path.write_text(json.dumps({
        "pdf_fingerprint": pdf_fingerprint(str(pdf_path)),
        "parser_engine": "pdfplumber",
        "parser_version": "test-new",
        "pages": new_pages,
        "images": [{"page": 1, "label": "Figure 1"}],
        "diagnostics": report,
    }), encoding="utf-8")
    task_id = _insert_preview(isolated_dirs, "reparse-doc", staging_path)

    db = isolated_dirs["db"]
    db.db_save_translation("reparse-doc", 1, "old translation", "ko")
    db.db_save_page_insight("reparse-doc", 1, "summary", "old summary", "ko")
    db.db_save_chat_message("reparse-doc", "user", "question")
    db.db_save_chat_message("reparse-doc", "assistant", "old answer")
    db.db_put_annotations("reparse-doc", {"page_1": [{"id": "a1"}]})
    db.db_put_memos("reparse-doc", {"page_1": [{"id": "m1"}]})
    sessions = {
        "reparse-doc": {
            "pdf_path": str(pdf_path), "pages": old_pages, "total_pages": 1,
            "metadata": {"title": "Paper", "bibliography": {"old": True}},
            "username": "testuser",
        }
    }
    monkeypatch.setattr(upload, "sessions", sessions)

    result = await reparse.apply_preview("reparse-doc", task_id, sessions)

    assert result["content_revision"] == 2
    doc = db.db_get_document("reparse-doc")
    assert doc["content_revision"] == 2
    assert doc["parser_engine"] == "pdfplumber"
    assert "bibliography" not in doc["metadata"]
    assert sessions["reparse-doc"]["pages"] == new_pages
    assert db.db_get_translation("reparse-doc", 1, "ko", fallback=False) is None
    assert db.db_get_translation("reparse-doc", 1, "ko", fallback=False, content_revision=1) == "old translation"
    assert db.db_get_page_insight("reparse-doc", 1, "summary", "ko") is None
    assert db.db_get_annotations("reparse-doc")["data"]["page_1"][0]["id"] == "a1"
    assert db.db_get_memos("reparse-doc")["data"]["page_1"][0]["id"] == "m1"
    history = db.db_get_chat_history("reparse-doc", include_revision=True)
    assert history[-1]["stale"] is True
    assert reparse.get_diagnostics("reparse-doc")["parser_engine"] == "pdfplumber"
    with db.get_db() as conn:
        fts = conn.execute(
            "SELECT content FROM document_chunks_fts WHERE doc_id = ?", ("reparse-doc",)
        ).fetchall()
        preview_status = conn.execute(
            "SELECT status FROM reparse_previews WHERE id = ?", (task_id,)
        ).fetchone()["status"]
    assert any("Improved candidate text" in row["content"] for row in fts)
    assert preview_status == "applied"


@pytest.mark.asyncio
async def test_apply_revision_conflict_keeps_existing_content(isolated_dirs, monkeypatch):
    from services import reparse
    from services.pdf_diagnostics import diagnose_pages, pdf_fingerprint

    pdf_path = _make_document(isolated_dirs, "conflict-doc")
    pages = [{"page_num": 1, "text": "candidate", "parser_engine": "pdfplumber"}]
    staging_path = isolated_dirs["library_dir"] / "conflict.json"
    staging_path.write_text(json.dumps({
        "pdf_fingerprint": pdf_fingerprint(str(pdf_path)),
        "parser_engine": "pdfplumber", "parser_version": "2",
        "pages": pages, "images": [],
        "diagnostics": diagnose_pages(pages, [], "pdfplumber", "2"),
    }), encoding="utf-8")
    task_id = _insert_preview(isolated_dirs, "conflict-doc", staging_path)
    with isolated_dirs["db"].get_db() as conn:
        conn.execute("UPDATE documents SET content_revision = 2 WHERE id = ?", ("conflict-doc",))
        conn.commit()

    sessions = {"conflict-doc": {"pages": [{"page_num": 1, "text": "still current"}]}}
    cancelled = []
    monkeypatch.setattr(reparse, "_cancel_derived_tasks", lambda doc_id: cancelled.append(doc_id))
    with pytest.raises(RuntimeError, match="content_revision_conflict"):
        await reparse.apply_preview("conflict-doc", task_id, sessions)
    assert sessions["conflict-doc"]["pages"][0]["text"] == "still current"
    assert isolated_dirs["db"].db_get_document("conflict-doc")["parser_engine"] == "pymupdf"
    assert cancelled == []


@pytest.mark.asyncio
async def test_apply_rejects_pdf_changed_after_preview_started(isolated_dirs, monkeypatch):
    from services import reparse
    from services.pdf_diagnostics import diagnose_pages, pdf_fingerprint

    pdf_path = _make_document(isolated_dirs, "pdf-conflict")
    original_fingerprint = pdf_fingerprint(str(pdf_path))
    pages = [{"page_num": 1, "text": "candidate", "parser_engine": "pdfplumber"}]
    staging_path = isolated_dirs["library_dir"] / "pdf-conflict.json"
    staging_path.write_text(json.dumps({
        "pdf_fingerprint": original_fingerprint,
        "parser_engine": "pdfplumber", "parser_version": "2",
        "pages": pages, "images": [],
        "diagnostics": diagnose_pages(pages, [], "pdfplumber", "2"),
    }), encoding="utf-8")
    task_id = _insert_preview(isolated_dirs, "pdf-conflict", staging_path)
    pdf_path.write_bytes(pdf_path.read_bytes() + b"\n% replaced after preview")
    cancelled = []
    monkeypatch.setattr(reparse, "_cancel_derived_tasks", lambda doc_id: cancelled.append(doc_id))

    with pytest.raises(RuntimeError, match="pdf_revision_conflict"):
        await reparse.apply_preview("pdf-conflict", task_id, {})
    assert isolated_dirs["db"].db_get_document("pdf-conflict")["content_revision"] == 1
    assert cancelled == []


@pytest.mark.asyncio
async def test_candidate_worker_failure_does_not_change_document(isolated_dirs, monkeypatch):
    from services import reparse

    pdf_path = _make_document(isolated_dirs, "worker-fail")
    output_path = isolated_dirs["library_dir"] / "worker-fail.json"
    task_id = _insert_preview(
        isolated_dirs, "worker-fail", output_path, status="queued",
    )

    async def fail_subprocess(*_args, **_kwargs):
        raise FileNotFoundError("parser executable missing")

    monkeypatch.setattr(reparse.asyncio, "create_subprocess_exec", fail_subprocess)
    await reparse._run_preview(task_id, str(pdf_path))

    assert reparse.get_preview(task_id)["status"] == "failed"
    doc = isolated_dirs["db"].db_get_document("worker-fail")
    assert doc["content_revision"] == 1
    assert doc["parser_engine"] == "pymupdf"


def test_mineru_preview_uses_isolated_parser_venv(monkeypatch, tmp_path):
    from services import reparse
    import venv_manager

    mineru_venv = tmp_path / "mineru-venv"
    python_path = mineru_venv / "bin" / "python"
    python_path.parent.mkdir(parents=True)
    python_path.write_text("", encoding="utf-8")
    monkeypatch.setattr(venv_manager, "MINERU_VENV", str(mineru_venv))
    monkeypatch.setattr(venv_manager, "is_packaged_desktop", lambda: False)

    command, _env = reparse._worker_command("mineru", "/tmp/source.pdf", "/tmp/result.json")
    assert command[0] == str(python_path)
    assert command[-2:] == ["--output", "/tmp/result.json"]


def test_parser_worker_writes_complete_staging_payload(tmp_path):
    pdf_path = tmp_path / "worker.pdf"
    pdf = fitz.open()
    page = pdf.new_page()
    page.insert_text((72, 72), "Worker extraction text")
    pdf.save(pdf_path)
    pdf.close()
    output_path = tmp_path / "result.json"
    backend_dir = Path(__file__).resolve().parents[1]

    result = subprocess.run(
        [sys.executable, str(backend_dir / "parser_worker.py"), "--pdf", str(pdf_path),
         "--engine", "pymupdf", "--output", str(output_path)],
        cwd=backend_dir, capture_output=True, text=True, timeout=30, check=False,
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(output_path.read_text(encoding="utf-8"))
    assert payload["parser_engine"] == "pymupdf"
    assert payload["pdf_fingerprint"]
    assert payload["pages"][0]["blocks"]
    assert payload["diagnostics"]["page_count"] == 1


def test_existing_database_migrates_revision_uniques(tmp_path, monkeypatch):
    from services import db

    database = tmp_path / "legacy.db"
    conn = sqlite3.connect(database)
    conn.executescript("""
        CREATE TABLE users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE documents (id TEXT PRIMARY KEY, username TEXT NOT NULL, filename TEXT NOT NULL, pdf_path TEXT NOT NULL, total_pages INTEGER NOT NULL, metadata TEXT, created_at TEXT NOT NULL);
        CREATE TABLE translations (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL, page_num INTEGER NOT NULL, suffix TEXT NOT NULL, translation TEXT NOT NULL, saved_at TEXT NOT NULL, UNIQUE(doc_id,page_num,suffix));
        CREATE TABLE page_insights (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL, page_num INTEGER NOT NULL, kind TEXT NOT NULL, suffix TEXT NOT NULL, content TEXT NOT NULL, saved_at TEXT NOT NULL, UNIQUE(doc_id,page_num,kind,suffix));
        CREATE TABLE chats (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
        INSERT INTO documents VALUES ('legacy','admin','paper.pdf','/x.pdf',1,'{}','2026-01-01');
        INSERT INTO translations(doc_id,page_num,suffix,translation,saved_at) VALUES ('legacy',1,'ko','old','2026-01-01');
        INSERT INTO page_insights(doc_id,page_num,kind,suffix,content,saved_at) VALUES ('legacy',1,'summary','ko','old','2026-01-01');
    """)
    conn.commit(); conn.close()
    monkeypatch.setattr(db, "DB_PATH", str(database))

    db.init_db()
    with db.get_db() as migrated:
        migrated.execute("INSERT INTO translations(doc_id,page_num,suffix,content_revision,translation,saved_at) VALUES ('legacy',1,'ko',2,'new','2026-01-02')")
        migrated.execute("INSERT INTO page_insights(doc_id,page_num,kind,suffix,content_revision,content,saved_at) VALUES ('legacy',1,'summary','ko',2,'new','2026-01-02')")
        migrated.commit()
        assert migrated.execute("SELECT COUNT(*) FROM translations WHERE doc_id='legacy'").fetchone()[0] == 2
        assert migrated.execute("SELECT COUNT(*) FROM page_insights WHERE doc_id='legacy'").fetchone()[0] == 2


def test_document_cache_clear_removes_memory_session(test_client, isolated_dirs):
    from routers.upload import sessions

    _make_document(isolated_dirs, "clear-memory")
    sessions["clear-memory"] = {"username": "testuser", "pages": [{"page_num": 1, "text": "stale"}]}
    response = test_client.post("/api/library/clear-memory/clear-cache")
    assert response.status_code == 200
    assert "clear-memory" not in sessions
