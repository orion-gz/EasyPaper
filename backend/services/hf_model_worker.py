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
import tempfile

OUTPUT = sys.stdout


def emit(**data):
    print(json.dumps(data), file=OUTPUT, flush=True)


def validate_runtime(snapshot, architectures):
    """Run the installed vLLM config checks without creating an engine or weights."""
    from vllm import ModelRegistry
    from vllm.config import ModelConfig
    model_config = ModelConfig(model=str(snapshot), tokenizer=str(snapshot), trust_remote_code=False)
    check = ModelRegistry.is_text_generation_model
    kwargs = {'model_config': model_config} if 'model_config' in inspect.signature(check).parameters else {}
    if not check(architectures, **kwargs):
        raise ValueError('This vLLM model is not a text-generation model; pooling/embedding models cannot be shared for chat.')
    return getattr(model_config, 'quantization', None)


def verify_files(snapshot, files):
    """Validate real local files and chat rendering, without loading tensor data."""
    from safetensors import safe_open
    from transformers import AutoTokenizer
    snapshot = Path(snapshot)
    for name, size in files:
        path = snapshot / name
        if not path.is_file() or path.stat().st_size != size:
            raise ValueError('Downloaded cache is incomplete or a file size is incorrect.')
        if path.suffix == '.safetensors':
            with safe_open(path, framework='np') as weights:
                if not weights.keys():
                    raise ValueError('A model weight file is empty.')
        if path.name.endswith('.safetensors.index.json'):
            for shard in set(json.loads(path.read_text()).get('weight_map', {}).values()):
                if Path(shard).name != shard or not (snapshot / shard).is_file():
                    raise ValueError('A weight shard is missing.')
    tokenizer = AutoTokenizer.from_pretrained(str(snapshot), local_files_only=True, trust_remote_code=False)
    try:
        tokenizer.apply_chat_template([{'role': 'user', 'content': 'Hello'}], tokenize=False, add_generation_prompt=True)
    except (ValueError, TypeError) as exc:
        raise ValueError('This model has no usable chat template. Choose an instruction/chat model.') from exc


def run(action, model_id, cache):
    from vllm import ModelRegistry
    from importlib.metadata import version
    from huggingface_hub import HfApi, hf_hub_download
    if 'tqdm_class' not in inspect.signature(hf_hub_download).parameters:
        raise ValueError('Upgrade huggingface_hub in the vLLM environment to a version supporting hf_hub_download(tqdm_class=...).')
    architectures = list(ModelRegistry.get_supported_archs())
    if action == 'capabilities':
        Path(cache).mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryFile(dir=cache) as probe:
            probe.write(b'cache probe')
            probe.flush()
        emit(architectures=architectures, version=version('vllm'), cache_writable=True)
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

    files.sort(key=lambda file: file.rfilename.endswith('.safetensors'))
    paths = []
    runtime_checked = False
    quantization = None
    for file in files:
        if file.rfilename.endswith('.safetensors') and not runtime_checked:
            quantization = validate_runtime(Path(config_path).parent, config.get('architectures', []))
            runtime_checked = True
        path = Path(hf_hub_download(model_id, file.rfilename, revision=revision, cache_dir=cache, tqdm_class=Progress))
        if path.stat().st_size != file.size:
            raise ValueError('Downloaded file size does not match the Hub manifest.')
        paths.append((path, file.size))
        completed += file.size
        emit(status='Downloading', total=total, completed=completed)
    emit(status='Verifying', total=total, completed=completed)
    verify_files(Path(config_path).parent, [(path.name, size) for path, size in paths])
    emit(status='Completed', total=total, completed=completed, revision=revision, quantization=quantization or 'unquantized', validation='vllm-config-and-local-files')


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
