"""Single local vLLM installation job, shared by reconnecting setup clients."""
import asyncio
import os
import platform
import shutil
from collections import deque
from pathlib import Path

import httpx
from fastapi import HTTPException
from config import _get_config_dir

MODELS = ('Qwen/Qwen2.5-1.5B-Instruct', 'Qwen/Qwen2.5-3B-Instruct')
URL = 'http://127.0.0.1:18321/v1'
status = 'idle'
model = ''
log = deque(maxlen=40)
job = None
server = None


def snapshot():
    state = 'failed' if status == 'ready' and server and server.returncode is not None else status
    return dict(status=state, model=model, log=list(log), url=URL, models=MODELS)


async def run(*args):
    process = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE,
                                                   stderr=asyncio.subprocess.STDOUT)
    try:
        async for line in process.stdout:
            log.append(line.decode(errors='replace').strip()[-500:])
        if await process.wait():
            raise RuntimeError(log[-1] if log else 'Command failed')
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def install():
    global status, server
    try:
        if platform.system() != 'Linux' or not shutil.which('nvidia-smi'):
            raise RuntimeError('Linux and an NVIDIA GPU with a working driver are required.')
        log.clear()
        await run('nvidia-smi', '--query-gpu=compute_cap,memory.free', '--format=csv,noheader,nounits')
        devices = [row.split(',') for row in log if ',' in row]
        required_memory = 6144 if model == MODELS[0] else 10240
        if not any(float(capability) >= 7.5 and int(memory) >= required_memory for capability, memory in devices):
            raise RuntimeError(f'This model requires an NVIDIA GPU with compute capability 7.5+ and {required_memory} MiB free.')
        root = Path(_get_config_dir())
        if shutil.disk_usage(root).free < 20 * 1024**3:
            raise RuntimeError('At least 20 GiB of free disk space is required.')
        env = root / 'vllm-env'
        executable = env / 'bin/vllm'
        if not executable.exists():
            await run('python3', '-m', 'venv', os.fspath(env))
            await run(env / 'bin/python', '-m', 'pip', 'install', 'vllm')
        status = 'starting'
        logfile = root / 'vllm-server.log'
        with logfile.open('w') as output:
            server = await asyncio.create_subprocess_exec(executable, 'serve', model, '--host', '127.0.0.1',
                '--port', '18321', '--max-model-len', '4096', stdout=output, stderr=output)
        async with httpx.AsyncClient(timeout=3, trust_env=False) as client:
            for _ in range(900):
                await asyncio.sleep(2)
                if server.returncode is not None:
                    with logfile.open('rb') as output:
                        output.seek(max(0, logfile.stat().st_size - 1500))
                        raise RuntimeError(output.read().decode(errors='replace'))
                try:
                    response = await client.get(URL + '/models')
                    if response.is_success and model in [m['id'] for m in response.json()['data']]:
                        status = 'ready'
                        return
                except httpx.HTTPError:
                    pass
        raise RuntimeError('Model startup timed out.')
    except Exception as exc:
        if server and server.returncode is None:
            server.terminate()
            await server.wait()
        log.append(str(exc))
        status = 'failed'


async def start(choice):
    global job, status, model
    if choice not in MODELS:
        raise HTTPException(400, 'Choose a supported model.')
    if job and not job.done() or server and server.returncode is None:
        if model != choice:
            raise HTTPException(409, 'A different model is already running.')
        return snapshot()
    log.clear()
    model, status = choice, 'installing'
    job = asyncio.create_task(install())
    return snapshot()


async def restore():
    import config
    from services import inference_servers
    if not config.TRANS_SERVER_ID or not (Path(_get_config_dir()) / 'vllm-env/bin/vllm').exists():
        return
    try:
        target = inference_servers.get(config.TRANS_SERVER_ID, with_secrets=False)
    except HTTPException:
        return
    if target['engine'] == 'vllm' and target['url'] == URL and config.TRANS_MODEL in MODELS:
        await start(config.TRANS_MODEL)


async def shutdown():
    if job and not job.done():
        job.cancel()
        await asyncio.gather(job, return_exceptions=True)
    if server and server.returncode is None:
        server.terminate()
        try:
            await asyncio.wait_for(server.wait(), 15)
        except TimeoutError:
            server.kill()
            await server.wait()
