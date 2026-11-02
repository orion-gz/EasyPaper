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


def test_automatic_accounts_are_persistent_unique_and_private(tmp_path, monkeypatch):
    monkeypatch.setattr(runner.os, 'chown', lambda *args: None)
    config = {'provisioning': {'enabled': True, 'directory': str(tmp_path / 'homes'), 'uid_start': 20000, 'uid_end': 20002},
              'accounts': {'manual': {'uid': 20000}}}
    monkeypatch.setattr(runner.pwd, 'getpwall', lambda: [])
    alice = runner.provision_account(config, 'a' * 32)
    bob = runner.provision_account(config, 'b' * 32)
    assert alice['uid'] == 20001 and bob['uid'] == 20002
    assert runner.provision_account(config, 'a' * 32) == alice
    assert Path(alice['home']).stat().st_mode & 0o777 == 0o700
    assert Path(alice['home']).parent.stat().st_mode & 0o777 == 0o700
    with pytest.raises(HTTPException, match='exhausted'):
        runner.provision_account(config, 'c' * 32)


def test_provisioning_rejects_symlink_home_and_shared_root(tmp_path, monkeypatch):
    monkeypatch.setattr(runner.os, 'chown', lambda *args: None)
    monkeypatch.setattr(runner.pwd, 'getpwall', lambda: [])
    root = tmp_path / 'homes'
    root.mkdir(mode=0o700)
    config = {'provisioning': {'enabled': True, 'directory': str(root), 'uid_start': 20000, 'uid_end': 20002}}
    (root / ('a' * 32)).symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(HTTPException, match='Unsafe'):
        runner.provision_account(config, 'a' * 32)
    root.chmod(0o755)
    with pytest.raises(HTTPException, match='0700'):
        runner.provision_account(config, 'b' * 32)


@pytest.mark.asyncio
async def test_failed_logout_is_not_reported_as_disconnected(monkeypatch):
    monkeypatch.setattr(runner, 'settings', lambda data: ({}, {}, {'logout': ['cli', 'logout']}))
    async def execute(*args):
        return 1
    monkeypatch.setattr(runner, 'execute', execute)
    runner.locks.clear()
    result = await runner.provider(runner.Operation(account='d' * 32, provider='codex', action='logout'))
    assert result['status'] == 'failed'
