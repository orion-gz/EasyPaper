import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest


def test_preview_discovers_and_calls_selected_ollama(test_client):
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            calls.append((self.path, self.headers.get('Authorization')))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"models":[{"name":"test-model"}]}')

        def do_POST(self):
            calls.append((self.path, self.headers.get('Authorization')))
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            assert body['model'] == 'test-model'
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"message":{"content":"example translation"},"done":true}\n')

    with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as httpd:
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()
        try:
            target = dict(name='test', engine='ollama', url=f'http://127.0.0.1:{httpd.server_port}',
                          credentials={'api_key': 'preview-token'})
            discovery = test_client.post('/api/settings/discover-models', json=target)
            assert discovery.json()['models'] == ['test-model']
            response = test_client.post('/api/settings/translation-preview', json={
                'provider': 'ollama', 'model': 'test-model', 'server': target})
            assert response.json() == {'translation': 'example translation'}
            assert calls == [('/api/tags', 'Bearer preview-token'), ('/api/chat', 'Bearer preview-token')]
        finally:
            httpd.shutdown()
            worker.join()


def test_remote_translation_respects_local_only(isolated_dirs, monkeypatch):
    import config
    from services import inference_servers
    from services.processing_policy import processing_disclosure
    monkeypatch.setattr(config, 'TRANS_SERVER_ID', 'remote')
    monkeypatch.setattr(config, 'OLLAMA_HOST', 'http://localhost:11434')
    monkeypatch.setattr(inference_servers, 'get', lambda _: {'engine': 'ollama', 'url': 'https://models.example.org'})
    assert not processing_disclosure('ollama', 'translate')['local_processing']
    assert processing_disclosure('ollama', 'chat')['local_processing']


@pytest.mark.asyncio
async def test_vllm_unsupported_host(monkeypatch):
    from services import onboarding_vllm as setup
    monkeypatch.setattr(setup.platform, 'system', lambda: 'Darwin')
    monkeypatch.setattr(setup, 'status', 'idle')
    monkeypatch.setattr(setup, 'job', None)
    started = await setup.start(setup.MODELS[0])
    assert started['status'] == 'installing'
    await setup.job
    assert setup.snapshot()['status'] == 'failed'
    assert 'Linux' in setup.snapshot()['log'][-1]


def test_saving_translation_preserves_other_settings(test_client, monkeypatch, tmp_path):
    import config
    monkeypatch.setenv('EASYPAPER_CONFIG_DIR', str(tmp_path))
    for name in ('TRANS_SERVER_ID', 'TRANS_MODEL', 'TRANS_PROVIDER'):
        monkeypatch.setattr(config, name, getattr(config, name))
    path = tmp_path / '.env'
    path.write_text('CHAT_PROVIDER=codex\nCHAT_MODEL=keep-chat\nPDF_PARSER_ENGINE=pdfplumber\n')
    result = test_client.put('/api/settings/translation-model', json={'provider': 'ollama', 'model': 'selected'})
    assert result.status_code == 200
    assert config.get_trans_model() == 'selected'
    assert path.read_text().startswith('CHAT_PROVIDER=codex\nCHAT_MODEL=keep-chat\nPDF_PARSER_ENGINE=pdfplumber\n')
