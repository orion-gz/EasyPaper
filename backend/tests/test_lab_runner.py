import importlib.util
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

spec = importlib.util.spec_from_file_location('isolated_lab_runner', Path(__file__).parents[2] / 'deploy/lab/runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


@pytest.mark.parametrize('runtime', ['docker', 'systemd'])
def test_runner_only_mounts_provisioned_home(tmp_path, monkeypatch, runtime):
    home = tmp_path / 'alice'
    home.mkdir()
    account = 'a' * 32
    config = tmp_path / 'runner.json'
    config.write_text(json.dumps({'runtime': runtime, 'accounts': {account: {'uid': 20001, 'home': str(home)}},
        'providers': {'codex': {'image': 'test@sha256:abc', 'rootfs': '/srv/rootfs', 'run': ['cli', '--model', '{model}']}}}))
    monkeypatch.setattr(runner, 'CONFIG', config)
    request = runner.Inference(account=account, provider='codex', model='model; touch /tmp/unsafe', prompt='hello')
    args, cleanup = runner.command(request, 'run', 'test-job')
    assert args[-1] == request.model  # One argv element, never a shell command.
    assert '/var/run/docker.sock' not in ' '.join(args)
    assert 'HOME=/home/user' in args
    if runtime == 'docker':
        assert '--read-only' in args and '--cap-drop=ALL' in args
    else:
        assert 'RootDirectory=/srv/rootfs' in args
        assert 'NoNewPrivileges=yes' in args
    assert cleanup[-1] == 'test-job'
    with pytest.raises(HTTPException):
        runner.settings(runner.Operation(account='b' * 32, provider='codex'))


def test_runner_rejects_arbitrary_provider_and_paths():
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        runner.Operation(account='../../other', provider='bash')
