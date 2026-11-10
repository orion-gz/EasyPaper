"""Shared, cached provider observations. Never include prompts or user identities."""
import asyncio
import time
import weakref
from collections import Counter
from contextlib import asynccontextmanager

from services import inference_servers, lab
from services.ssh_connections import client

_observers = weakref.WeakKeyDictionary()
_active = Counter()
_waiting = Counter()
_errors = set()


@asynccontextmanager
async def tracking(configuration, waiting=False):
    key = (configuration.get('id'), configuration['model'])
    counts = _waiting if waiting else _active
    counts[key] += 1
    if not waiting:
        _errors.discard(key)
    try:
        yield
    except asyncio.CancelledError:
        raise
    except Exception:
        if not waiting:
            _errors.add(key)
        raise
    finally:
        counts[key] -= 1
        if not counts[key]:
            del counts[key]


async def observe(server):
    headers = {'Authorization': 'Bearer ' + server['api_key']} if server.get('api_key') else {}
    path = '/api/ps' if server['engine'] == 'ollama' else '/models'
    try:
        async with client('inference:' + server['id'], server, timeout=5,
                          trust_env=False, follow_redirects=False) as connection:
            response = await connection.get(server['url'].rstrip('/') + path, headers=headers)
            response.raise_for_status()
            value = response.json()
            if server['engine'] == 'vllm':
                root = server['url'].rstrip('/')
                root = root[:-3] if root.endswith('/v1') else root
                health = await connection.get(root + '/health', headers=headers)
                health.raise_for_status()
                sleeping = await connection.get(root + '/is_sleeping', headers=headers)
                if sleeping.status_code == 200 and sleeping.json().get('is_sleeping'):
                    return {}, None
                if sleeping.status_code not in (200, 404):
                    sleeping.raise_for_status()
        if server['engine'] == 'ollama':
            return {item['name']: item.get('size_vram') for item in value['models']}, None
        return {item['id']: None for item in value['data']}, None
    except Exception:
        return {}, 'Provider status unavailable'


async def snapshot():
    enabled = lab.settings()['enabled']
    if not enabled:
        return {'enabled': False, 'models': []}
    from services.lab_runtime import ensure_owner
    ensure_owner()
    from services.lab_resources import availability, model_key
    all_records = inference_servers.state()['servers']
    visible = [s for s in all_records if s.get('enabled', True) and s.get('lab_shared', True)]
    pools = {(s.get('memory_policy') or {}).get('gpu_pool') for s in visible} - {None, ''}
    records = [s for s in all_records if s in visible or (s.get('memory_policy') or {}).get('gpu_pool') in pools]
    state = _observers.setdefault(asyncio.get_running_loop(), {'lock': asyncio.Lock(), 'expires': 0})
    fingerprint = repr(records)
    async with state['lock']:
        if state.get('fingerprint') != fingerprint or state['expires'] <= time.monotonic():
            async def read(record):
                try:
                    return await observe(inference_servers.get(record['id']))
                except Exception:
                    return {}, 'Provider status unavailable'
            state['values'] = await asyncio.gather(*(read(s) for s in records))
            from services.lab_resources import gpu_info
            state['gpu'] = {}
            for server in records:
                pool = (server.get('memory_policy') or {}).get('gpu_pool')
                if pool and pool not in state['gpu']:
                    state['gpu'][pool] = await gpu_info(server)
            state.update(fingerprint=fingerprint, expires=time.monotonic() + 3)
        observations = state['values']
    models = []
    observed = dict(zip((r['id'] for r in records), observations))
    for server, (resident, error) in zip(records, observations):
        if not server.get('enabled', True) or not server.get('lab_shared', True):
            continue
        resident = {model_key(server['engine'], name): size for name, size in resident.items()}
        for model in server['models']:
            key = (server['id'], model)
            loaded = model_key(server['engine'], model) in resident
            allowed, reason = await availability(dict(server, model=model), records, observed, state.get('gpu', {}))
            status = ('error' if error or key in _errors else
                      'inferencing' if _active[key] and loaded else
                      'loading' if _active[key] else 'idle' if loaded else 'unloaded')
            models.append({'server_id': server['id'], 'provider': server['engine'], 'model': model,
                           'name': server['name'], 'state': status, 'vram_bytes': resident.get(model_key(server['engine'], model)),
                           'active_requests': _active[key], 'queued_requests': _waiting[key],
                           'available': not error and allowed and (loaded or server['engine'] == 'ollama'),
                           'detail': error or reason})
    return {'enabled': True, 'models': models}
