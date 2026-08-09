"""POST /chat/compare/stream, GET /chat/compare/history HTTP 레벨 테스트.

routers.chat._build_compare_id는 순수 함수라 직접 단위 테스트하고, 스트리밍
엔드포인트는 routers.chat.stream_chat(모듈 상단에서 `from ... import
stream_chat`으로 바인딩되어 있으므로 routers.chat.stream_chat을 패치)을
가짜 비동기 제너레이터로 교체해 실제 CLI/외부 API 호출 없이 검증한다.
"""

import pytest
from unittest.mock import patch

from routers.chat import _build_compare_id
import routers.chat as chat_module


@pytest.fixture(autouse=True)
def _cleanup_fake_sessions():
    """routers.upload.sessions는 프로세스 전역 dict라 테스트 간 오염을 막기
    위해, 이 파일에서 주입한 fake 세션 항목을 테스트 후 반드시 지운다."""
    yield
    for key in list(chat_module.sessions.keys()):
        if key.startswith("cmp-doc-"):
            del chat_module.sessions[key]


def _create_doc(isolated_dirs, doc_id, username="testuser", title=None, text="Sample paper text."):
    db = isolated_dirs["db"]
    metadata = {"title": title} if title else {}
    db.db_save_document(doc_id, username, f"{doc_id}.pdf", f"/x/{doc_id}.pdf", 1, metadata)
    chat_module.sessions[doc_id] = {
        "pdf_path": f"/x/{doc_id}.pdf",
        "filename": f"{doc_id}.pdf",
        "pages": [{"page_num": 1, "text": text}],
        "total_pages": 1,
        "metadata": metadata,
        "from_library": True,
        "username": username,
    }


async def _fake_stream_chat(system_prompt, history_messages, session_id=None):
    yield "Hello "
    yield "World"


def test_build_compare_id_is_order_independent():
    assert _build_compare_id(["a", "b", "c"]) == _build_compare_id(["c", "a", "b"])


def test_build_compare_id_differs_for_different_sets():
    assert _build_compare_id(["a", "b"]) != _build_compare_id(["a", "c"])


def test_compare_stream_rejects_fewer_than_two_docs(test_client, isolated_dirs):
    _create_doc(isolated_dirs, "cmp-doc-1")
    res = test_client.post("/api/chat/compare/stream", json={"doc_ids": ["cmp-doc-1"], "messages": []})
    assert res.status_code == 400


def test_compare_stream_rejects_more_than_five_docs(test_client, isolated_dirs):
    ids = []
    for i in range(6):
        doc_id = f"cmp-doc-{i}"
        _create_doc(isolated_dirs, doc_id)
        ids.append(doc_id)
    res = test_client.post("/api/chat/compare/stream", json={"doc_ids": ids, "messages": []})
    assert res.status_code == 400


def test_compare_stream_rejects_other_users_document(test_client, isolated_dirs):
    _create_doc(isolated_dirs, "cmp-doc-1", username="testuser")
    _create_doc(isolated_dirs, "cmp-doc-2", username="otheruser")
    res = test_client.post(
        "/api/chat/compare/stream",
        json={"doc_ids": ["cmp-doc-1", "cmp-doc-2"], "messages": [{"role": "user", "content": "비교해줘"}]},
    )
    assert res.status_code == 404


def test_compare_stream_streams_tokens_and_saves_history(test_client, isolated_dirs):
    _create_doc(isolated_dirs, "cmp-doc-1", title="Paper One", text="Paper one content.")
    _create_doc(isolated_dirs, "cmp-doc-2", title="Paper Two", text="Paper two content.")

    with patch.object(chat_module, "stream_chat", new=_fake_stream_chat):
        res = test_client.post(
            "/api/chat/compare/stream",
            json={
                "doc_ids": ["cmp-doc-1", "cmp-doc-2"],
                "messages": [{"role": "user", "content": "두 논문의 차이가 뭐야?"}],
            },
        )

    assert res.status_code == 200
    assert "Hello" in res.text
    assert "World" in res.text

    compare_id = _build_compare_id(["cmp-doc-1", "cmp-doc-2"])
    history = isolated_dirs["db"].db_get_chat_history(compare_id)
    assert history[0] == {"role": "user", "content": "두 논문의 차이가 뭐야?"}
    assert history[1]["role"] == "assistant"
    assert "Hello" in history[1]["content"]


def test_compare_history_returns_saved_messages_regardless_of_doc_order(test_client, isolated_dirs):
    _create_doc(isolated_dirs, "cmp-doc-1", title="Paper One")
    _create_doc(isolated_dirs, "cmp-doc-2", title="Paper Two")

    with patch.object(chat_module, "stream_chat", new=_fake_stream_chat):
        test_client.post(
            "/api/chat/compare/stream",
            json={"doc_ids": ["cmp-doc-1", "cmp-doc-2"], "messages": [{"role": "user", "content": "질문"}]},
        )

    # 순서를 바꿔 조회해도 같은 compare_id로 매핑되어 동일한 기록을 반환해야 한다
    res = test_client.get("/api/chat/compare/history", params={"doc_ids": "cmp-doc-2,cmp-doc-1"})
    assert res.status_code == 200
    body = res.json()
    assert len(body["history"]) == 2
    assert body["history"][0]["content"] == "질문"


def test_compare_history_rejects_other_users_document(test_client, isolated_dirs):
    _create_doc(isolated_dirs, "cmp-doc-1", username="testuser")
    _create_doc(isolated_dirs, "cmp-doc-2", username="otheruser")
    res = test_client.get("/api/chat/compare/history", params={"doc_ids": "cmp-doc-1,cmp-doc-2"})
    assert res.status_code == 404


def test_compare_history_rejects_invalid_doc_count(test_client, isolated_dirs):
    _create_doc(isolated_dirs, "cmp-doc-1")
    res = test_client.get("/api/chat/compare/history", params={"doc_ids": "cmp-doc-1"})
    assert res.status_code == 400


def test_list_compare_sessions_uses_two_queries_and_preserves_missing_titles(
    isolated_dirs, monkeypatch
):
    db = isolated_dirs["db"]
    db.db_save_document("batch-doc-1", "testuser", "one.pdf", "/x/one.pdf", 1, {"title": "One"})
    db.db_save_document("batch-doc-2", "testuser", "two.pdf", "/x/two.pdf", 1, {})
    db.db_upsert_compare_session("cmp_batch_1", "testuser", ["batch-doc-1", "batch-doc-2"])
    db.db_upsert_compare_session("cmp_batch_2", "testuser", ["batch-doc-1", "missing-doc"])

    original_get_db = db.get_db
    statements = []

    def traced_get_db():
        conn = original_get_db()
        conn.set_trace_callback(statements.append)
        return conn

    monkeypatch.setattr(db, "get_db", traced_get_db)

    sessions = db.db_list_compare_chat_sessions("testuser")

    select_statements = [statement for statement in statements if statement.lstrip().upper().startswith("SELECT")]
    assert len(select_statements) == 2
    assert sessions[0]["titles"] == ["One", "(삭제된 논문)"]
    assert sessions[1]["titles"] == ["One", "two.pdf"]
