"""Real tokenizer and safetensors fixtures; no GPU or Hub network required."""
import json
import sys
from types import ModuleType, SimpleNamespace

import pytest


def snapshot(tmp_path):
    import numpy as np
    from safetensors.numpy import save_file
    from tokenizers import Tokenizer, models
    from transformers import PreTrainedTokenizerFast
    tokenizer = Tokenizer(models.WordLevel({'[UNK]':0,'Hello':1},unk_token='[UNK]'))
    wrapper = PreTrainedTokenizerFast(tokenizer_object=tokenizer,unk_token='[UNK]')
    wrapper.chat_template = "{% for message in messages %}{{ message['role'] }}: {{ message['content'] }}{% endfor %}"
    wrapper.save_pretrained(tmp_path)
    save_file({'weight':np.zeros((2,2),dtype=np.float32)},str(tmp_path/'model.safetensors'))
    return [(p.name,p.stat().st_size) for p in tmp_path.iterdir()]


def test_real_files_and_chat_template(tmp_path):
    from services.hf_model_worker import verify_files
    files=snapshot(tmp_path)
    verify_files(tmp_path,files)
    weight=tmp_path/'model.safetensors'
    # A corrupt header of the same size must fail, not just pass a size check.
    weight.write_bytes(b'x'*weight.stat().st_size)
    with pytest.raises(Exception): verify_files(tmp_path,files)


def test_real_tokenizer_without_chat_template_is_rejected(tmp_path):
    from services.hf_model_worker import verify_files
    snapshot(tmp_path)
    (tmp_path/'chat_template.jinja').unlink(missing_ok=True)
    config=tmp_path/'tokenizer_config.json'
    data=json.loads(config.read_text()); data.pop('chat_template',None)
    config.write_text(json.dumps(data))
    files=[(p.name,p.stat().st_size) for p in tmp_path.iterdir()]
    with pytest.raises(ValueError,match='chat template'): verify_files(tmp_path,files)


def test_runtime_rejects_pooling_and_invalid_quantization(tmp_path,monkeypatch):
    from services.hf_model_worker import validate_runtime
    vllm=ModuleType('vllm'); config=ModuleType('vllm.config')
    vllm.ModelRegistry=SimpleNamespace(is_text_generation_model=lambda architectures,model_config:False)
    config.ModelConfig=lambda **kwargs:SimpleNamespace(quantization=None)
    monkeypatch.setitem(sys.modules,'vllm',vllm); monkeypatch.setitem(sys.modules,'vllm.config',config)
    with pytest.raises(ValueError,match='text-generation'): validate_runtime(tmp_path,['EmbeddingModel'])
    def invalid(**kwargs): raise ValueError('Unsupported quantization configuration')
    config.ModelConfig=invalid
    with pytest.raises(ValueError,match='quantization'): validate_runtime(tmp_path,['ChatModel'])
