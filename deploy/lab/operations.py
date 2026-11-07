#!/usr/bin/env python3
"""Host-side Lab automation. No backend endpoint runs these privileged commands."""
import argparse
import contextlib
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import tarfile
import time
import urllib.error
import urllib.request
import uuid

PROJECT = Path(__file__).resolve().parents[2]
CADDY = Path('/etc/caddy/Caddyfile')
OLLAMA_OVERRIDE = Path('/etc/systemd/system/ollama.service.d/90-easypaper.conf')
HTTPS_BACKUPS = Path('/var/backups/easypaper-https')
RUNTIME = Path('/var/lib/easypaper-deployment/docker.json')
MARKER = '# Managed by EasyPaper Lab automation\n'


class OperationError(RuntimeError):
    pass


def run(*args, capture=False, **kwargs):
    """Arguments stay separate; never evaluate user input as a shell program."""
    result = subprocess.run([str(arg) for arg in args], text=True,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None, **kwargs)
    if result.returncode:
        # Captured output may contain configuration/credentials. Do not print it.
        raise OperationError(f'{args[0]} failed (exit {result.returncode}). Check its service logs/configuration.')
    return result.stdout.strip() if capture else ''


def require_host():
    if os.geteuid() != 0:
        raise OperationError('Run this operation with sudo.')
    release = dict(line.strip().split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    if release.get('ID', '').strip('"') != 'ubuntu' or release.get('VERSION_ID', '').strip('"') != '24.04':
        raise OperationError('Supported host: Ubuntu 24.04.')
    if not Path('/run/systemd/system').is_dir():
        raise OperationError('Boot the host with systemd first.')


@contextlib.contextmanager
def operation_lock():
    # Serialize against both application installers as well as other operations.
    with contextlib.ExitStack() as stack:
        for name in ['operations', 'install', 'docker-install']:
            path = Path(f'/run/lock/easypaper-lab-{name}.lock')
            handle = stack.enter_context(path.open('w'))
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise OperationError('Another Lab installer/operation is running.') from exc
        yield


def atomic_write(path, content, mode=0o600):
    path = Path(path)
    if path.is_symlink():
        raise OperationError(f'Refusing symlink: {path}')
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.lab-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def write_json(path, value):
    atomic_write(path, json.dumps(value, indent=2) + '\n')


def validate_model(value):
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._:/-]*', value):
        raise argparse.ArgumentTypeError('Use a model name such as qwen3:4b.')
    return value


def validate_domain(value):
    if len(value) > 253 or not re.fullmatch(r'(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}', value):
        raise argparse.ArgumentTypeError('Use a DNS domain such as lab.example.com.')
    return value.lower()


def http_json(url, payload=None, timeout=10):
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
    # Local health checks must not leak through a configured HTTP proxy.
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=timeout) as response:
        return json.load(response)


def wait_for(check, seconds=180):
    deadline = time.monotonic() + seconds
    while True:
        try:
            return check()
        except (OperationError, OSError, ValueError) as exc:
            if time.monotonic() >= deadline:
                raise OperationError('Timed out waiting for service readiness.') from exc
            time.sleep(3)


def require_local_docker():
    endpoint = os.environ.get('DOCKER_HOST') or run('docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}', capture=True)
    if not endpoint.startswith('unix://'):
        raise OperationError('Use a local Docker daemon; remote Docker contexts are not supported.')
    run('docker', 'info', capture=True)


def docker_config(project):
    require_local_docker()
    project = Path(project).resolve()
    if RUNTIME.exists():
        config = json.loads(RUNTIME.read_text())
        if config.get('x-easypaper-project') != str(project):
            raise OperationError('Another project owns the active Lab Docker deployment.')
        return config
    config = json.loads(run('docker', 'compose', '--project-directory', project,
                            '-f', project / 'docker-compose.lab.yml', 'config', '--format', 'json', capture=True))
    config['x-easypaper-project'] = str(project)
    return config


def container_id(config):
    ids = run('docker', 'ps', '-aq', '--filter', f'label=com.docker.compose.project={config["name"]}',
              '--filter', 'label=com.docker.compose.service=easypaper',
              '--filter', 'label=com.docker.compose.oneoff=False', capture=True).splitlines()
    if len(ids) != 1:
        raise OperationError('Expected one installed EasyPaper container. Run the application installer first.')
    return ids[0]


def inference_address(deployment):
    if deployment == 'systemd':
        return '127.0.0.1'
    require_local_docker()
    host = run('docker', 'network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}', capture=True)
    address = ipaddress.ip_address(host)
    if address.version != 4 or address.is_unspecified or address.is_loopback:
        raise OperationError('Docker bridge must provide a non-loopback IPv4 gateway.')
    return str(address)


def inference_request(deployment, project, route, payload=None):
    if deployment == 'systemd':
        return http_json('http://127.0.0.1:11434' + route, payload, timeout=180 if payload else 10)
    config = docker_config(project)
    code = '''import json,sys,urllib.request
payload=json.loads(sys.argv[2]); data=None if payload is None else json.dumps(payload).encode()
request=urllib.request.Request(sys.argv[1], data=data, headers={'Content-Type':'application/json'})
with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request,timeout=180) as response:
 print(json.dumps(json.load(response)))'''
    return json.loads(run('docker', 'exec', container_id(config), 'python', '-c', code,
                          'http://host.docker.internal:11434' + route, json.dumps(payload), capture=True))


def check_model(deployment, project, model, generate=False):
    tags = inference_request(deployment, project, '/api/tags')
    names = {item.get('name') for item in tags.get('models', [])}
    if model not in names and model + ':latest' not in names:
        raise OperationError(f'Model {model} is missing. Rerun install-inference.sh with --model {model}.')
    if generate:
        result = inference_request(deployment, project, '/api/generate', {
            'model': model, 'prompt': 'Hi', 'stream': False,
            'options': {'num_predict': 1}, 'keep_alive': 0,
        })
        if result.get('error') or result.get('done') is not True:
            raise OperationError('The one-token inference check did not complete.')


def is_active(service):
    try:
        run('systemctl', 'is-active', '--quiet', service, capture=True)
        return True
    except OperationError:
        return False


def install_inference(args):
    host = inference_address(args.deployment)
    # Check the app-side route before altering an existing inference service.
    if args.deployment == 'docker':
        container_id(docker_config(args.project))
    if OLLAMA_OVERRIDE.is_symlink():
        raise OperationError('Ollama override is a symlink; configure it manually.')
    old = OLLAMA_OVERRIDE.read_text() if OLLAMA_OVERRIDE.exists() else None
    if old is not None and not old.startswith(MARKER):
        raise OperationError(f'Existing unmanaged override: {OLLAMA_OVERRIDE}. Preserve/migrate it manually first.')
    if not shutil.which('ollama'):
        run('apt-get', 'update')
        run('apt-get', 'install', '-y', 'curl', 'ca-certificates')
        with tempfile.TemporaryDirectory(prefix='easypaper-ollama-') as directory:
            installer = Path(directory) / 'install.sh'
            run('curl', '--fail', '--show-error', '--location', 'https://ollama.com/install.sh', '-o', installer)
            run('sh', installer)
    was_active = is_active('ollama')
    try:
        atomic_write(OLLAMA_OVERRIDE, MARKER + f'[Service]\nEnvironment="OLLAMA_HOST={host}:11434"\n', 0o644)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'enable', 'ollama')
        run('systemctl', 'restart', 'ollama')
        wait_for(lambda: http_json(f'http://{host}:11434/api/tags'))
        run('ollama', 'pull', args.model, env={**os.environ, 'OLLAMA_HOST': f'http://{host}:11434'})
        check_model(args.deployment, args.project, args.model, generate=True)
    except BaseException:
        if old is None:
            OLLAMA_OVERRIDE.unlink(missing_ok=True)
        else:
            atomic_write(OLLAMA_OVERRIDE, old, 0o644)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'restart' if was_active else 'stop', 'ollama')
        raise
    print(f'Ollama and {args.model} are ready; a one-token request succeeded from the application environment.')


def dns_matches(domain, expected):
    expected = {str(ipaddress.ip_address(value)) for value in expected}
    resolved = {entry[4][0] for entry in socket.getaddrinfo(domain, 443, type=socket.SOCK_STREAM)}
    if not resolved or resolved != expected:
        raise OperationError('DNS A/AAAA records do not match --public-ip values. Correct DNS, including stale AAAA records, and rerun.')


def check_https(domain, token):
    request = urllib.request.Request(f'https://{domain}/')
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=10) as response:
        if response.status != 200 or response.headers.get('X-EasyPaper-Lab') != token:
            raise OperationError('HTTPS responded from a different site or reverse proxy.')


def install_https(args):
    dns_matches(args.domain, args.public_ip)
    check_app()
    if not shutil.which('caddy'):
        run('apt-get', 'update')
        run('apt-get', 'install', '-y', 'caddy')
    if CADDY.is_symlink():
        raise OperationError('Caddyfile is a symlink; configure its imports manually.')
    directory = CADDY.parent / '.easypaper'
    directory.mkdir(mode=0o755, exist_ok=True)
    site = directory / f'{args.domain}.caddy'
    if site.is_symlink():
        raise OperationError('Managed site path is a symlink.')
    original = CADDY.read_text() if CADDY.exists() else ''
    previous = site.read_text() if site.exists() else None
    if previous is not None and not previous.startswith(MARKER):
        raise OperationError('An unmanaged Caddy site already occupies this path.')
    # Reject domains already managed elsewhere, including imported Caddyfiles.
    if previous is None and original.strip():
        adapted = json.loads(run('caddy', 'adapt', '--config', CADDY, '--adapter', 'caddyfile', capture=True))
        def has_host(value):
            if isinstance(value, dict):
                return args.domain in value.get('host', []) or any(has_host(item) for item in value.values())
            return isinstance(value, list) and any(has_host(item) for item in value)
        if has_host(adapted):
            raise OperationError('This domain already has a Caddy route. Keep its existing configuration.')
    token = uuid.uuid4().hex
    content = MARKER + f'{args.domain} {{\n    header X-EasyPaper-Lab "{token}"\n    reverse_proxy 127.0.0.1:8000\n}}\n'
    include = f'import .easypaper/{args.domain}.caddy'
    candidate = original if include in original.splitlines() else original.rstrip() + '\n\n' + include + '\n'
    backup = HTTPS_BACKUPS / uuid.uuid4().hex
    backup.mkdir(mode=0o700, parents=True)
    atomic_write(backup / 'Caddyfile', original)
    if previous is not None:
        atomic_write(backup / 'site.caddy', previous)
    was_active = is_active('caddy')
    try:
        atomic_write(site, content, 0o644)
        # Stage next to the original, so relative imports retain their meaning.
        staged = CADDY.with_name('.easypaper-candidate')
        atomic_write(staged, candidate, 0o644)
        try:
            run('caddy', 'validate', '--config', staged, '--adapter', 'caddyfile', capture=True)
        finally:
            staged.unlink(missing_ok=True)
        atomic_write(CADDY, candidate, 0o644)
        run('systemctl', 'enable', 'caddy')
        run('systemctl', 'reload' if was_active else 'start', 'caddy')
        wait_for(lambda: check_https(args.domain, token))
    except BaseException:
        atomic_write(CADDY, original, 0o644)
        if previous is None:
            site.unlink(missing_ok=True)
        else:
            atomic_write(site, previous, 0o644)
        run('systemctl', 'reload' if was_active else 'stop', 'caddy')
        raise
    print(f'HTTPS is ready: https://{args.domain}. Previous configuration: {backup}')


def check_app():
    schema = http_json('http://127.0.0.1:8000/openapi.json')
    if '/api/lab/inference' not in schema.get('paths', {}):
        raise OperationError('Port 8000 is not serving the expected EasyPaper API.')


def diagnose(args):
    results = []
    def check(name, action, hint):
        try:
            action()
            results.append({'check': name, 'ok': True})
        except (OperationError, OSError, ValueError, KeyError) as exc:
            results.append({'check': name, 'ok': False, 'hint': hint, 'error': str(exc)})
    check('application API', check_app, 'Inspect the EasyPaper service/container logs and port 8000.')
    probe = 'import tempfile; f=tempfile.TemporaryFile(dir="/data"); f.write(b"ok"); f.close()'
    if args.deployment == 'docker':
        def container_check():
            config = docker_config(args.project)
            ident = container_id(config)
            state = json.loads(run('docker', 'inspect', '--format', '{{json .State}}', ident, capture=True))
            if not state.get('Running') or state.get('Health', {}).get('Status') != 'healthy':
                raise OperationError('EasyPaper container is not healthy.')
        def writable():
            run('docker', 'exec', container_id(docker_config(args.project)), 'python', '-c', probe, capture=True)
        check('container', container_check, 'Run docker compose ps; resolve startup errors before rerunning.')
        check('data writable', writable, 'Check LAB_DATA_DIR ownership against LAB_APP_UID:LAB_APP_GID.')
    else:
        check('service', lambda: run('systemctl', 'is-active', '--quiet', 'easypaper-lab.service'), 'Inspect journalctl -u easypaper-lab.service.')
        check('data writable', lambda: run('runuser', '-u', 'easypaper', '--', 'python3', '-c', probe.replace('/data', '/var/lib/easypaper'), capture=True), 'Check ownership of /var/lib/easypaper.')
    def ports():
        if args.deployment == 'docker':
            bindings = json.loads(run('docker', 'inspect', '--format', '{{json .HostConfig.PortBindings}}', container_id(docker_config(args.project)), capture=True))
            published = bindings.get('8000/tcp', [])
            if not published or any(item.get('HostIp') not in ['127.0.0.1', '::1'] or item.get('HostPort') != '8000' for item in published):
                raise OperationError('Docker port 8000 is missing or exposed outside loopback.')
        else:
            listeners = run('ss', '-H', '-ltn', capture=True).splitlines()
            app = [line.split()[3] for line in listeners if len(line.split()) > 3 and line.split()[3].endswith(':8000')]
            if not app or any(value not in ['127.0.0.1:8000', '[::1]:8000', '::1:8000'] for value in app):
                raise OperationError('Port 8000 is missing or exposed outside loopback.')
    check('private application port', ports, 'Resolve port conflicts and bind EasyPaper to 127.0.0.1:8000.')
    if args.model:
        check('inference model', lambda: check_model(args.deployment, args.project, args.model), 'Run install-inference.sh for this deployment/model; check Ollama logs and firewall routing.')
    if args.domain:
        def https():
            # TLS hostname/trust and API identity, without reading account information.
            schema = http_json(f'https://{args.domain}/openapi.json')
            if '/api/lab/inference' not in schema.get('paths', {}):
                raise OperationError('HTTPS is not serving EasyPaper.')
        check('HTTPS', https, 'Check DNS, public ports 80/443, and Caddy logs.')
    if args.json:
        print(json.dumps(results, indent=2))
    else:
        for result in results:
            print(('PASS ' if result['ok'] else 'FAIL ') + result['check'])
            if not result['ok']:
                print('  ' + result['hint'])
    return 0 if all(result['ok'] for result in results) else 1


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    subs = result.add_subparsers(dest='operation', required=True)
    inference = subs.add_parser('inference', help='Install/configure Ollama and test one generated token')
    inference.add_argument('--model', type=validate_model, required=True)
    https = subs.add_parser('https', help='Preserve existing Caddy sites and add this HTTPS domain')
    https.add_argument('--domain', type=validate_domain, required=True)
    https.add_argument('--public-ip', action='append', required=True, type=ipaddress.ip_address,
                       help='Expected public DNS address; repeat for all A/AAAA addresses')
    diagnostic = subs.add_parser('diagnose', help='Check app, data permissions, ports and optional inference/HTTPS')
    diagnostic.add_argument('--model', type=validate_model)
    diagnostic.add_argument('--domain', type=validate_domain)
    diagnostic.add_argument('--json', action='store_true')
    update = subs.add_parser('update', help='Stage a version, back up data, update and automatically recover on failure')
    update.add_argument('--ref', default='origin/main', help='Git revision to deploy from the project repository')
    rollback = subs.add_parser('rollback', help='Restore a saved version AND its data (current data is retained alongside)')
    rollback.add_argument('--snapshot', required=True, help='Snapshot ID printed by update.sh')
    for command in [inference, diagnostic, update, rollback]:
        command.add_argument('--deployment', choices=['docker', 'systemd'], required=True)
        command.add_argument('--project', type=Path, default=PROJECT)
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        require_host()
        with operation_lock():
            if args.operation == 'inference':
                install_inference(args)
            elif args.operation == 'https':
                install_https(args)
            elif args.operation == 'diagnose':
                return diagnose(args)
            else:
                from updates import update, rollback
                (update if args.operation == 'update' else rollback)(args)
        return 0
    except (OperationError, OSError, ValueError, tarfile.TarError) as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    # Keep imports by the update module on the same globals when invoked as a script.
    sys.modules['operations'] = sys.modules[__name__]
    sys.exit(main())
