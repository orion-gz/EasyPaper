"""Lab host operations use real temporary files and mocked external services."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
from types import SimpleNamespace

import pytest

LAB = Path(__file__).resolve().parents[2] / 'deploy/lab'
spec = importlib.util.spec_from_file_location('operations', LAB / 'operations.py')
ops = importlib.util.module_from_spec(spec)
sys.modules['operations'] = ops
spec.loader.exec_module(ops)
spec = importlib.util.spec_from_file_location('lab_updates', LAB / 'updates.py')
updates = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updates)


@pytest.fixture
def host(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(ops, 'CADDY', tmp_path / 'caddy/Caddyfile')
    monkeypatch.setattr(ops, 'HTTPS_BACKUPS', tmp_path / 'https-backups')
    monkeypatch.setattr(ops, 'OLLAMA_OVERRIDE', tmp_path / 'ollama/90-easypaper.conf')
    monkeypatch.setattr(ops, 'RUNTIME', tmp_path / 'runtime/docker.json')
    monkeypatch.setattr(ops, 'check_app', lambda: None)
    monkeypatch.setattr(ops, 'is_active', lambda name: True)
    monkeypatch.setattr(ops.shutil, 'which', lambda name: '/usr/bin/' + name)
    monkeypatch.setattr(ops, 'dns_matches', lambda *args: None)
    monkeypatch.setattr(ops, 'check_https', lambda *args: None)
    monkeypatch.setattr(ops, 'wait_for', lambda check, **kwargs: check())
    def run(*args, **kwargs):
        calls.append(tuple(str(value) for value in args))
        if args[:2] == ('caddy', 'adapt'):
            return '{}'
        return ''
    monkeypatch.setattr(ops, 'run', run)
    return calls


def https_args():
    return SimpleNamespace(domain='lab.example.com', public_ip=['203.0.113.10'])


def test_https_preserves_existing_site_and_imports_once(host):
    ops.CADDY.parent.mkdir()
    original = 'other.example.com {\n reverse_proxy localhost:9000\n}\n'
    ops.CADDY.write_text(original)
    ops.install_https(https_args())
    ops.install_https(https_args())
    contents = ops.CADDY.read_text()
    assert contents.startswith(original.rstrip())
    assert contents.count('import .easypaper/lab.example.com.caddy') == 1
    site = ops.CADDY.parent / '.easypaper/lab.example.com.caddy'
    assert 'reverse_proxy 127.0.0.1:8000' in site.read_text()
    assert list(ops.HTTPS_BACKUPS.glob('*/Caddyfile'))
    commands = [' '.join(call) for call in host]
    assert any('caddy validate' in command for command in commands)
    assert any('systemctl reload caddy' in command for command in commands)


@pytest.mark.parametrize('stage', ['validation', 'certificate'])
def test_https_failure_restores_original_config_and_site(host, monkeypatch, stage):
    ops.CADDY.parent.mkdir()
    original = 'other.example.com { respond "keep" }\n'
    ops.CADDY.write_text(original)
    def fail(*args, **kwargs):
        raise ops.OperationError('injected')
    if stage == 'certificate':
        monkeypatch.setattr(ops, 'check_https', fail)
    else:
        original_run = ops.run
        def run(*args, **kwargs):
            if args[:2] == ('caddy', 'validate'):
                return fail()
            return original_run(*args, **kwargs)
        monkeypatch.setattr(ops, 'run', run)
    with pytest.raises(ops.OperationError):
        ops.install_https(https_args())
    assert ops.CADDY.read_text() == original
    assert not (ops.CADDY.parent / '.easypaper/lab.example.com.caddy').exists()
    assert host[-1] == ('systemctl', 'reload', 'caddy')


def test_https_rejects_existing_domain_before_modification(host, monkeypatch):
    ops.CADDY.parent.mkdir()
    ops.CADDY.write_text('import existing-sites/*\n')
    original_run = ops.run
    monkeypatch.setattr(ops, 'run', lambda *args, **kwargs: '{"host":["lab.example.com"]}' if args[:2] == ('caddy', 'adapt') else original_run(*args, **kwargs))
    with pytest.raises(ops.OperationError, match='already has a Caddy route'):
        ops.install_https(https_args())
    assert ops.CADDY.read_text() == 'import existing-sites/*\n'


def test_dns_requires_all_addresses_including_ipv6(monkeypatch):
    monkeypatch.setattr(socket, 'getaddrinfo', lambda *args, **kwargs: [
        (None, None, None, None, ('203.0.113.10', 443)),
        (None, None, None, None, ('2001:db8::1', 443)),
    ])
    with pytest.raises(ops.OperationError, match='A/AAAA'):
        ops.dns_matches('lab.example.com', ['203.0.113.10'])
    ops.dns_matches('lab.example.com', ['203.0.113.10', '2001:db8::1'])


@pytest.mark.parametrize('model', ['', '-option', 'qwen3;id', '$(id)', 'name model'])
def test_model_names_reject_shell_expressions(model):
    with pytest.raises(argparse.ArgumentTypeError):
        ops.validate_model(model)


@pytest.mark.parametrize('domain', ['--option', 'example.com;id', '*.example.com', 'host', '../site'])
def test_domains_reject_paths_and_shell_expressions(domain):
    with pytest.raises(argparse.ArgumentTypeError):
        ops.validate_domain(domain)


@pytest.mark.parametrize('deployment,address', [('docker', '172.17.0.1'), ('systemd', '127.0.0.1')])
def test_inference_sets_private_address_pulls_and_tests_from_app(host, monkeypatch, deployment, address):
    monkeypatch.setattr(ops, 'inference_address', lambda value: address)
    monkeypatch.setattr(ops, 'docker_config', lambda project: {})
    monkeypatch.setattr(ops, 'container_id', lambda config: 'container')
    monkeypatch.setattr(ops, 'http_json', lambda *args, **kwargs: {'models': []})
    checked = []
    monkeypatch.setattr(ops, 'check_model', lambda *args, **kwargs: checked.append((args, kwargs)))
    args = SimpleNamespace(deployment=deployment, project=Path('/project'), model='qwen3:4b')
    ops.install_inference(args)
    assert f'OLLAMA_HOST={address}:11434' in ops.OLLAMA_OVERRIDE.read_text()
    assert ('ollama', 'pull', 'qwen3:4b') in host
    assert checked == [((deployment, Path('/project'), 'qwen3:4b'), {'generate': True})]


def test_inference_failed_model_restores_managed_override(host, monkeypatch):
    ops.OLLAMA_OVERRIDE.parent.mkdir()
    original = ops.MARKER + '[Service]\nEnvironment="OLLAMA_HOST=127.0.0.1:11434"\n'
    ops.OLLAMA_OVERRIDE.write_text(original)
    monkeypatch.setattr(ops, 'http_json', lambda *args, **kwargs: {})
    def fail(*args, **kwargs):
        raise ops.OperationError('model unavailable')
    monkeypatch.setattr(ops, 'check_model', fail)
    with pytest.raises(ops.OperationError):
        ops.install_inference(SimpleNamespace(deployment='systemd', project=Path('/project'), model='missing'))
    assert ops.OLLAMA_OVERRIDE.read_text() == original
    assert host[-1] == ('systemctl', 'restart', 'ollama')


def test_inference_preserves_unmanaged_override(host):
    ops.OLLAMA_OVERRIDE.parent.mkdir()
    ops.OLLAMA_OVERRIDE.write_text('custom service settings')
    with pytest.raises(ops.OperationError, match='unmanaged'):
        ops.install_inference(SimpleNamespace(deployment='systemd', project=Path('/project'), model='qwen3:4b'))
    assert ops.OLLAMA_OVERRIDE.read_text() == 'custom service settings'
    assert host == []


def test_one_token_generation_checks_done_and_never_prints_response(monkeypatch, capsys):
    requests = []
    def request(*args):
        requests.append(args)
        return {'models': [{'name': 'qwen3:4b'}]} if args[2] == '/api/tags' else {'done': True, 'response': 'private result'}
    monkeypatch.setattr(ops, 'inference_request', request)
    ops.check_model('docker', '/project', 'qwen3:4b', generate=True)
    assert requests[-1][-1]['options']['num_predict'] == 1
    assert capsys.readouterr().out == ''


def test_diagnostics_aggregate_failures_and_provide_hints(host, monkeypatch, capsys):
    def fail():
        raise ops.OperationError('connection refused')
    monkeypatch.setattr(ops, 'check_app', fail)
    result = ops.diagnose(SimpleNamespace(deployment='systemd', project=Path('/project'), model=None, domain=None, json=True))
    assert result == 1
    checks = json.loads(capsys.readouterr().out)
    assert len(checks) == 4
    assert checks[0]['ok'] is False and 'logs' in checks[0]['hint']
    assert any(check['check'] == 'data writable' for check in checks)


def test_docker_diagnostics_use_published_bindings_not_host_ss(host, monkeypatch, capsys):
    monkeypatch.setattr(ops, 'docker_config', lambda project: {})
    monkeypatch.setattr(ops, 'container_id', lambda config: 'id')
    def run(*args, **kwargs):
        assert args[0] != 'ss'
        if '{{json .State}}' in args:
            return '{"Running":true,"Health":{"Status":"healthy"}}'
        if '{{json .HostConfig.PortBindings}}' in args:
            return '{"8000/tcp":[{"HostIp":"127.0.0.1","HostPort":"8000"}]}'
        return ''
    monkeypatch.setattr(ops, 'run', run)
    assert ops.diagnose(SimpleNamespace(deployment='docker', project=Path('/project'), model=None, domain=None, json=False)) == 0


def test_real_archive_restore_retains_newer_data(tmp_path):
    data = tmp_path / 'data'
    data.mkdir()
    (data / 'database').write_text('old')
    archive = tmp_path / 'data.tar'
    updates.archive(data, archive)
    (data / 'database').write_text('new')
    retained = updates.restore_directory(archive, data, 'test')
    assert (data / 'database').read_text() == 'old'
    assert (retained / 'database').read_text() == 'new'


def test_failed_extract_leaves_live_data_untouched(tmp_path):
    data = tmp_path / 'data'
    data.mkdir()
    (data / 'database').write_text('current')
    invalid = tmp_path / 'broken.tar'
    invalid.write_text('broken')
    with pytest.raises(ops.OperationError):
        updates.restore_directory(invalid, data, 'test')
    assert (data / 'database').read_text() == 'current'
    assert not (tmp_path / 'data.restore-test').exists()


@pytest.fixture
def transaction(tmp_path, monkeypatch):
    calls = []
    data = tmp_path / 'data'
    data.mkdir()
    (data / 'database').write_text('old')
    monkeypatch.setattr(updates, 'BACKUPS', tmp_path / 'backups')
    monkeypatch.setattr(ops, 'check_app', lambda: None)
    monkeypatch.setattr(ops, 'docker_config', lambda project: {})
    monkeypatch.setattr(updates, 'data_path', lambda config: data)
    monkeypatch.setattr(updates, 'require_systemd_install', lambda project: tmp_path / 'app')
    monkeypatch.setattr(updates, 'prepare_source', lambda args, snapshot: (tmp_path, 'a' * 40))
    def prepare(args, snapshot, source, revision):
        (snapshot / 'next-compose.json').write_text('{}')
        return {'deployment': args.deployment, 'project': str(tmp_path), 'data': str(data), 'revision': revision}
    monkeypatch.setattr(updates, 'prepare_docker', prepare)
    monkeypatch.setattr(updates, 'prepare_systemd', prepare)
    monkeypatch.setattr(updates, 'stop', lambda *args: calls.append('stop'))
    monkeypatch.setattr(updates, 'start_previous', lambda *args: calls.append('restart old'))
    monkeypatch.setattr(updates, 'set_runtime', lambda *args: calls.append('runtime'))
    def restore(snapshot, manifest):
        calls.append('restore')
        updates.restore_directory(snapshot / 'data.tar', data, 'auto')
    monkeypatch.setattr(updates, 'restore', restore)
    return calls, data


@pytest.mark.parametrize('deployment', ['docker', 'systemd'])
def test_update_failure_restores_consistent_data_snapshot(transaction, monkeypatch, tmp_path, deployment):
    calls, data = transaction
    def fail(snapshot, manifest):
        calls.append('start new')
        (data / 'database').write_text('migrated')
        raise ops.OperationError('health failure')
    monkeypatch.setattr(updates, 'apply_next', fail)
    with pytest.raises(ops.OperationError, match='previous service recovered'):
        updates.update(SimpleNamespace(deployment=deployment, project=tmp_path, ref='origin/main'))
    assert calls == ['stop', 'start new', 'restore']
    assert (data / 'database').read_text() == 'old'
    assert (tmp_path / 'data.before-restore-auto/database').read_text() == 'migrated'
    manifest = json.loads(next((tmp_path / 'backups').glob('*/manifest.json')).read_text())
    assert manifest['status'] == 'auto-restored'


@pytest.mark.parametrize('deployment', ['docker', 'systemd'])
def test_successful_update_saves_recovery_id(transaction, monkeypatch, tmp_path, capsys, deployment):
    calls, data = transaction
    monkeypatch.setattr(updates, 'apply_next', lambda *args: calls.append('start new'))
    updates.update(SimpleNamespace(deployment=deployment, project=tmp_path, ref='origin/main'))
    snapshot = next((tmp_path / 'backups').iterdir())
    assert snapshot.stat().st_mode & 0o077 == 0
    assert json.loads((snapshot / 'manifest.json').read_text())['status'] == 'updated'
    assert 'rollback.sh' in capsys.readouterr().out
    assert calls[:2] == ['stop', 'start new']
    assert 'restore' not in calls


def test_backup_failure_restarts_original_without_restoring_incomplete_archive(transaction, monkeypatch, tmp_path):
    calls, data = transaction
    def fail(*args):
        raise ops.OperationError('disk full')
    monkeypatch.setattr(updates, 'archive', fail)
    with pytest.raises(ops.OperationError, match='previous service recovered'):
        updates.update(SimpleNamespace(deployment='systemd', project=tmp_path, ref='origin/main'))
    assert calls == ['stop', 'restart old']
    assert (data / 'database').read_text() == 'old'


def test_build_failure_never_stops_running_service(transaction, monkeypatch, tmp_path):
    calls, data = transaction
    def fail(*args):
        raise ops.OperationError('build failed')
    monkeypatch.setattr(updates, 'prepare_systemd', fail)
    with pytest.raises(ops.OperationError, match='build failed'):
        updates.update(SimpleNamespace(deployment='systemd', project=tmp_path, ref='origin/main'))
    assert calls == []


def test_failed_recovery_reports_retained_snapshot(transaction, monkeypatch, tmp_path):
    def fail(*args):
        raise ops.OperationError('failed')
    monkeypatch.setattr(updates, 'apply_next', fail)
    monkeypatch.setattr(updates, 'restore', fail)
    with pytest.raises(ops.OperationError, match='Update and recovery failed.*rollback.sh'):
        updates.update(SimpleNamespace(deployment='docker', project=tmp_path, ref='origin/main'))
    assert next((tmp_path / 'backups').glob('*/data.tar')).exists()


@pytest.mark.parametrize('snapshot', ['../../etc', '/tmp/backup', 'bad;id'])
def test_manual_rollback_rejects_untrusted_paths(snapshot):
    with pytest.raises(ops.OperationError, match='snapshot ID'):
        updates.rollback(SimpleNamespace(snapshot=snapshot, deployment='docker', project=Path('/project')))


def test_docker_restore_forces_container_recreation_for_new_data_inode(tmp_path, monkeypatch):
    config = {'name': 'lab', 'x-easypaper-project': '/project', 'services': {'easypaper': {'image': 'previous'}}}
    (tmp_path / 'previous-compose.json').write_text(json.dumps(config))
    calls = []
    monkeypatch.setattr(ops, 'run', lambda *args, **kwargs: calls.append(args))
    monkeypatch.setattr(updates, 'set_runtime', lambda value: None)
    updates.start_previous(tmp_path, {'deployment': 'docker'})
    assert '--force-recreate' in calls[0]
    assert '--no-build' in calls[0]


def test_docker_preparation_saves_actual_image_and_rejects_changed_data_path(tmp_path, monkeypatch):
    data = tmp_path / 'data'
    data.mkdir()
    config = {'name': 'lab', 'x-easypaper-project': str(tmp_path), 'services': {'easypaper': {
        'image': 'easypaper:lab', 'build': {'context': str(tmp_path)},
        'volumes': [{'type': 'bind', 'source': str(data), 'target': '/data'}],
    }}}
    calls = []
    running = {'Image': 'sha256:actual-running-image', 'State': {'Running': True},
               'Mounts': [{'Source': str(data), 'Destination': '/data'}]}
    monkeypatch.setattr(ops, 'docker_config', lambda project: config)
    monkeypatch.setattr(ops, 'container_id', lambda value: 'container')
    def run(*args, **kwargs):
        calls.append(args)
        return json.dumps([running]) if args[:2] == ('docker', 'inspect') else ''
    monkeypatch.setattr(ops, 'run', run)
    args = SimpleNamespace(project=tmp_path)
    result = updates.prepare_docker(args, tmp_path, tmp_path, 'a' * 40)
    previous = json.loads((tmp_path / 'previous-compose.json').read_text())
    assert 'build' not in previous['services']['easypaper']
    assert result['old_image'] == running['Image']
    assert any(call[:3] == ('docker', 'tag', running['Image']) for call in calls)
    assert any(call[:3] == ('docker', 'image', 'save') for call in calls)
    running['Mounts'][0]['Source'] = '/other/data'
    calls.clear()
    with pytest.raises(ops.OperationError, match='differs'):
        updates.prepare_docker(args, tmp_path, tmp_path, 'b' * 40)
    assert not any(call[:2] == ('docker', 'build') for call in calls)


def test_systemd_restore_restores_code_unit_and_data_before_restart(tmp_path, monkeypatch):
    application, data, snapshot = [tmp_path / name for name in ['app', 'data', 'snapshot']]
    for directory in [application, data, snapshot]:
        directory.mkdir()
    (application / 'version').write_text('old-code')
    (data / 'database').write_text('old-data')
    updates.archive(application, snapshot / 'application.tar')
    updates.archive(data, snapshot / 'data.tar')
    (application / 'version').write_text('new-code')
    (data / 'database').write_text('new-data')
    (snapshot / 'previous-unit').write_text('old-unit')
    (snapshot / 'previous-override').write_text(ops.MARKER + 'old-release')
    monkeypatch.setattr(updates, 'UNIT', tmp_path / 'unit')
    monkeypatch.setattr(updates, 'OVERRIDE', tmp_path / 'override')
    calls = []
    monkeypatch.setattr(updates, 'stop', lambda *args: calls.append('stop'))
    def start(*args):
        assert (application / 'version').read_text() == 'old-code'
        assert (data / 'database').read_text() == 'old-data'
        assert updates.UNIT.read_text() == 'old-unit'
        assert updates.OVERRIDE.read_text() == ops.MARKER + 'old-release'
        calls.append('start')
    monkeypatch.setattr(updates, 'start_previous', start)
    monkeypatch.setattr(ops, 'check_app', lambda: None)
    updates.restore(snapshot, {'deployment': 'systemd', 'application': str(application), 'data': str(data)})
    assert calls == ['stop', 'start']
    assert next(tmp_path.glob('data.before-restore-*/database')).read_text() == 'new-data'


def test_manual_rollback_preflights_incomplete_snapshot_before_stopping(tmp_path, monkeypatch):
    monkeypatch.setattr(updates, 'BACKUPS', tmp_path)
    snapshot = tmp_path / '20261107T120000Z-0123abcd'
    snapshot.mkdir(mode=0o700)
    (snapshot / 'manifest.json').write_text(json.dumps({'deployment': 'systemd', 'project': str(tmp_path), 'status': 'updated'}))
    original_stat = Path.stat
    def stat(path, *args, **kwargs):
        result = original_stat(path, *args, **kwargs)
        if path == snapshot:
            fields = list(result)
            fields[4] = 0
            return os.stat_result(fields)
        return result
    monkeypatch.setattr(Path, 'stat', stat)
    monkeypatch.setattr(updates, 'restore', lambda *args: pytest.fail('must not stop service'))
    with pytest.raises(ops.OperationError, match='incomplete'):
        updates.rollback(SimpleNamespace(snapshot=snapshot.name, deployment='systemd', project=tmp_path))


def test_explicit_git_revision_cannot_be_an_option(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(ops, 'run', lambda *args, **kwargs: calls.append(args))
    with pytest.raises(ops.OperationError, match='Git commit'):
        updates.prepare_source(SimpleNamespace(project=tmp_path, ref='--upload-pack=evil'), tmp_path)
    assert calls == []
