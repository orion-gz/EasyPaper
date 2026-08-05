import pytest
from datetime import datetime, timezone
from services.knowledge_graph import get_activity_timeline
from services.library import soft_delete_document, permanently_delete_document, save_document

def test_deleted_paper_retains_timeline_events(isolated_dirs):
    db = isolated_dirs["db"]

    # 1. Create a document with reading session and question
    doc_meta = {
        "title": "Deleted Test Paper",
        "read_sessions": [
            {
                "timestamp": "2026-08-01T10:00:00Z",
                "end_timestamp": "2026-08-01T10:15:00Z",
                "duration_seconds": 900,
                "start_page": 1,
                "end_page": 5,
                "verified_pages": 4,
            }
        ]
    }
    doc_id = "doc-test-deleted-1"
    username = "testuser"

    db.db_save_document(doc_id, username, "deleted_paper.pdf", "/dummy/path.pdf", 10, doc_meta)
    db.db_save_chat_message(doc_id, "user", "What is the key takeaway?")
    db.db_add_reading_time(doc_id, username, "reading", 900)

    # 2. Check timeline before deletion
    import asyncio
    timeline_before = asyncio.run(get_activity_timeline(username))
    doc_events_before = [e for e in timeline_before if e["doc_id"] == doc_id]
    assert len(doc_events_before) >= 2  # uploaded, read, question
    for e in doc_events_before:
        assert e.get("is_deleted") is False

    # 3. Soft delete document
    db.db_soft_delete_document(doc_id)

    # 4. Check timeline after soft delete
    timeline_after_soft = asyncio.run(get_activity_timeline(username))
    doc_events_soft = [e for e in timeline_after_soft if e["doc_id"] == doc_id]
    assert len(doc_events_soft) >= 2
    for e in doc_events_soft:
        assert e.get("is_deleted") is True
        assert e["doc_title"] == "Deleted Test Paper"

    # 5. Permanently delete document from documents table
    db.db_delete_document(doc_id)

    # 6. Check timeline after hard delete - reading_time event fallback is retained with is_deleted=True
    timeline_after_hard = asyncio.run(get_activity_timeline(username))
    doc_events_hard = [e for e in timeline_after_hard if e["doc_id"] == doc_id]
    assert len(doc_events_hard) >= 1
    assert doc_events_hard[0]["is_deleted"] is True
    assert doc_events_hard[0]["type"] == "read"
