"""Request-local identity; inherited by asyncio tasks and to_thread workers."""
from contextvars import ContextVar

identity = ContextVar('lab_identity', default=None)
selected_server = ContextVar('selected_inference_server', default=None)


from contextlib import contextmanager


@contextmanager
def recovery_owner(document_id, pending_owner=None):
    """Recover work under its durable owner, never the process administrator."""
    from fastapi import HTTPException
    from services import db, lab
    document = db.db_get_document(document_id)
    username = document.get('username') if document else pending_owner
    token = identity.set(username)
    try:
        try:
            if username:
                lab.require_access(username)
        except HTTPException:
            yield False
        else:
            yield bool(username)
    finally:
        identity.reset(token)
