"""Authenticated user backup endpoints; large files are spooled to disk."""
import json
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from services.auth import get_current_user
from services import data_transfer

router = APIRouter()
MAX_BROWSER_BYTES = 20 * 1024**2


@router.get('/user-data/sync/info')
async def sync_info(current_user: str = Depends(get_current_user)):
    from services import library_sync
    from services.sync_gate import gate
    async with gate.exclusive(current_user):
        with tempfile.TemporaryDirectory(prefix='easypaper-sync-info-') as temp:
            manifest = await run_in_threadpool(library_sync.export_snapshot, current_user, Path(temp) / 'snapshot.zip')
    return {'protocol': library_sync.PROTOCOL, 'account': manifest['sync']['account'],
            'revision': library_sync.fingerprint(manifest), 'documents': len(manifest['tables']['documents'])}


@router.post('/user-data/sync/exchange')
async def sync_exchange(request: Request, current_user: str = Depends(get_current_user)):
    from services import library_sync
    from services.sync_gate import gate
    if request.headers.get('x-easypaper-sync') != '1':
        raise HTTPException(403, 'A synchronization client header is required.')
    origin = request.headers.get('origin')
    if (origin and origin != str(request.base_url).rstrip('/')) or request.headers.get('sec-fetch-site') == 'cross-site':
        raise HTTPException(403, 'Cross-origin synchronization requests are not allowed.')
    with tempfile.TemporaryFile() as source:
        size = 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > data_transfer.MAX_ARCHIVE_BYTES:
                raise HTTPException(413, 'Synchronization archive exceeds 4 GiB.')
            await run_in_threadpool(source.write, chunk)
        source.seek(0)
        try:
            async with gate.exclusive(current_user):
                response = await run_in_threadpool(library_sync.exchange, current_user, source,
                                                  library_sync.storage_root() / 'responses')
        except library_sync.SyncConflict as exc:
            raise HTTPException(409, {'message': str(exc), 'conflicts': exc.conflicts}) from exc
        except data_transfer.InvalidArchive as exc:
            raise HTTPException(400, str(exc)) from exc
    return FileResponse(response, media_type='application/zip', headers={'Cache-Control': 'no-store'})


@router.post('/user-data/export')
async def export_user_data(request: Request, current_user: str = Depends(get_current_user)):
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_BROWSER_BYTES:
            raise HTTPException(413, 'Browser settings exceed the 20 MiB limit.')
    try:
        browser_data = json.loads(body or b'{}')
        if not isinstance(browser_data, dict) or any(not isinstance(v, str) for v in browser_data.values()):
            raise ValueError()
    except (ValueError, TypeError):
        raise HTTPException(400, 'Expected browser settings as a JSON object of strings.')
    directory = tempfile.TemporaryDirectory(prefix='easypaper-export-')
    destination = Path(directory.name) / 'easypaper-user-data.zip'
    try:
        await run_in_threadpool(data_transfer.export_archive, current_user, browser_data, destination)
    except data_transfer.InvalidArchive as exc:
        directory.cleanup()
        raise HTTPException(400, str(exc)) from exc
    except Exception:
        directory.cleanup()
        raise
    return FileResponse(destination, media_type='application/zip', filename=destination.name,
                        headers={'Cache-Control': 'no-store'}, background=BackgroundTask(directory.cleanup))


@router.post('/user-data/import')
async def import_user_data(request: Request, current_user: str = Depends(get_current_user)):
    # Read raw ZIP chunks so the limit applies before an unbounded multipart upload
    # can fill the server's temporary filesystem.
    with tempfile.TemporaryFile() as source:
        size = 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > data_transfer.MAX_ARCHIVE_BYTES:
                raise HTTPException(413, 'Backup exceeds the 4 GiB upload limit.')
            await run_in_threadpool(source.write, chunk)
        source.seek(0)
        try:
            return await run_in_threadpool(data_transfer.import_archive, current_user, source)
        except data_transfer.InvalidArchive as exc:
            raise HTTPException(400, str(exc)) from exc
