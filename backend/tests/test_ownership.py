import pytest
from fastapi import HTTPException

from services import ownership


def test_require_owned_document_uses_preloaded_document(monkeypatch):
    monkeypatch.setattr(ownership, "get_document", lambda _doc_id: pytest.fail("unexpected lookup"))
    doc = {"id": "doc-1", "username": "alice"}

    assert ownership.require_owned_document("doc-1", "alice", doc) is doc


@pytest.mark.parametrize("doc", [None, {"id": "doc-1", "username": "bob"}])
def test_require_owned_document_hides_missing_and_foreign_documents(monkeypatch, doc):
    monkeypatch.setattr(ownership, "get_document", lambda _doc_id: doc)

    with pytest.raises(HTTPException) as exc_info:
        ownership.require_owned_document("doc-1", "alice")

    assert exc_info.value.status_code == 404
    assert exc_info.value.detail == "문서를 찾을 수 없습니다."


def test_require_owned_documents_preserves_input_order(monkeypatch):
    docs = {
        "doc-2": {"id": "doc-2", "username": "alice"},
        "doc-1": {"id": "doc-1", "username": "alice"},
    }
    monkeypatch.setattr(ownership, "get_document", docs.get)

    result = ownership.require_owned_documents(["doc-2", "doc-1"], "alice")

    assert [doc["id"] for doc in result] == ["doc-2", "doc-1"]
