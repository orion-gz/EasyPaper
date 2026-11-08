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
    records = [s for s in inference_servers.state()['servers'] if s.get('enabled', True) and s.get('lab_shared', True)]
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
            state.update(fingerprint=fingerprint, expires=time.monotonic() + 3)
        observations = state['values']
    models = []
    for server, (resident, error) in zip(records, observations):
        for model in server['models']:
            key = (server['id'], model)
            loaded = model in resident
            status = ('error' if error or key in _errors else
                      'inferencing' if _active[key] and loaded else
                      'loading' if _active[key] else 'idle' if loaded else 'unloaded')
            models.append({'server_id': server['id'], 'provider': server['engine'], 'model': model,
                           'name': server['name'], 'state': status, 'vram_bytes': resident.get(model),
                           'active_requests': _active[key], 'queued_requests': _waiting[key],
                           'available': not error and (loaded or server['engine'] == 'ollama'),
                           'detail': error})
    return {'enabled': True, 'models': models}
