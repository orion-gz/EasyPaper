"""Keep API streams and background document workers out of snapshot commits."""
import asyncio
from contextlib import closing
from contextlib import asynccontextmanager

from fastapi import HTTPException
from starlette.responses import JSONResponse


class SyncGate:
    def __init__(self):
        self.requests = {}
        self.commits = set()

    @property
    def active(self):
        return sum(self.requests.values())

    @property
    def busy(self):
        return bool(self.commits)

    @asynccontextmanager
    async def exclusive(self, username):
        if self.busy or self.requests.get(username, 0) or self.requests.get(None, 0):
            raise HTTPException(409, 'Library requests are still running. Retry after current work finishes.')
        self.commits.add(username)
        guarded = set()
        try:
            from services.db import db_list_documents, get_db
            from services.document_workers import workers_for_document, _mutating
            from routers.upload import wait_for_session_restoration
            with closing(get_db()) as conn:
                pending = conn.execute('''SELECT 1 FROM document_tasks t JOIN documents d ON d.id=t.doc_id
                    WHERE d.username=? AND t.status IN ('queued','running','retry_wait') LIMIT 1''', (username,)).fetchone()
                if pending:
                    raise HTTPException(409, 'Document processing is pending. Finish or cancel it before synchronizing.')
            documents = db_list_documents(username, include_deleted=True)
            ids = {document['id'] for document in documents}
            if ids & _mutating:
                raise HTTPException(409, 'Document maintenance is running. Retry when it finishes.')
            guarded = ids
            _mutating.update(guarded)
            for document in documents:
                if workers_for_document(document['id']):
                    raise HTTPException(409, 'Document processing is running. Wait for it to finish before synchronizing.')
                await asyncio.to_thread(wait_for_session_restoration, document['id'])
            yield
        finally:
            if guarded:
                _mutating.difference_update(guarded)
            self.commits.discard(username)


gate = SyncGate()


class SyncGateMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get('path', '')
        protected = scope['type'] == 'http' and path.startswith('/api/') and not path.startswith('/api/user-data/sync/')
        if not protected:
            return await self.app(scope, receive, send)
        from starlette.requests import Request
        from services.auth import verify_session_token
        from config import get_skip_login, get_app_username
        from services.lab import settings
        request = Request(scope)
        token = request.cookies.get('session_token', '')
        username = scope.get('desktop_offline_user') or (token.rsplit(':', 2)[0] if token and verify_session_token(token) else None)
        if username is None and get_skip_login() and not settings()['enabled']:
            username = get_app_username()
        if username in gate.commits or (username is None and gate.busy):
            return await JSONResponse({'detail': 'Library synchronization is in progress.'}, status_code=423)(scope, receive, send)
        gate.requests[username] = gate.requests.get(username, 0) + 1
        try:
            await self.app(scope, receive, send)
        finally:
            gate.requests[username] -= 1
            if not gate.requests[username]:
                gate.requests.pop(username, None)
