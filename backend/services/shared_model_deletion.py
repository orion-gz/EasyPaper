"""Opt-in maintenance deletion for operator-isolated inference deployments."""
from contextlib import closing
import hashlib
import json
import os

from fastapi import HTTPException
import httpx
from services import db, inference_servers as servers, shared_models as models
from services.ssh_connections import client, manager


def policy(server):
    fingerprint = hashlib.sha256(json.dumps(models.destination(server)).encode()).hexdigest()
    try:
        entry = json.loads(os.getenv('EASYPAPER_MODEL_MAINTENANCE', '{}')).get(server['id'], {})
        allowed = entry.get('isolated') is True and entry.get('destination') == fingerprint
        if server['engine'] == 'vllm':
            allowed = allowed and entry.get('engine_stopped') is True
    except (ValueError, AttributeError, TypeError):
        allowed = False
    return {'allowed': allowed, 'destination': fingerprint}


async def delete(server_id, identifier):
    server = servers.get(server_id)
    record = models.find(server_id, identifier)
    if not policy(server)['allowed']:
        raise HTTPException(409, 'File deletion requires an operator-isolated maintenance deployment bound to this destination.')
    if record['enabled'] or record['status'] in models.ACTIVE:
        raise HTTPException(409, 'Disable sharing and finish or cancel the download before deleting files.')
    # Conservative across aliases/hosts: never remove files behind another registered share.
    wanted = models.model_id(server['engine'], record['model_id'])
    for other in servers.state()['servers']:
        if other['engine'] != server['engine']:
            continue
        for item in models.records(other['id']):
            if item['id'] != identifier and models.canonical_id(other['engine'], item['model_id']) == wanted:
                raise HTTPException(409, 'Another shared model references this model. Remove that reference before deleting files.')
    async with manager.inference_maintenance():
        headers = {'Authorization': 'Bearer ' + server['api_key']} if server.get('api_key') else {}
        root = server['url'].rstrip('/')
        async with client('inference:' + server_id, server, maintenance=True, timeout=15, follow_redirects=False, trust_env=False) as connection:
            if server['engine'] == 'ollama':
                response = await connection.get(root + '/api/ps', headers=headers)
                response.raise_for_status()
                if response.json().get('models'):
                    raise HTTPException(409, 'Unload running models on the isolated Ollama host before deleting files.')
            else:
                models.target(server_id)
                # Offline deletion requires both an explicit operator assertion AND an unreachable endpoint.
                try:
                    response = await connection.get(root + '/models', headers=headers)
                except httpx.ConnectError:
                    pass
                else:
                    raise HTTPException(409, 'Stop the isolated vLLM endpoint before removing its cache. Any HTTP response blocks deletion.')
            record.update(status='Failed', verified=False, enabled=False, speed=None,
                          error='File deletion was started. Verify or download again before enabling this model.')
            models.write(record)
            if server['engine'] == 'ollama':
                response = await connection.request('DELETE', root + '/api/delete', headers=headers, json={'model': wanted})
                if response.status_code != 404:
                    response.raise_for_status()
                response = await connection.get(root + '/api/tags', headers=headers)
                response.raise_for_status()
                if any(models.canonical_id('ollama', m['name']) == wanted for m in response.json().get('models', [])):
                    raise HTTPException(502, 'Ollama still reports the model after deletion; its sharing remains disabled.')
            else:
                result = await models.worker(server_id, 'delete', wanted)
                if not result.get('files_deleted'):
                    raise HTTPException(502, 'The Hugging Face cache deletion was not verified.')
        with closing(db.get_db()) as conn, conn:
            conn.execute('DELETE FROM shared_models WHERE id=?', (identifier,))
    return {'deleted': True, 'files_deleted': True}
