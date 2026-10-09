import pytest
from services import db


@pytest.fixture
def reading_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "reading.sqlite"))
    db.init_db()
    return db


def total(db, username="alice"):
    with db.get_db() as conn:
        return conn.execute("SELECT COALESCE(SUM(seconds), 0) FROM reading_time WHERE username = ?", (username,)).fetchone()[0]


def test_retry_is_counted_once_and_receipts_survive_restart(reading_db):
    reading_db.db_add_reading_time("a", "alice", "reading", 7, request_id="retry")
    reading_db.init_db()
    reading_db.db_add_reading_time("a", "alice", "reading", 7, request_id="retry")
    assert total(reading_db) == 7
    reading_db.db_add_reading_time("a", "alice", "reading", 3, request_id="next")
    assert total(reading_db) == 10


def test_receipts_are_per_user_and_legacy_requests_still_accumulate(reading_db):
    for user in ("alice", "bob"):
        reading_db.db_add_reading_time("a", user, "reading", 5, request_id="same")
    reading_db.db_add_reading_time("a", "alice", "chat", 2)
    reading_db.db_add_reading_time("a", "alice", "chat", 2)
    assert total(reading_db) == 9
    assert total(reading_db, "bob") == 5


def test_receipt_rolls_back_when_aggregate_write_fails(reading_db):
    with reading_db.get_db() as conn:
        conn.execute("CREATE TRIGGER fail_reading BEFORE INSERT ON reading_time BEGIN SELECT RAISE(ABORT, 'offline'); END")
    with pytest.raises(Exception, match="offline"):
        reading_db.db_add_reading_time("a", "alice", "reading", 5, request_id="retry")
    with reading_db.get_db() as conn:
        conn.execute("DROP TRIGGER fail_reading")
    reading_db.db_add_reading_time("a", "alice", "reading", 5, request_id="retry")
    assert total(reading_db) == 5


def test_delayed_retry_preserves_the_day_of_reading(reading_db):
    reading_db.db_add_reading_time("a", "alice", "reading", 7, request_id="yesterday", recorded_day="2026-10-08")
    with reading_db.get_db() as conn:
        assert conn.execute("SELECT day FROM reading_time").fetchone()[0] == "2026-10-08"


def test_api_retries_preserve_date_and_reject_invalid_records(test_client, isolated_dirs):
    database = isolated_dirs['db']
    database.db_save_document('paper', 'testuser', 'paper.pdf', '/x/paper.pdf', 1, {})
    url = '/api/library/paper/reading-heartbeat'
    record = {'seconds': 7, 'category': 'reading', 'request_id': 'retry', 'day': '2026-10-08'}
    assert test_client.post(url, json=record).status_code == 200
    assert test_client.post(url, json=record).status_code == 200
    assert total(database, 'testuser') == 7
    with database.get_db() as conn:
        assert conn.execute('SELECT day FROM reading_time').fetchone()[0] == '2026-10-08'
    assert test_client.post(url, json={**record, 'day': 'invalid'}).status_code == 422
    assert test_client.post(url, json={**record, 'request_id': 'x' * 129}).status_code == 422
    assert test_client.post(url, json={**record, 'category': 'invalid'}).status_code == 400
    assert total(database, 'testuser') == 7


def test_receipts_follow_username_changes(reading_db):
    with reading_db.get_db() as conn:
        conn.execute("INSERT INTO users VALUES ('alice', 'hash', '2026-10-09')")
    reading_db.db_add_reading_time('a', 'alice', 'reading', 7, request_id='retry')
    assert reading_db.update_user_credentials('alice', 'bob', 'new-hash')
    reading_db.db_add_reading_time('a', 'bob', 'reading', 7, request_id='retry')
    assert total(reading_db, 'bob') == 7
