"""Desktop orchestration for confirmed, resumable two-way library sync."""
import asyncio
from contextlib import closing
import json
import logging
from pathlib import Path
import uuid

import httpx
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from services import library_sync as sync, data_transfer, db
from services.atomic_io import atomic_write_text
from services.sync_gate import gate

POLICIES = {'merge', 'replace_local', 'replace_remote', 'defer'}
logger = logging.getLogger(__name__)


async def small_body(request):
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 8192:
            raise HTTPException(413, 'Request is too large.')
    try:
        body = json.loads(raw or b'{}')
        if not isinstance(body, dict):
            raise ValueError()
        return body
    except ValueError:
        raise HTTPException(400, 'Invalid synchronization request.')


async def checked(response):
    if response.status_code == 404:
        raise ValueError('Update EasyPaper on the server to enable two-way synchronization.')
    if response.status_code in (401, 403):
        raise ValueError('Sign in to the remote server before synchronizing.')
    if response.status_code != 200:
        data = await response.aread()
        try:
            detail = json.loads(data).get('detail', '')
        except ValueError:
            detail = ''
        if isinstance(detail, dict) and detail.get('conflicts'):
            raise sync.SyncConflict(detail['conflicts'])
        raise ValueError(detail if isinstance(detail, str) and detail else f'Synchronization failed (HTTP {response.status_code}).')


class DesktopSync:
    def __init__(self, manager):
        self.manager = manager
        router = manager.router
        router.add_api_route('/sync/preview', self.preview, methods=['POST'])
        router.add_api_route('/sync', self.start, methods=['POST'])

    def directory(self, target, username):
        base = self.manager.config_path.parent / 'library-sync-client' / sync.digest([target, sync.account_id(username)])
        remote_account = self.options(target).get('account')
        root = base / sync.digest(remote_account) if remote_account else base
        root.mkdir(parents=True, exist_ok=True)
        legacy = base / 'plan.json'
        if remote_account and legacy.exists():
            pending = json.loads(legacy.read_text())
            if pending.get('remote_account') == remote_account and not (root / 'plan.json').exists():
                for name in ('request.zip', 'response.zip', 'response.tmp', 'current.zip', 'local.zip', 'merged.zip', 'plan.json'):
                    source = base / name
                    if source.exists():
                        source.replace(root / name)
        return root

    def options(self, target):
        return self.manager.config.get('sync_options', {}).get(target, {'action': 'defer', 'automatic': False})

    def check_available(self):
        manager = self.manager
        if not manager.config['enabled']:
            raise HTTPException(409, 'Connect to a remote server first.')
        if manager.offline(manager.config['server_url']) and self.options(manager.config['server_url']).get('offline_locked'):
            raise HTTPException(401, 'Sign in to unlock the offline library.')
        if manager.download_task and not manager.download_task.done():
            raise HTTPException(409, 'A data transfer is already running.')

    async def preview(self, request: Request):
        from config import get_app_username
        from services.desktop_connection import upstream_headers
        manager = self.manager
        manager.guard(request)
        body = await small_body(request)
        action = body.get('action', 'defer')
        if action not in POLICIES:
            raise HTTPException(400, 'Invalid synchronization action.')
        if action == 'defer':
            return {'action': 'defer'}
        async with manager.lock:
            self.check_available()
            target, username = manager.config['server_url'], get_app_username()
            root = self.directory(target, username)
            headers = upstream_headers(request, target)
            headers['x-easypaper-sync-binding'] = '1'
            if manager.offline(target):
                headers['x-easypaper-sync-scope'] = 'user-data'
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(600, connect=10), follow_redirects=False, trust_env=False) as client:
                    response = await client.get(target + '/api/user-data/sync/info', headers=headers)
                    await checked(response)
                    remote = response.json()
                options = manager.config.setdefault('sync_options', {}).setdefault(target, {})
                bound_account = options.get('account')
                if bound_account != remote.get('account'):
                    options['automatic'] = False
                    manager.save()
                    if bound_account and manager.offline(target):
                        raise ValueError('Remote account changed. Switch to server mode before signing in to another account.')
                    if (body.get('automatic') and not manager.offline(target)) or bound_account:
                        options['account'] = remote.get('account')
                        options.pop('offline_ready', None)
                        manager.save()
                        raise ValueError('Remote account changed. Automatic synchronization stopped; confirm a new preview.')
                    options['account'] = remote.get('account')
                    options.pop('offline_ready', None)
                    manager.save()
                if manager.offline(target):
                    if 'offline-user-data-v2' not in remote.get('capabilities', []):
                        raise ValueError('Update the server to support offline user-data synchronization.')
                    username = manager.local_user(target)
                if remote.get('protocol') != sync.PROTOCOL:
                    raise ValueError('The server synchronization protocol is not compatible.')
                root = self.directory(target, username)
                pending_file = root / 'plan.json'
                if pending_file.exists():
                    pending = json.loads(pending_file.read_text())
                    if pending.get('confirmed') and pending['remote_account'] == remote['account']:
                        # A transport failure resumes the exact operation. An
                        # explicit replacement selection can resolve a conflict
                        # using a fresh, separately confirmed preview.
                        fresh_conflict_preview = pending.get('conflict') and (
                            action in ('replace_local', 'replace_remote') or not (root / 'response.zip').exists())
                        if not fresh_conflict_preview:
                            return {**pending['preview'], 'resume': True}
                async with gate.exclusive(username):
                    local = await run_in_threadpool(sync.export_snapshot, username, root / 'local.zip', manager.offline(target))
                    expected_raw = sync.raw_fingerprint(username)
                previous = sync.peer_state(username, remote['account'])
                if manager.offline(target):
                    local['sync']['scope'] = 'user-data'
                    # Upload records only; document bytes remain server-owned.
                    local['sync']['known_files'] = dict(local['files'])
                    local['files'] = {k: v for k, v in local['files'].items() if '/chat_images/' in k}
                plan_id = uuid.uuid4().hex
                local['sync'].update(request_id=plan_id, policy=action,
                                     baseline=previous['revision'] if previous else '',
                                     expected_remote=remote['revision'], expected_account=remote['account'])
                await run_in_threadpool(sync.write_snapshot, local, [root / 'local.zip'], root / 'request.zip')
                preview = {'plan_id': plan_id, 'action': action, 'local_documents': len(local['tables']['documents']),
                           'remote_documents': remote['documents'], 'resume': False}
                plan = {'preview': preview, 'remote_account': remote['account'], 'expected_raw': expected_raw,
                        'confirmed': False, 'conflict': False}
                atomic_write_text(str(pending_file), json.dumps(plan))
                (root / 'response.zip').unlink(missing_ok=True)
                return preview
            except (httpx.HTTPError, ValueError, KeyError) as exc:
                raise HTTPException(400, str(exc)) from exc

    async def start(self, request: Request):
        from config import get_app_username
        from services.desktop_connection import upstream_headers
        manager = self.manager
        manager.guard(request)
        body = await small_body(request)
        async with manager.lock:
            self.check_available()
            target, username = manager.config['server_url'], get_app_username()
            if manager.offline(target):
                username = manager.local_user(target)
            root = self.directory(target, username)
            try:
                plan = json.loads((root / 'plan.json').read_text())
            except (OSError, ValueError):
                raise HTTPException(409, 'Preview the synchronization changes first.')
            if body.get('plan_id') != plan['preview']['plan_id'] or body.get('confirmed') is not True:
                raise HTTPException(409, 'Confirm the current synchronization preview first.')
            if not isinstance(body.get('automatic', False), bool):
                raise HTTPException(400, 'Invalid automatic synchronization setting.')
            if self.options(target)['action'] == 'defer':
                raise HTTPException(409, 'Synchronization is deferred. Select a data action first.')
            plan['confirmed'] = True
            atomic_write_text(str(root / 'plan.json'), json.dumps(plan))
            manager.config['sync_options'][target]['automatic'] = (
                body.get('automatic', False) and plan['preview']['action'] == 'merge')
            manager.save()
            manager.job = {'kind': 'sync', 'status': 'uploading', 'bytes': 0}
            manager.download_task = asyncio.create_task(self.run(target, username, root, upstream_headers(request, target)))
            return JSONResponse(manager.job, status_code=202)

    async def run(self, target, username, root, headers):
        manager = self.manager
        plan_file = root / 'plan.json'
        plan = json.loads(plan_file.read_text())
        action = plan['preview']['action']
        headers = {key: value for key, value in headers.items() if key in ('cookie', 'accept-encoding')}
        headers['content-type'] = 'application/zip'
        headers['x-easypaper-sync'] = '1'
        headers['x-easypaper-sync-binding'] = '1'
        try:
            async with httpx.AsyncClient(timeout=30, follow_redirects=False, trust_env=False) as client:
                identity = await client.get(target + '/api/user-data/sync/info', headers=headers)
                await checked(identity)
                if identity.json().get('account') != plan['remote_account']:
                    raise ValueError('Remote account changed. Preview synchronization again.')
            if not (root / 'response.zip').exists():
                if action == 'replace_local' and sync.raw_fingerprint(username) != plan['expected_raw']:
                    raise sync.SyncConflict([{'table': 'confirmation', 'key': 'local data changed since preview'}])

                async def upload():
                    with (root / 'request.zip').open('rb') as source:
                        while chunk := await run_in_threadpool(source.read, 1024 * 1024):
                            yield chunk

                async with httpx.AsyncClient(timeout=httpx.Timeout(600, connect=10), follow_redirects=False, trust_env=False) as client:
                    async with client.stream('POST', target + '/api/user-data/sync/exchange', headers=headers, content=upload()) as response:
                        await checked(response)
                        manager.job['status'] = 'downloading'
                        with (root / 'response.tmp').open('wb') as output:
                            async for chunk in response.aiter_bytes():
                                manager.job['bytes'] += len(chunk)
                                if manager.job['bytes'] > data_transfer.MAX_ARCHIVE_BYTES:
                                    raise ValueError('Synchronization response exceeds 4 GiB.')
                                await run_in_threadpool(output.write, chunk)
                received = await run_in_threadpool(sync.read_snapshot, root / 'response.tmp')
                if received['sync']['account'] != plan['remote_account'] or received['sync'].get('request_id') != plan['preview']['plan_id']:
                    raise ValueError('The synchronization response belongs to another account or request.')
                (root / 'response.tmp').replace(root / 'response.zip')
            received = await run_in_threadpool(sync.read_snapshot, root / 'response.zip')
            manager.job['status'] = 'importing'
            async with gate.exclusive(username):
                current = await run_in_threadpool(sync.export_snapshot, username, root / 'current.zip', manager.offline(target))
                expected_raw = sync.raw_fingerprint(username)
                sent = await run_in_threadpool(sync.read_snapshot, root / 'request.zip')
                if sent['sync'].get('scope') == 'user-data':
                    received['files'].update(received['sync'].get('cached_files', {}))
                    await run_in_threadpool(sync.write_snapshot, received,
                                           [root / 'current.zip', root / 'response.zip'], root / 'hydrated.zip')
                    sent['files'].update(sent['sync'].get('known_files', {}))
                if action == 'replace_local' and sync.fingerprint(current) != sync.fingerprint(sent):
                    raise sync.SyncConflict([{'table': 'confirmation', 'key': 'local data changed since preview'}])
                merged = (sync.offline_merge if sent['sync'].get('scope') == 'user-data' else sync.merge_snapshots)(sent, current, received)
                await run_in_threadpool(sync.write_snapshot, merged, [root / 'current.zip', root / ('hydrated.zip' if sent['sync'].get('scope') == 'user-data' else 'response.zip')], root / 'merged.zip')
                if sync.fingerprint(merged) != sync.fingerprint(current):
                    result = await run_in_threadpool(sync.apply_snapshot, username, root / 'merged.zip', expected_raw,
                                                    peer=received['sync']['account'], checkpoint=received)
                else:
                    with closing(db.get_db()) as conn:
                        sync.save_checkpoint(conn, username, received['sync']['account'], received)
                        conn.commit()
                    result = {'documents': len(current['tables']['documents'])}
            options = manager.config.setdefault('sync_options', {}).setdefault(target, {})
            if sent['sync'].get('scope') == 'user-data':
                options['offline_ready'] = True
            options['action'] = 'merge'  # Never repeat a destructive initial policy automatically.
            manager.save()
            manager.job.update(status='completed', documents=result['documents'])
            plan_file.unlink(missing_ok=True)
            for name in ('request.zip', 'response.zip', 'response.tmp', 'current.zip', 'local.zip', 'merged.zip', 'hydrated.zip'):
                (root / name).unlink(missing_ok=True)
        except sync.SyncConflict as exc:
            plan['conflict'] = True
            atomic_write_text(str(plan_file), json.dumps(plan))
            manager.job.update(status='conflict', error=str(exc), conflicts=exc.conflicts)
            manager.config.setdefault('sync_options', {}).setdefault(target, {})['automatic'] = False
            manager.save()
        except (httpx.HTTPError, ValueError, OSError, HTTPException) as exc:
            manager.job.update(status='failed', error=str(getattr(exc, 'detail', exc)) or 'Synchronization failed. Retry to resume.')
        except Exception:
            logger.exception('Desktop synchronization failed; keeping the pending transfer for retry')
            manager.job.update(status='failed', error='Synchronization did not finish. Retry to resume the pending transfer.')
