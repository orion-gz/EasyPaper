"""Account-scoped inference scheduling and cancellation."""
import asyncio
from collections import defaultdict
from contextlib import asynccontextmanager
from contextvars import ContextVar
import functools
import inspect
import weakref

from services.lab_context import identity, selected_server

_running = defaultdict(set)
_requests = defaultdict(set)
_limits = weakref.WeakKeyDictionary()
_depth = ContextVar('lab_inference_depth', default=0)
cache_scope = ContextVar('lab_cache_scope', default=None)


@asynccontextmanager
async def admission(username, server_id=None):
    """Keep running counts when limits change, rather than creating a new pool."""
    from services import lab
    pools = _limits.setdefault(asyncio.get_running_loop(), {})
    state = pools.setdefault(server_id, {
        'condition': asyncio.Condition(), 'total': 0, 'users': defaultdict(int),
    })
    condition = state['condition']
    async with condition:
        while True:
            from services import inference_servers
            common = inference_servers.get(server_id, with_secrets=False) if server_id else lab.configuration()
            maximum = common.get('max_concurrent') or (8 if common['engine'] == 'vllm' else 2)
            if state['total'] < maximum and state['users'].get(username, 0) < common.get('per_user', 1):
                state['total'] += 1
                state['users'][username] += 1
                break
            await condition.wait()
    try:
        yield
    finally:
        async with condition:
            state['total'] -= 1
            state['users'][username] -= 1
            if not state['users'][username]:
                del state['users'][username]
            condition.notify_all()


def cancel(username):
    for task in set(_running.get(username, ())) | set(_requests.get(username, ())):
        if task is not asyncio.current_task():
            task.cancel()


def scoped(function):
    signature = inspect.signature(function)
    @functools.wraps(function)
    async def wrapped(*args, **kwargs):
        from services import lab, db
        if identity.get():
            lab.require_access(identity.get())
        if not lab.selection() or _depth.get():
            async for value in function(*args, **kwargs):
                yield value
            return
        bound = signature.bind(*args, **kwargs).arguments
        session = bound.get('session_id')
        username = identity.get()
        revision = 0
        if session:
            document = db.db_get_document(session)
            if document:
                if username and document['username'] != username:
                    raise RuntimeError('Document belongs to another account.')
                username = username or document['username']
                revision = document.get('content_revision', 1)
        if not username:
            raise RuntimeError('Lab inference requires a document owner.')
        lab.require_access(username)
        token = identity.set(username)
        scope_token = cache_scope.set((session, revision) if session else None)
        depth_token = _depth.set(1)
        task = asyncio.current_task()
        _running[username].add(task)
        common = lab.selection()
        from services.ssh_connections import manager
        selection_token = selected_server.set(common)
        server_key = 'inference:' + common.get('id', 'default')
        try:
            async with manager.lease(server_key), admission(username, common.get('id')):
                lab.require_access(username)
                async for value in function(*args, **kwargs):
                    lab.require_access(username)
                    yield value
        finally:
            _running[username].discard(task)
            if not _running[username]:
                _running.pop(username, None)
            selected_server.reset(selection_token)
            _depth.reset(depth_token)
            cache_scope.reset(scope_token)
            identity.reset(token)
    return wrapped


async def cancel_account_work(username):
    """Cancel both live streams and durable workers, including retry waits."""
    from services.db import db_list_documents
    from services.document_workers import cancel_document_now
    cancel(username)
    workers = set()
    for document in db_list_documents(username, include_deleted=True):
        workers.update(cancel_document_now(document['id']))
    if workers:
        await asyncio.gather(*workers, return_exceptions=True)


def register_request(username):
    task = asyncio.current_task()
    _requests[username] = {item for item in _requests[username] if not item.done()}
    _requests[username].add(task)


def unregister_request():
    task = asyncio.current_task()
    for username, requests in tuple(_requests.items()):
        requests.discard(task)
        if not requests:
            _requests.pop(username, None)
