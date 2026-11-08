"""Conservative admission for operator-assigned GPU budgets.

Budgets must be disjoint across servers sharing a GPU. Existing inference is
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
    budget_gib: float = Field(gt=0, le=100000)
    max_loaded: int = Field(default=1, ge=1, le=100)
    models: dict[str, ModelMemory] = Field(default_factory=dict, max_length=100)


_states = weakref.WeakKeyDictionary()
maintenance = set()


async def gpu_info(server):
    # Never attribute this host's GPU memory to a remote inference endpoint.
    if server.get('transport') == 'ssh' or urlsplit(server['url']).hostname not in ('localhost', '127.0.0.1', '::1'):
        return {'available': False, 'reason': 'Remote GPU telemetry is not configured.', 'gpus': []}
    process = None
    try:
        process = await asyncio.create_subprocess_exec('nvidia-smi',
            '--query-gpu=uuid,name,memory.total,memory.free', '--format=csv,noheader,nounits',
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        output, _ = await asyncio.wait_for(process.communicate(), 3)
        if process.returncode:
            raise ValueError('GPU query failed')
        gpus = []
        for line in output.decode().splitlines():
            identifier, name, total, free = [part.strip() for part in line.split(',')]
            gpus.append({'id': identifier, 'name': name, 'total_bytes': int(total) * 2**20, 'free_bytes': int(free) * 2**20})
        return {'available': bool(gpus), 'gpus': gpus}
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


@asynccontextmanager
async def admission(server):
    if server.get('id') in maintenance:
        raise HTTPException(409, 'Model maintenance is in progress. Retry shortly.')
    raw = server.get('memory_policy')
    if not raw:
        yield
        return
    policy = MemoryPolicy(**raw)
    states = _states.setdefault(asyncio.get_running_loop(), {})
    state = states.setdefault(server['id'], {'lock': asyncio.Lock(), 'reserved': {}, 'active': {}})
    model = server['model']
    from services.lab_models import observe
    async with state['lock']:
        resident, error = await observe(server)
        if error:
            raise HTTPException(503, 'Cannot verify GPU model state. Retry after the provider recovers.')
        estimates = {name: spec.estimate() for name, spec in policy.models.items()}
        if model not in estimates:
            raise HTTPException(409, 'The Lab Master must configure a memory estimate for this model.')
        if state['active'].get(model, 0) >= policy.models[model].concurrency:
            raise HTTPException(409, 'The model memory concurrency budget is full. Retry shortly.')
        # Retain reservations for requests not yet reflected by the provider.
        state['reserved'] = {name: size for name, size in state['reserved'].items()
                             if name in resident or state['active'].get(name, 0)}
        allocation = dict(state['reserved'])
        for name, actual in resident.items():
            if actual is None and name not in estimates:
                raise HTTPException(409, 'A resident model has no memory estimate.')
            allocation[name] = max(actual or 0, estimates.get(name, 0), allocation.get(name, 0))
        additional = 0 if model in allocation else estimates[model]
        allocation[model] = max(allocation.get(model, 0), estimates[model])
        if len(allocation) > policy.max_loaded or sum(allocation.values()) > policy.budget_gib * 2**30:
            raise HTTPException(409, 'Shared GPU budget is full. Retry after a model becomes unloaded.')
        if additional:
            gpu = await gpu_info(server)
            if gpu['available'] and additional > max(g['free_bytes'] for g in gpu['gpus']):
                raise HTTPException(409, 'Insufficient free GPU memory to load this model safely.')
        state['reserved'] = allocation
        state['active'][model] = state['active'].get(model, 0) + 1
    try:
        yield
    finally:
        async with state['lock']:
            state['active'][model] -= 1
            if not state['active'][model]:
                del state['active'][model]


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
