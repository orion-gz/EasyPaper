"""Narrow client for an operator-provisioned, OS-isolated CLI runner.

The application never executes a CLI with its own credentials in Lab Mode.
The private Unix socket is the only connection to the privileged runner.
"""
import json
import os
import httpx
from fastapi import HTTPException
from services import lab
from services.lab_context import identity

PROVIDERS = {'claude_code', 'codex', 'antigravity'}


def client():
    socket = os.environ.get('EASYPAPER_LAB_RUNNER_SOCKET')
    if not socket:
        raise HTTPException(503, 'The administrator must configure an isolated lab CLI runner.')
    return httpx.AsyncClient(transport=httpx.AsyncHTTPTransport(uds=socket), base_url='http://runner', timeout=600)


async def stream(provider, prompt, model, session_id):
    username = identity.get()
    user = lab.require_access(username)
    if not user or provider not in PROVIDERS:
        raise HTTPException(403, 'Unknown account or provider.')
    async with client() as connection:
        async with connection.stream('POST', '/run', json={
            'account': user['id'], 'provider': provider, 'prompt': prompt,
            'model': model, 'session': session_id,
        }) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                lab.require_access(username)
                if line:
                    value = json.loads(line)
                    if value.get('error'):
                        raise RuntimeError(value['error'])
                    yield value.get('text', '')


async def operation(username, provider, action):
    user = lab.require_access(username)
    if not user or provider not in PROVIDERS:
        raise HTTPException(404, 'Provider not found.')
    async with client() as connection:
        response = await connection.post('/provider', json={'account': user['id'], 'provider': provider, 'action': action}, timeout=15)
        if response.status_code != 200:
            raise HTTPException(503, 'The isolated provider runner is unavailable.')
        return response.json()


async def cancel_account(identifier):
    if not os.environ.get('EASYPAPER_LAB_RUNNER_SOCKET'):
        return
    async with client() as connection:
        response = await connection.post('/cancel-account', json={'account': identifier})
        response.raise_for_status()
