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


@contextmanager
def translation_server():
    """Apply a translation-only endpoint without changing the account's other tools."""
    import config
    from services import inference_servers, lab
    if not config.TRANS_SERVER_ID or lab.selection():
        yield
        return
    server = inference_servers.get(config.TRANS_SERVER_ID)
    token = selected_server.set(dict(server, provider=server['engine'], model=config.TRANS_MODEL))
    try:
        yield
    finally:
        selected_server.reset(token)
