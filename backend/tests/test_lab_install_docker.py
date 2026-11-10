"""Exercise deployment control flow without installing packages or using Docker."""
import os
from pathlib import Path
import shlex
import subprocess

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / 'deploy/lab/install-docker.sh'


@pytest.fixture
def installer(tmp_path):
    harness = tmp_path / 'run.sh'
    harness.write_text(f'''#!/usr/bin/env bash
source {shlex.quote(str(SCRIPT))}
source_dir={shlex.quote(str(tmp_path))}
lock_file="$source_dir/install.lock"
require_supported_host() {{ :; }}
command() {{
  if [[ $* == '-v docker' ]]; then [[ $DOCKER_PRESENT == yes ]]; else builtin command "$@"; fi
}}
apt-get() {{
  echo "apt-get $*" >> "$TEST_LOG"
  [[ $FAIL_STAGE != apt ]] || return 42
  if [[ $* == *docker.io* ]]; then DOCKER_PRESENT=yes; fi
}}
systemctl() {{ echo "systemctl $*" >> "$TEST_LOG"; }}
docker() {{
  printf '%s\\n' "$*" >> "$TEST_LOG"
  case " $* " in
    *' config '*) printf '{{"services":{{"easypaper":{{"user":"%s"}}}}}}\\n' "$APP_USER" ;;
  esac
  case "$FAIL_STAGE" in
    compose) [[ $* != 'compose version' ]] || return 42 ;;
    daemon) [[ $* != info ]] || return 42 ;;
    build|run|up) [[ " $* " != *" $FAIL_STAGE "* ]] || return 42 ;;
  esac
  return 0
}}
install_docker
''')

    def run(present='yes', fail='', user='1234:5678'):
        return subprocess.run(['bash', str(harness)], cwd='/', capture_output=True, text=True,
                              env={**os.environ, 'DOCKER_PRESENT': present, 'FAIL_STAGE': fail,
                                   'APP_USER': user, 'TEST_LOG': str(tmp_path / 'log')})
    return run, tmp_path


def test_fresh_install_includes_docker_and_waits_for_health(installer):
    run, root = installer
    result = run(present='no')
    assert result.returncode == 0, result.stderr
    log = (root / 'log').read_text()
    assert 'apt-get install -y docker.io docker-compose-v2' in log
    assert 'systemctl enable --now docker' in log
    assert f'-f {root}/docker-compose.lab.yml' in log
    assert '--user 0:0 --cap-add CHOWN --cap-add DAC_OVERRIDE' in log
    assert 'sh 1234:5678' in log
    assert log.index(' build ') < log.index(' run ') < log.index(' up ')
    assert 'up -d --wait --wait-timeout 180 easypaper' in log


def test_existing_docker_is_reused_and_data_is_not_deleted(installer):
    run, root = installer
    data = root / 'lab-data'
    data.mkdir()
    (data / 'existing.db').write_text('keep')
    for _ in range(2):
        result = run()
        assert result.returncode == 0, result.stderr
    log = (root / 'log').read_text()
    assert 'docker.io' not in log
    assert 'systemctl' not in log
    assert 'chown -R' not in log
    assert 'down' not in log
    assert (data / 'existing.db').read_text() == 'keep'


@pytest.mark.parametrize('stage', ['compose', 'daemon'])
def test_partial_existing_docker_stops_before_package_changes(installer, stage):
    run, root = installer
    result = run(fail=stage)
    assert result.returncode != 0
    log = (root / 'log').read_text()
    assert 'apt-get' not in log
    assert ' build ' not in log


@pytest.mark.parametrize('stage', ['apt', 'build', 'run', 'up'])
def test_failures_do_not_report_success_or_proceed(installer, stage):
    run, root = installer
    result = run(fail=stage)
    assert result.returncode != 0
    assert 'EasyPaper is ready' not in result.stdout
    log = (root / 'log').read_text()
    if stage in ['apt', 'build']:
        assert ' run ' not in log
    if stage != 'up':
        assert ' up ' not in log


@pytest.mark.parametrize('user', ['0:1000', '1000:0', 'user:group', '1:2;id'])
def test_invalid_owner_stops_before_build(installer, user):
    run, root = installer
    result = run(user=user)
    assert result.returncode != 0
    assert ' build ' not in (root / 'log').read_text()


def test_concurrent_install_stops_before_mutation(installer):
    import fcntl
    run, root = installer
    with (root / 'install.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = run()
    assert result.returncode != 0
    assert not (root / 'log').exists()


@pytest.mark.parametrize('args,expected', [([], None), (['unknown'], None),
                                         (['docker', 'extra'], None),
                                         (['docker'], 'docker'), (['systemd'], 'systemd')])
def test_dispatcher_requires_explicit_environment(tmp_path, args, expected):
    dispatcher = tmp_path / 'install.sh'
    dispatcher.write_text(SCRIPT.with_name('install.sh').read_text())
    for deployment in ['docker', 'systemd']:
        (tmp_path / f'install-{deployment}.sh').write_text(f'echo {deployment}\n')
    result = subprocess.run(['bash', str(dispatcher), *args], cwd='/', capture_output=True, text=True)
    assert result.returncode == (0 if expected else 2)
    assert result.stdout.strip() == (expected or '')
