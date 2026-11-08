"""Run in the configured vLLM Python environment; never instantiate a model/GPU.

Stdout is a JSON-lines protocol. Hub/vLLM diagnostics are redirected to stderr.
"""
import contextlib
import json
import inspect
import os
from pathlib import Path
import sys
import time

OUTPUT = sys.stdout


def emit(**data):
    print(json.dumps(data), file=OUTPUT, flush=True)


def run(action, model_id, cache):
    from vllm import ModelRegistry
    from importlib.metadata import version
    from huggingface_hub import HfApi, hf_hub_download
    if 'tqdm_class' not in inspect.signature(hf_hub_download).parameters:
        raise ValueError('Upgrade huggingface_hub in the vLLM environment to a version supporting hf_hub_download(tqdm_class=...).')
    architectures = list(ModelRegistry.get_supported_archs())
    if action == 'capabilities':
        emit(architectures=architectures, version=version('vllm'))
        return
    from huggingface_hub.utils import tqdm
    api = HfApi(token=os.environ.get('HF_TOKEN'))
    info = api.model_info(model_id, files_metadata=True)
    revision = info.sha
    config_path = hf_hub_download(model_id, 'config.json', revision=revision, cache_dir=cache)
    config = json.loads(Path(config_path).read_text())
    if not set(config.get('architectures', [])).intersection(architectures):
        raise ValueError('The installed vLLM does not support this model architecture. Upgrade vLLM or choose another model.')
    # Only native safetensors repositories: never execute repository Python code.
    files = [f for f in info.siblings if '/' not in f.rfilename and
             (f.rfilename.endswith(('.safetensors', '.json', '.model', '.txt', '.jinja', '.tiktoken')))]
    if not any(f.rfilename.endswith('.safetensors') for f in files):
        raise ValueError('A native safetensors model repository is required.')
    if not any('tokenizer' in f.rfilename or f.rfilename == 'vocab.json' for f in files):
        raise ValueError('The repository has no tokenizer files.')
    if any(f.size is None for f in files):
        raise ValueError('The Hub did not provide file sizes for verification.')
    total = sum(f.size for f in files)
    emit(status='Downloading', total=total, completed=0, revision=revision)
    completed = 0
    last = 0.0

    class Progress(tqdm):
        def update(self, n=1):
            nonlocal last
            result = super().update(n)
            now = time.monotonic()
            if now - last >= .5:
                emit(status='Downloading', total=total, completed=min(total, completed + self.n))
                last = now
            return result

    paths = []
    for file in files:
        path = Path(hf_hub_download(model_id, file.rfilename, revision=revision, cache_dir=cache, tqdm_class=Progress))
        if path.stat().st_size != file.size:
            raise ValueError('Downloaded file size does not match the Hub manifest.')
        paths.append((path, file.size))
        completed += file.size
        emit(status='Downloading', total=total, completed=completed)
    emit(status='Verifying', total=total, completed=completed)
    for path, size in paths:
        if not path.is_file() or path.stat().st_size != size:
            raise ValueError('Downloaded cache is incomplete.')
    from safetensors import safe_open
    from transformers import AutoTokenizer
    AutoTokenizer.from_pretrained(str(Path(config_path).parent), local_files_only=True, trust_remote_code=False)
    for path, _ in paths:
        if path.suffix == '.safetensors':
            with safe_open(path, framework='pt', device='cpu') as weights:
                if not weights.keys():
                    raise ValueError('A model weight file is empty.')
    # Ensure every shard referenced by the index exists.
    for path, _ in paths:
        if path.name.endswith('.safetensors.index.json'):
            for shard in set(json.loads(path.read_text()).get('weight_map', {}).values()):
                if Path(shard).name != shard or not (path.parent / shard).is_file():
                    raise ValueError('A weight shard is missing.')
    emit(status='Completed', total=total, completed=completed, revision=revision)


if __name__ == '__main__':
    try:
        with contextlib.redirect_stdout(sys.stderr):
            run(*sys.argv[1:])
    except Exception as exc:
        # Do not return Hub URLs, headers, or authentication tokens to clients.
        status = getattr(getattr(exc, 'response', None), 'status_code', None)
        message = ('Hugging Face authentication required. Configure HF_TOKEN on the Lab server and accept the model license.'
                   if status in (401, 403) else 'Model not found on Hugging Face.' if status == 404 else
                   str(exc) if isinstance(exc, ValueError) else
                   'Hugging Face/vLLM operation failed. Check installation, network, cache permissions and disk space.')
        emit(error=message)
        sys.exit(1)
