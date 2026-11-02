"""Validate the inference server contract before sending private cache salts."""
import hashlib
import time

import httpx

_verified = {}


async def require_cache_salt(configuration):
    endpoint = configuration['url'].rstrip('/')
    key = (endpoint, hashlib.sha256(configuration.get('api_key', '').encode()).hexdigest())
    if _verified.get(key, 0) > time.monotonic():
        return
    # vLLM exposes OpenAPI at the server root, outside its /v1 API prefix.
    root = endpoint[:-3] if endpoint.endswith('/v1') else endpoint
    headers = {'Authorization': 'Bearer ' + configuration['api_key']} if configuration.get('api_key') else {}
    async with httpx.AsyncClient(timeout=15, follow_redirects=False, trust_env=False) as client:
        response = await client.get(root + '/openapi.json', headers=headers)
        response.raise_for_status()
        schema = response.json()
    def resolve(value):
        seen = set()
        while '$ref' in value:
            reference = value['$ref']
            if not reference.startswith('#/') or reference in seen:
                return {}
            seen.add(reference)
            value = schema
            for part in reference[2:].split('/'):
                value = value.get(part.replace('~1', '/').replace('~0', '~'), {})
        return value
    request = schema.get('paths', {}).get('/v1/chat/completions', {}).get('post', {}).get('requestBody', {})
    request = resolve(request).get('content', {}).get('application/json', {}).get('schema', {})
    salt = resolve(resolve(request).get('properties', {}).get('cache_salt', {}))
    variants = salt.get('anyOf', [salt])
    if not any(resolve(value).get('type') == 'string' for value in variants):
        raise RuntimeError('The vLLM server must expose a chat request schema with cache_salt support. Check its version and reverse proxy OpenAPI access.')
    if len(_verified) >= 64:
        _verified.clear()
    _verified[key] = time.monotonic() + 60


async def probe(configuration):
    """An explicit admin check performs one minimal completion, not just discovery."""
    vllm = configuration['engine'] == 'vllm'
    if vllm:
        await require_cache_salt(configuration)
    headers = {'Authorization': 'Bearer ' + configuration['api_key']} if configuration.get('api_key') else {}
    path = '/chat/completions' if vllm else '/api/chat'
    payload = {'model': configuration['model'], 'messages': [{'role': 'user', 'content': 'Reply OK.'}], 'stream': False}
    if vllm:
        import secrets
        payload.update(max_tokens=1, cache_salt=secrets.token_hex(32))
    else:
        payload['options'] = {'num_predict': 1}
    async with httpx.AsyncClient(timeout=120, follow_redirects=False, trust_env=False) as client:
        response = await client.post(configuration['url'].rstrip('/') + path, headers=headers, json=payload)
        response.raise_for_status()
        result = response.json()
    if (vllm and not result.get('choices')) or (not vllm and 'message' not in result):
        raise RuntimeError('The server did not return a valid inference response.')
    return {'inference_verified': True, 'cache_salt_supported': True if vllm else None}
