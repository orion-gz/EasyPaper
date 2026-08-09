"""services/db.py CRUD 및 app_meta 테스트 (격리된 임시 DB 사용)."""


def test_document_crud_round_trip(isolated_dirs):
    db = isolated_dirs["db"]
    doc = db.db_save_document("doc-1", "admin", "paper.pdf", "/x/paper.pdf", 10, {"title": "T"})
    assert doc["id"] == "doc-1"

    fetched = db.db_get_document("doc-1")
    assert fetched["username"] == "admin"
    assert fetched["metadata"]["title"] == "T"

    assert db.db_get_document("nonexistent") is None


def test_list_documents_filters_by_username(isolated_dirs):
    db = isolated_dirs["db"]
    db.db_save_document("doc-a1", "alice", "a1.pdf", "/x", 1, {})
    db.db_save_document("doc-a2", "alice", "a2.pdf", "/x", 1, {})
    db.db_save_document("doc-b1", "bob", "b1.pdf", "/x", 1, {})

    alice_docs = db.db_list_documents("alice")
    bob_docs = db.db_list_documents("bob")
    assert {d["id"] for d in alice_docs} == {"doc-a1", "doc-a2"}
    assert {d["id"] for d in bob_docs} == {"doc-b1"}


def test_soft_delete_and_restore(isolated_dirs):
    db = isolated_dirs["db"]
    db.db_save_document("doc-1", "admin", "p.pdf", "/x", 1, {})

    assert db.db_soft_delete_document("doc-1") is True
    assert db.db_list_documents("admin") == []
    assert len(db.db_list_documents("admin", only_trash=True)) == 1

    assert db.db_restore_document("doc-1") is True
    assert len(db.db_list_documents("admin")) == 1
    assert db.db_list_documents("admin", only_trash=True) == []


def test_soft_delete_nonexistent_document_returns_false(isolated_dirs):
    db = isolated_dirs["db"]
    assert db.db_soft_delete_document("no-such-doc") is False


def test_update_user_credentials_propagates_username_to_documents(isolated_dirs):
    """지난 세션에서 수정한 버그(아이디 변경 시 문서가 사라지던 문제)의 회귀 테스트."""
    db = isolated_dirs["db"]
    db.db_save_document("doc-1", "admin", "p1.pdf", "/x", 1, {})
    db.db_save_document("doc-2", "admin", "p2.pdf", "/x", 1, {})
    assert len(db.db_list_documents("admin")) == 2

    ok = db.update_user_credentials("admin", "newname", "newhash:abcd")
    assert ok is True

    assert len(db.db_list_documents("newname")) == 2, \
        "아이디를 바꾸면 documents.username도 함께 갱신되어야 한다"
    assert db.db_list_documents("admin") == [], \
        "예전 아이디로는 더 이상 문서가 조회되지 않아야 한다"


def test_update_user_credentials_propagates_username_to_user_data(isolated_dirs):
    """아이디 변경 시 사용자별 리딩/비교 데이터도 함께 이전한다."""
    db = isolated_dirs["db"]
    now = "2026-08-09T00:00:00+00:00"

    with db.get_db() as conn:
        conn.execute(
            """INSERT INTO reading_time
               (doc_id, username, day, category, seconds, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            ("doc-1", "admin", "2026-08-09", "reading", 120, now),
        )
        conn.execute(
            """INSERT INTO reading_sessions
               (id, username, paper_id, started_at, active_reading_time,
                created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            ("session-1", "admin", "doc-1", now, 120, now, now),
        )
        conn.execute(
            """INSERT INTO user_reading_profiles
               (username, ema_seconds_per_page, session_count, updated_at)
               VALUES (?, ?, ?, ?)""",
            ("admin", 300.0, 1, now),
        )
        conn.execute(
            """INSERT INTO compare_sessions
               (id, username, doc_ids, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?)""",
            ("compare-1", "admin", '["doc-1", "doc-2"]', now, now),
        )
        conn.execute(
            """INSERT INTO folders
               (id, username, name, color, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            ("folder-1", "admin", "읽을 논문", "#64748b", now, now),
        )
        conn.commit()

    assert db.update_user_credentials("admin", "newname", "newhash:abcd") is True

    with db.get_db() as conn:
        for table in (
            "reading_time",
            "reading_sessions",
            "user_reading_profiles",
            "compare_sessions",
            "folders",
        ):
            assert conn.execute(
                f"SELECT COUNT(*) FROM {table} WHERE username = ?", ("newname",)
            ).fetchone()[0] == 1
            assert conn.execute(
                f"SELECT COUNT(*) FROM {table} WHERE username = ?", ("admin",)
            ).fetchone()[0] == 0


def test_update_user_credentials_same_username_is_noop_for_documents(isolated_dirs):
    """비밀번호만 바꾸고 아이디는 그대로인 경우, 불필요한 UPDATE가 안전하게 스킵된다."""
    db = isolated_dirs["db"]
    db.db_save_document("doc-1", "admin", "p1.pdf", "/x", 1, {})
    ok = db.update_user_credentials("admin", "admin", "newhash:xyz")
    assert ok is True
    assert len(db.db_list_documents("admin")) == 1


def test_app_meta_get_set_round_trip(isolated_dirs):
    db = isolated_dirs["db"]
    assert db.db_get_meta("some_key") is None

    db.db_set_meta("some_key", "value1")
    assert db.db_get_meta("some_key") == "value1"

    # 같은 키를 다시 쓰면 덮어써야 한다 (INSERT가 아니라 upsert)
    db.db_set_meta("some_key", "value2")
    assert db.db_get_meta("some_key") == "value2"


def test_bulk_translation_rows_groups_by_doc_id(isolated_dirs):
    """list_documents()의 N+1 쿼리를 대체하는 벌크 조회 함수 - 문서마다 새
    커넥션을 여는 대신 한 번의 커넥션으로 여러 문서의 번역 행을 모아온다."""
    db = isolated_dirs["db"]
    db.db_save_document("doc-1", "admin", "p1.pdf", "/x", 3, {})
    db.db_save_document("doc-2", "admin", "p2.pdf", "/x", 3, {})
    db.db_save_translation("doc-1", 1, "a", suffix="ko_formal")
    db.db_save_translation("doc-1", 2, "b", suffix="ko_formal")
    db.db_save_translation("doc-2", 5, "c", suffix="en_casual")

    rows = db.db_bulk_translation_rows(["doc-1", "doc-2"])
    assert sorted(r[0] for r in rows["doc-1"]) == [1, 2]
    assert {r[1] for r in rows["doc-1"]} == {"ko_formal"}
    assert sorted(r[0] for r in rows["doc-2"]) == [5]


def test_bulk_translation_rows_returns_empty_list_for_doc_without_translations(isolated_dirs):
    db = isolated_dirs["db"]
    db.db_save_document("doc-1", "admin", "p1.pdf", "/x", 3, {})

    rows = db.db_bulk_translation_rows(["doc-1"])
    assert rows == {"doc-1": []}


def test_bulk_translation_rows_empty_doc_ids_returns_empty_dict(isolated_dirs):
    db = isolated_dirs["db"]
    assert db.db_bulk_translation_rows([]) == {}
