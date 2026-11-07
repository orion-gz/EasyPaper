"""Run the real installer control flow with package/service commands isolated.

No sudo, package installation, /opt writes, or host service changes are performed.
"""
import os
from pathlib import Path
import shlex
import shutil
import subprocess

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / 'deploy/lab/install-systemd.sh'
pytestmark = pytest.mark.skipif(shutil.which('bash') is None or shutil.which('flock') is None, reason='Requires Bash and flock for the Linux installer')


@pytest.fixture
def installer(tmp_path):
    app = tmp_path / 'app'
    source = tmp_path / 'source'
    (source / 'deploy/lab').mkdir(parents=True)
    (source / 'deploy/lab/easypaper-lab.service').write_text('[Service]\nExecStart=/test/app\n')
    harness = tmp_path / 'run.sh'
    harness.write_text(f'''#!/usr/bin/env bash
source {shlex.quote(str(SCRIPT))}
app_dir={shlex.quote(str(app))}
source_dir={shlex.quote(str(source))}
state_dir={shlex.quote(str(tmp_path / 'data'))}
unit_file={shlex.quote(str(tmp_path / 'unit.service'))}
lock_file={shlex.quote(str(tmp_path / 'install.lock'))}
require_supported_host() {{ :; }}
supported_node() {{ :; }}
apt-get() {{ printf 'apt %s\\n' "$*" >> "$TEST_LOG"; }}
id() {{ return 0; }}
install() {{
  local args=()
  while (($#)); do
    case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac
  done
  command install "${{args[@]}}"
}}
rsync() {{
  mkdir -p "$app_dir/frontend" "$app_dir/backend"
  printf requirements > "$app_dir/backend/requirements.txt"
}}
python3() {{
  mkdir -p "$app_dir/venv/bin"
  printf '#!/bin/sh\\n[ "${{FAIL_STAGE:-}}" != pip ]\\n' > "$app_dir/venv/bin/pip"
  chmod +x "$app_dir/venv/bin/pip"
}}
npm() {{ printf 'npm %s\\n' "$*" >> "$TEST_LOG"; [[ ${{FAIL_STAGE:-}} != npm ]]; }}
systemctl() {{
  printf 'systemctl %s\\n' "$*" >> "$TEST_LOG"
  [[ ${{FAIL_STAGE:-}} != service || $1 != enable ]]
}}
curl() {{ printf 'health\\n' >> "$TEST_LOG"; [[ ${{FAIL_STAGE:-}} != health ]]; }}
journalctl() {{ printf 'journal\\n' >> "$TEST_LOG"; }}
install_systemd
''')

    def run(fail=''):
        return subprocess.run(['bash', str(harness)], capture_output=True, text=True,
                              env={**os.environ, 'FAIL_STAGE': fail, 'TEST_LOG': str(tmp_path / 'log')})
    return run, app, tmp_path


@pytest.mark.parametrize('stage', ['pip', 'npm', 'service', 'health'])
def test_interrupted_install_can_resume_without_losing_data(installer, stage):
    run, app, root = installer
    failed = run(stage)
    assert failed.returncode != 0
    assert (app / '.lab-installing').exists()
    (root / 'data' / 'existing.db').write_text('keep this data')
    resumed = run()
    assert resumed.returncode == 0, resumed.stderr
    assert not (app / '.lab-installing').exists()
    assert (root / 'data' / 'existing.db').read_text() == 'keep this data'
    assert (root / 'unit.service').exists()
    assert 'health' in (root / 'log').read_text()
    assert 'systemctl is-active --quiet easypaper-lab.service' in (root / 'log').read_text()
    if stage == 'health':
        assert 'journal' in (root / 'log').read_text()
        assert 'systemctl stop easypaper-lab.service' in (root / 'log').read_text()


def test_completed_install_is_never_overwritten(installer):
    run, app, root = installer
    assert run().returncode == 0
    (app / 'sentinel').write_text('completed')
    log = (root / 'log').read_text()
    result = run()
    assert result.returncode != 0
    assert 'refusing to overwrite' in result.stderr
    assert (app / 'sentinel').read_text() == 'completed'
    assert (root / 'log').read_text() == log


@pytest.mark.parametrize('existing', ['directory', 'unit', 'changed_unit', 'symlink'])
def test_unmanaged_installations_and_units_are_protected(installer, existing):
    run, app, root = installer
    if existing == 'directory':
        app.mkdir()
    elif existing == 'symlink':
        target = root / 'unmanaged'
        target.mkdir()
        (target / '.lab-installing').touch()
        app.symlink_to(target)
    else:
        (root / 'unit.service').write_text('unrelated service')
        if existing == 'changed_unit':
            app.mkdir()
            (app / '.lab-installing').touch()
    result = run()
    assert result.returncode != 0
    assert 'refusing to overwrite' in result.stderr
    assert not (root / 'log').exists()


@pytest.mark.parametrize('version,accepted', [('20.19.0', False), ('22.0.0', False), ('22.11.0', False), ('22.12.0', False), ('22.13.0', True), ('24.0.0', True)])
def test_node_version_gate_executes_real_version_expression(tmp_path, version, accepted):
    node = shutil.which('node')
    if not node:
        pytest.skip('Node is needed to evaluate the installer version expression')
    wrapper = tmp_path / 'node'
    # Execute the actual JS supplied by supported_node(), with a synthetic version.
    wrapper.write_text('#!/bin/sh\nexec ' + shlex.quote(node) + ' -e ' +
                       shlex.quote(f"Object.defineProperty(process.versions, 'node', {{value: '{version}'}}); eval(process.argv[1])") + ' "$2"\n')
    wrapper.chmod(0o755)
    npm = tmp_path / 'npm'
    npm.write_text('#!/bin/sh\nexit 0\n')
    npm.chmod(0o755)
    result = subprocess.run(['bash', '-c', f'source {shlex.quote(str(SCRIPT))}; supported_node'],
                            env={**os.environ, 'PATH': str(tmp_path) + ':' + os.environ['PATH']}, capture_output=True)
    assert (result.returncode == 0) == accepted


def test_concurrent_install_is_rejected_before_mutation(installer):
    import fcntl
    run, app, root = installer
    with (root / 'install.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = run()
    assert result.returncode != 0
    assert 'Another EasyPaper installation is running' in result.stderr
    assert not app.exists()
    assert not (root / 'log').exists()
