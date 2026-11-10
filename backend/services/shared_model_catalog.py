"""Official model IDs checked 2026-11-08; deployment support is checked at runtime."""
CATALOG = []
for name, provider, parameters, ollama, hf, architecture, memory in [
    ('Qwen 3.8 27B', 'Qwen', '27B', 'qwen3.8:27b', 'Qwen/Qwen3.8-27B', 'Qwen3_5ForConditionalGeneration', (24, 64)),
    ('Qwen 3.5 4B', 'Qwen', '4B', 'qwen3.5:4b', 'Qwen/Qwen3.5-4B', 'Qwen3_5ForConditionalGeneration', (6, 12)),
    ('Qwen 3.5 9B', 'Qwen', '9B', 'qwen3.5:9b', 'Qwen/Qwen3.5-9B', 'Qwen3_5ForConditionalGeneration', (10, 24)),
    ('Gemma 4 26B A4B', 'Google', '26B (4B active)', 'gemma4:26b', 'google/gemma-4-26B-A4B-it', 'Gemma4ForConditionalGeneration', (24, 64)),
    ('Gemma 4 31B', 'Google', '31B', 'gemma4:31b', 'google/gemma-4-31B-it', 'Gemma4ForConditionalGeneration', (28, 72)),
    ('gpt-oss 20B', 'OpenAI', '20B', 'gpt-oss:20b', 'openai/gpt-oss-20b', 'GptOssForCausalLM', (16, 16)),
]:
    for engine, model_id, vram in [('ollama', ollama, memory[0]), ('vllm', hf, memory[1])]:
        CATALOG.append(dict(name=name, provider=provider, parameters=parameters, engine=engine,
                            model_id=model_id, architecture=architecture, estimated_vram_gb=vram,
                            quantization='MXFP4' if provider == 'OpenAI' else ('library default' if engine == 'ollama' else 'BF16'),
                            uses=['chat', 'translation', 'paper analysis', 'reasoning'], checked_at='2026-11-08',
                            source=('https://ollama.com/library/' + ollama if engine == 'ollama' else 'https://huggingface.co/' + hf)))
