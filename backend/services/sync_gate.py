"""Keep API streams and background document workers out of snapshot commits."""
import asyncio
from contextlib import closing
from contextlib import asynccontextmanager

from fastapi import HTTPException
from starlette.responses import JSONResponse


class SyncGate:
    def __init__(self):
        self.active = 0
        self.busy = False

    @asynccontextmanager
    async def exclusive(self, username):
        if self.busy or self.active:
            raise HTTPException(409, 'Library requests are still running. Retry after current work finishes.')
        self.busy = True
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
            self.busy = False


gate = SyncGate()


class SyncGateMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get('path', '')
        protected = scope['type'] == 'http' and path.startswith('/api/') and not path.startswith('/api/user-data/sync/')
        if not protected:
            return await self.app(scope, receive, send)
        if gate.busy:
            return await JSONResponse({'detail': 'Library synchronization is in progress.'}, status_code=423)(scope, receive, send)
        gate.active += 1
        try:
            await self.app(scope, receive, send)
        finally:
            gate.active -= 1
