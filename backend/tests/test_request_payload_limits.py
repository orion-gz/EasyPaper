"""Oversized chat and library mirror payloads must be rejected before processing."""

import pytest
from pydantic import ValidationError

from routers.chat import (
    ChatMessage,
    ChatRequest,
    MAX_CHAT_IMAGE_BASE64_CHARS,
    MAX_CHAT_MESSAGES,
    MAX_CHAT_MESSAGE_CHARS,
)
from routers.library import LibraryMirrorPayload, MAX_LIBRARY_MIRROR_JSON_BYTES


def test_chat_message_rejects_oversized_content():
    with pytest.raises(ValidationError):
        ChatMessage(role="user", content="x" * (MAX_CHAT_MESSAGE_CHARS + 1))


def test_chat_request_rejects_too_many_messages():
    message = ChatMessage(role="user", content="hello")
    with pytest.raises(ValidationError):
        ChatRequest(
            session_id="doc-1",
            messages=[message] * (MAX_CHAT_MESSAGES + 1),
        )


def test_chat_request_rejects_oversized_base64_image():
    with pytest.raises(ValidationError):
        ChatRequest(
            session_id="doc-1",
            messages=[],
            image_base64="A" * (MAX_CHAT_IMAGE_BASE64_CHARS + 1),
        )


def test_library_mirror_model_rejects_oversized_json():
    with pytest.raises(ValidationError):
        LibraryMirrorPayload(
            data={"content": "x" * MAX_LIBRARY_MIRROR_JSON_BYTES},
        )


@pytest.mark.parametrize("resource", ["annotations", "memos"])
def test_library_mirror_endpoint_rejects_oversized_json(
    test_client, isolated_dirs, resource
):
    doc_id = f"doc-large-{resource}"
    db = isolated_dirs["db"]
    db.db_save_document(doc_id, "testuser", "paper.pdf", "/x/paper.pdf", 1, {})

    response = test_client.put(
        f"/api/library/{doc_id}/{resource}",
        json={"data": {"content": "x" * MAX_LIBRARY_MIRROR_JSON_BYTES}},
    )

    assert response.status_code == 422
    getter = (
        db.db_get_annotations
        if resource == "annotations"
        else db.db_get_memos
    )
    assert getter(doc_id) is None
