"""Conservative admission for operator-assigned GPU budgets.

Servers on the same physical GPU use the same GPU pool ID. Existing inference is
never killed to fit another model. vLLM owns its process/KV allocation; this
module does not invoke its disruptive sleep or wake endpoints.
"""
import asyncio
import math
import weakref
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import HTTPException
from pydantic import BaseModel, Field


class ModelMemory(BaseModel):
    parameters_billions: float = Field(gt=0, le=10000)
    weight_bits: float = Field(default=4, ge=1, le=64)
    context_tokens: int = Field(default=8192, ge=1, le=10000000)
    kv_bytes_per_token: int = Field(default=131072, ge=1, le=100000000)
    concurrency: int = Field(default=1, ge=1, le=64)
    measured_gib: float | None = Field(default=None, gt=0, le=100000)

    def estimate(self):
        weights = self.parameters_billions * 1e9 * self.weight_bits / 8
        kv = self.context_tokens * self.kv_bytes_per_token * self.concurrency
        return math.ceil(max((weights + kv) * 1.2, (self.measured_gib or 0) * 2**30))


class MemoryPolicy(BaseModel):
    gpu_pool: str = Field(default='', max_length=200)
    budget_gib: float = Field(gt=0, le=100000)
    max_loaded: int = Field(default=1, ge=1, le=100)
    models: dict[str, ModelMemory] = Field(default_factory=dict, max_length=100)


_states = weakref.WeakKeyDictionary()
maintenance = set()


def parse_gpus(output):
    gpus = []
    for line in output.splitlines():
        identifier, name, total, free = [part.strip() for part in line.split(',')]
        gpus.append({'id': identifier, 'name': name, 'total_bytes': int(total) * 2**20, 'free_bytes': int(free) * 2**20})
    return {'available': bool(gpus), 'gpus': gpus}


async def gpu_info(server):
    # The only remote command is fixed; no user-supplied command or argument.
    command = ['nvidia-smi', '--query-gpu=uuid,name,memory.total,memory.free', '--format=csv,noheader,nounits']
    if server.get('transport') == 'ssh':
        # A jump host can forward to another machine. Its GPU would be unrelated.
        if urlsplit(server['url']).hostname not in ('localhost', '127.0.0.1', '::1'):
            return {'available': False, 'reason': 'GPU telemetry requires a loopback service on the SSH host.', 'gpus': []}
        from services.ssh_connections import manager
        import asyncssh
        key = 'inference:' + server['id']
        try:
            async with manager.lease(key):
                await manager.port(key, server)
                connection = manager.connections[key][0]
                result = await connection.run(' '.join(command), check=True, timeout=3)
                return parse_gpus(result.stdout)
        except (OSError, ValueError, HTTPException, asyncssh.Error, asyncio.TimeoutError):
            return {'available': False, 'reason': 'GPU query unavailable through the configured SSH account.', 'gpus': []}
    if urlsplit(server['url']).hostname not in ('localhost', '127.0.0.1', '::1'):
        return {'available': False, 'reason': 'Remote HTTP GPU telemetry is not configured.', 'gpus': []}
    process = None
    try:
        process = await asyncio.create_subprocess_exec(*command,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        output, _ = await asyncio.wait_for(process.communicate(), 3)
        if process.returncode:
            raise ValueError('GPU query failed')
        return parse_gpus(output.decode())
    except (OSError, ValueError, asyncio.TimeoutError):
        return {'available': False, 'reason': 'NVIDIA GPU telemetry unavailable.', 'gpus': []}
    finally:
        if process and process.returncode is None:
            process.kill()
            await process.wait()


def recommendations(server, policy, available_bytes=None):
    estimates = {name: spec.estimate() for name, spec in policy.models.items() if name in server['models']}
    budget = int(policy.budget_gib * 2**30)
    if available_bytes is not None:
        budget = min(budget, available_bytes)
    # A bounded greedy plan for every possible first model avoids 2**N work.
    plans = set()
    ordered = sorted(estimates, key=estimates.get)
    for first in ordered:
        chosen, used = [], 0
        for name in [first] + [n for n in ordered if n != first]:
            if len(chosen) < policy.max_loaded and used + estimates[name] <= budget:
                chosen.append(name)
                used += estimates[name]
        if chosen:
            plans.add(tuple(sorted(chosen)))
    return {'estimated_bytes': estimates, 'budget_bytes': budget,
            'suggestions': sorted(plans, key=lambda plan: (-len(plan), plan)),
            'estimate_only': True, 'unknown_models': [n for n in server['models'] if n not in estimates]}


def model_key(engine, model):
    """Ollama omits :latest in requests but includes it in /api/ps."""
    if engine == 'ollama' and ':' not in model.rsplit('/', 1)[-1]:
        return model + ':latest'
    return model


def endpoint_key(server):
    import hashlib
    import json
    ssh = server.get('ssh') or {}
    value = [server['engine'], server['url'].rstrip('/'), server.get('transport'),
             ssh.get('host'), ssh.get('port'), ssh.get('username')]
    return hashlib.sha256(json.dumps(value).encode()).hexdigest()


def pool_records(server):
    from services import inference_servers
    pool = (server.get('memory_policy') or {}).get('gpu_pool')
    peers = [s for s in inference_servers.state()['servers']
             if (s.get('memory_policy') or {}).get('gpu_pool') == pool]
    return [s for s in peers if s['id'] != server['id']] + [server]


def pool_state(pool):
    return _states.setdefault(asyncio.get_running_loop(), {}).setdefault(pool, {
        'lock': asyncio.Lock(), 'reserved': {}, 'active': {},
    })


async def inspect_pool(server, state, records, observations, gpu_observations=None):
    """One decision function for the catalog and execution admission."""
    policy = MemoryPolicy(**server['memory_policy'])
    model = model_key(server['engine'], server['model'])
    key = (endpoint_key(server), model)
    estimates, resident, limits = {}, {}, []
    max_loaded = policy.max_loaded
    for peer in records:
        peer_policy = MemoryPolicy(**peer['memory_policy'])
        limits.append(peer_policy.budget_gib * 2**30)
        max_loaded = min(max_loaded, peer_policy.max_loaded)
        endpoint = endpoint_key(peer)
        for name, spec in peer_policy.models.items():
            k = (endpoint, model_key(peer['engine'], name))
            estimates[k] = max(estimates.get(k, 0), spec.estimate())
        values, error = observations[peer['id']]
        if error:
            raise HTTPException(503, 'Cannot verify a server in this GPU pool.')
        for name, actual in values.items():
            k = (endpoint, model_key(peer['engine'], name))
            if actual is None and k not in estimates:
                raise HTTPException(409, 'A resident model has no memory estimate.')
            resident[k] = max(actual or 0, resident.get(k, 0))
    if key not in estimates:
        raise HTTPException(409, 'The Lab Master must configure a memory estimate for this model.')
    if server['engine'] == 'vllm' and key not in resident:
        raise HTTPException(409, 'The vLLM model is not resident. Ask the server operator to load it.')
    spec = next((spec for name, spec in policy.models.items() if model_key(server['engine'], name) == model), None)
    if spec is None:
        raise HTTPException(409, 'The selected model has no memory estimate.')
    if state['active'].get(key, 0) >= spec.concurrency:
        raise HTTPException(409, 'The model concurrency budget is full; requests will queue.')
    allocation = {k: size for k, size in state['reserved'].items()
                  if k in resident or state['active'].get(k, 0)}
    for k, actual in resident.items():
        allocation[k] = max(actual, estimates.get(k, 0), allocation.get(k, 0))
    additional = max(0, estimates[key] - allocation.get(key, 0))
    allocation[key] = max(allocation.get(key, 0), estimates[key])
    if len(allocation) > max_loaded or sum(allocation.values()) > min(limits):
        raise HTTPException(409, 'Shared GPU pool budget is full. Retry after a model becomes unloaded.')
    if additional:
        gpu = (gpu_observations or {}).get(policy.gpu_pool)
        if gpu is None:
            gpu = await gpu_info(server)
        if gpu['available']:
            selected = next((g for g in gpu['gpus'] if g['id'] == policy.gpu_pool), None)
            if not selected:
                raise HTTPException(409, 'Use the physical GPU UUID as the pool ID for a local server.')
            # Include admitted loads not yet reported by provider telemetry.
            pending = sum(size for k, size in allocation.items() if k not in resident)
            if max(additional, pending) > selected['free_bytes']:
                raise HTTPException(409, 'Insufficient free GPU memory for this pool.')
    return key, allocation


def require_policy(server):
    from services import lab
    if server.get('id') in maintenance:
        raise HTTPException(409, 'Model maintenance is in progress. Retry shortly.')
    raw = server.get('memory_policy')
    if not raw:
        if lab.settings()['enabled']:
            raise HTTPException(409, 'The Lab Master must configure a GPU memory policy before shared inference.')
        return None
    policy = MemoryPolicy(**raw)
    if not policy.gpu_pool.strip():
        raise HTTPException(409, 'Assign a physical GPU pool ID before shared inference.')
    return policy


async def observations_for(records):
    from services import inference_servers
    from services.lab_models import observe
    async def read(record):
        try:
            # The current selection already carries its credentials; peer secrets
            # are resolved only on the server, never returned to the catalog.
            value = record if 'api_key' in record else inference_servers.get(record['id'])
        except HTTPException:
            value = record
        return await observe(value)
    values = await asyncio.gather(*(read(record) for record in records))
    return dict(zip((r['id'] for r in records), values))


async def availability(server, records, observations, gpu_observations=None):
    try:
        policy = require_policy(server)
        if not policy:
            return True, None
        state = pool_state(policy.gpu_pool)
        peers = [s for s in records if (s.get('memory_policy') or {}).get('gpu_pool') == policy.gpu_pool]
        async with state['lock']:
            await inspect_pool(server, state, peers, observations, gpu_observations)
        return True, None
    except HTTPException as error:
        return False, error.detail


@asynccontextmanager
async def admission(server):
    policy = require_policy(server)
    if not policy:
        yield
        return
    state = pool_state(policy.gpu_pool)
    async with state['lock']:
        records = pool_records(server)
        observations = await observations_for(records)
        key, allocation = await inspect_pool(server, state, records, observations)
        state['reserved'] = allocation
        state['active'][key] = state['active'].get(key, 0) + 1
    try:
        yield
    finally:
        async with state['lock']:
            state['active'][key] -= 1
            if not state['active'][key]:
                del state['active'][key]


def constrain_payload(payload):
    """Keep Ollama requests within the context length used by admission."""
    from services.lab_context import selected_server
    server = selected_server.get()
    if not server or server.get('provider') != 'ollama' or not server.get('memory_policy'):
        return payload
    spec = server['memory_policy'].get('models', {}).get(server['model'])
    if not spec:
        return payload
    options = dict(payload.get('options', {}))
    options['num_ctx'] = min(options.get('num_ctx', spec['context_tokens']), spec['context_tokens'])
    return {**payload, 'options': options}



def guard_related(server):
    """Never unload or reconfigure an endpoint through an idle alias."""
    from services import inference_servers
    from services.ssh_connections import manager
    pool = (server.get('memory_policy') or {}).get('gpu_pool')
    for peer in inference_servers.state()['servers']:
        if (peer['id'] == server.get('id') or endpoint_key(peer) == endpoint_key(server)
                or (pool and (peer.get('memory_policy') or {}).get('gpu_pool') == pool)):
            manager.guard('inference:' + peer['id'])
