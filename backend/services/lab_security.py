"""Same-origin mutations and request identity cleanup for both web and Tauri."""
from urllib.parse import urlsplit
from starlette.requests import Request
from starlette.responses import JSONResponse
from services.lab_context import identity


class LabSecurityMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        token = identity.set(None)
        try:
            request = Request(scope)
            if scope.get('path', '').startswith('/api/') and request.method not in ('GET', 'HEAD', 'OPTIONS'):
                origin = request.headers.get('origin')
                # The Tauri proxy removes the local origin before forwarding.
                if request.headers.get('sec-fetch-site') == 'cross-site' or (origin and urlsplit(origin).netloc != request.headers.get('host')):
                    return await JSONResponse({'detail': 'Cross-origin mutation denied.'}, status_code=403)(scope, receive, send)
            await self.app(scope, receive, send)
        finally:
            from services.lab_tasks import unregister_request
            unregister_request()
            identity.reset(token)
