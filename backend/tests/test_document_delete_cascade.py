"""db_delete_document이 SQLite의 PRAGMA foreign_keys 미설정으로 인해
FK ON DELETE CASCADE가 실제로는 동작하지 않는 문제를 우회해, 연관 테이블을
명시적으로 정리하는지 검증하는 회귀 테스트."""

from datetime import datetime, timezone


def _now():
    return datetime.now(timezone.utc).isoformat()


def _seed_related_rows(db, doc_id):
    """9개 연관 테이블에 doc_id를 참조하는 행을 하나씩 심는다."""
    with db.get_db() as conn:
        cur = conn.cursor()
        now = _now()

        cur.execute(
            "INSERT INTO translations (doc_id, page_num, suffix, translation, saved_at) VALUES (?, 1, '', 'x', ?)",
            (doc_id, now),
        )
        cur.execute(
            "INSERT INTO chats (doc_id, role, content, created_at) VALUES (?, 'user', 'hi', ?)",
            (doc_id, now),
        )
        chat_id = cur.lastrowid
        cur.execute(
            "INSERT INTO page_insights (doc_id, page_num, kind, suffix, content, saved_at) VALUES (?, 1, 'summary', '', 'x', ?)",
            (doc_id, now),
        )
        cur.execute(
            "INSERT INTO concepts (name, normalized_name, kind, created_at) VALUES ('Concept A', 'concept a', 'topic', ?)",
            (now,),
        )
        concept_id = cur.lastrowid
        cur.execute(
            "INSERT INTO paper_concepts (doc_id, concept_id, created_at) VALUES (?, ?, ?)",
            (doc_id, concept_id, now),
        )
        cur.execute(
            "INSERT INTO paper_edges (doc_id_a, doc_id_b, edge_type, detail, created_at) VALUES (?, 'other-doc', 'citation', NULL, ?)",
            (doc_id, now),
        )
        cur.execute(
            "INSERT INTO annotations (doc_id, data, updated_at) VALUES (?, '{}', ?)",
            (doc_id, now),
        )
        cur.execute(
            "INSERT INTO memos (doc_id, data, updated_at) VALUES (?, '{}', ?)",
            (doc_id, now),
        )
        cur.execute(
            "INSERT INTO question_papers (chat_id, doc_id, created_at) VALUES (?, ?, ?)",
            (chat_id, doc_id, now),
        )
        cur.execute(
            "INSERT INTO question_concepts (chat_id, concept_id, created_at) VALUES (?, ?, ?)",
            (chat_id, concept_id, now),
        )
        conn.commit()
        return concept_id


def _count(db, table, where, params):
    with db.get_db() as conn:
        cur = conn.cursor()
        cur.execute(f"SELECT COUNT(*) AS c FROM {table} WHERE {where}", params)
        return cur.fetchone()["c"]


def test_delete_document_removes_orphan_rows_in_related_tables(isolated_dirs):
    db = isolated_dirs["db"]
    doc_id = "doc-with-related-rows"
    db.db_save_document(doc_id, "admin", "p.pdf", "/x", 1, {})
    concept_id = _seed_related_rows(db, doc_id)

    assert db.db_delete_document(doc_id) is True

    assert _count(db, "translations", "doc_id = ?", (doc_id,)) == 0
    assert _count(db, "chats", "doc_id = ?", (doc_id,)) == 0
    assert _count(db, "page_insights", "doc_id = ?", (doc_id,)) == 0
    assert _count(db, "paper_concepts", "doc_id = ?", (doc_id,)) == 0
    assert _count(db, "paper_edges", "doc_id_a = ? OR doc_id_b = ?", (doc_id, doc_id)) == 0
    assert _count(db, "annotations", "doc_id = ?", (doc_id,)) == 0
    assert _count(db, "memos", "doc_id = ?", (doc_id,)) == 0
    assert _count(db, "question_papers", "doc_id = ?", (doc_id,)) == 0
    assert _count(db, "question_concepts", "concept_id = ?", (concept_id,)) == 0
    assert db.db_get_document(doc_id) is None

    # concepts 자체는 문서와 무관한 전역 노드라 삭제 대상이 아니다.
    assert _count(db, "concepts", "id = ?", (concept_id,)) == 1


def test_delete_document_returns_false_for_nonexistent_doc(isolated_dirs):
    db = isolated_dirs["db"]
    assert db.db_delete_document("does-not-exist") is False
