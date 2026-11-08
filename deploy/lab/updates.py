"""Application update transactions; snapshots include data, never just code."""
import copy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import tarfile
import uuid

import operations as ops

BACKUPS = Path('/var/backups/easypaper')
RELEASES = Path('/opt/easypaper-releases')
STATE = Path('/var/lib/easypaper')
UNIT = Path('/etc/systemd/system/easypaper-lab.service')
OVERRIDE = Path('/etc/systemd/system/easypaper-lab.service.d/90-easypaper-release.conf')


def snapshot_id():
    return datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8]


def archive(directory, destination):
    # The app is stopped before archiving data, including SQLite WAL/SHM files.
    ops.run('tar', '--numeric-owner', '-cpf', destination, '-C', directory, '.')


def restore_directory(archive_path, directory, suffix):
    """Prepare the entire replacement before renaming; keep the displaced data."""
    directory = Path(directory)
    if directory.is_symlink() or directory == Path('/'):
        raise ops.OperationError('Refusing to replace an unsafe data/application path.')
    staging = directory.with_name(directory.name + '.restore-' + suffix)
    retained = directory.with_name(directory.name + '.before-restore-' + suffix)
    if staging.exists() or retained.exists():
        raise ops.OperationError('Restore destination already exists; inspect it before retrying.')
    staging.mkdir(mode=0o700)
    try:
        ops.run('tar', '--numeric-owner', '-xpf', archive_path, '-C', staging)
        if directory.exists():
            directory.rename(retained)
        try:
            staging.rename(directory)
        except BaseException:
            if retained.exists():
                retained.rename(directory)
            raise
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise
    return retained


def compose(config_file, *arguments):
    config = json.loads(Path(config_file).read_text())
    ops.run('docker', 'compose', '-p', config['name'], '-f', config_file, *arguments)


def data_path(config):
    volumes = config['services']['easypaper'].get('volumes', [])
    mounts = [volume for volume in volumes if volume.get('target') == '/data']
    if len(mounts) != 1 or mounts[0].get('type') != 'bind':
        raise ops.OperationError('Updates require one /data bind mount, as installed by install-docker.sh.')
    path = Path(mounts[0]['source'])
    if not path.is_absolute() or path.is_symlink() or not path.is_dir() or path == Path('/'):
        raise ops.OperationError('Invalid/missing Docker data directory.')
    return path


def set_runtime(config):
    ops.RUNTIME.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    ops.write_json(ops.RUNTIME, config)


def require_systemd_install(project):
    # Only manage the supplied unit; avoid silently overriding custom storage/users.
    template = Path(project) / 'deploy/lab/easypaper-lab.service'
    if UNIT.is_symlink() or not UNIT.exists() or UNIT.read_bytes() != template.read_bytes():
        raise ops.OperationError('Update supports the supplied systemd unit only. Preserve custom deployments manually.')
    if OVERRIDE.is_symlink() or (OVERRIDE.exists() and not OVERRIDE.read_text().startswith(ops.MARKER)):
        raise ops.OperationError('An unmanaged service override occupies the release path.')
    dropins = shlex.split(ops.run('systemctl', 'show', 'easypaper-lab.service', '-p', 'DropInPaths', '--value', capture=True))
    if any(Path(path) != OVERRIDE for path in dropins):
        raise ops.OperationError('Custom systemd overrides must be migrated manually before automated updates.')
    active = Path(ops.run('systemctl', 'show', 'easypaper-lab.service', '-p', 'WorkingDirectory', '--value', capture=True)).parent
    if active != Path('/opt/easypaper') and active.parent != RELEASES:
        raise ops.OperationError('Unrecognized running systemd application directory.')
    if not active.is_dir() or active.is_symlink() or STATE.is_symlink() or not STATE.is_dir():
        raise ops.OperationError('Application/data directory is missing or a symlink.')
    ops.run('systemctl', 'is-active', '--quiet', 'easypaper-lab.service')
    return active


def prepare_source(args, snapshot):
    project = args.project.resolve()
    # --end-of-options prevents a revision from being interpreted as a Git option.
    if not args.ref or args.ref.startswith('-') or any(char.isspace() for char in args.ref):
        raise ops.OperationError('Use a Git commit, tag or branch revision for --ref.')
    ops.run('git', '-c', f'safe.directory={project}', '-C', project, 'fetch', 'origin')
    revision = ops.run('git', '-c', f'safe.directory={project}', '-C', project, 'rev-parse', '--verify', '--end-of-options', args.ref + '^{commit}', capture=True)
    if not re.fullmatch('[0-9a-f]{40,64}', revision):
        raise ops.OperationError('Could not resolve the requested commit.')
    source = snapshot / 'source'
    source.mkdir()
    bundle = snapshot / 'source.tar'
    ops.run('git', '-c', f'safe.directory={project}', '-C', project, 'archive', '--format=tar', '-o', bundle, revision)
    # Git archives contain no local .env, credentials, dependencies or lab-data.
    with tarfile.open(bundle) as archive_file:
        archive_file.extractall(source, filter='data')
    for path in ['backend/requirements.txt', 'frontend/package-lock.json', 'Dockerfile']:
        if not (source / path).is_file():
            raise ops.OperationError('Selected revision does not contain a complete EasyPaper application.')
    return source, revision


def prepare_docker(args, snapshot, source, revision):
    current = ops.docker_config(args.project)
    ident = ops.container_id(current)
    running = json.loads(ops.run('docker', 'inspect', ident, capture=True))[0]
    if not running['State']['Running']:
        raise ops.OperationError('Start the existing app before updating.')
    # Resolved config paths must reflect the actual mounted data, not a changed .env.
    path = data_path(current)
    actual = [mount['Source'] for mount in running['Mounts'] if mount['Destination'] == '/data']
    if actual != [str(path)]:
        raise ops.OperationError('Compose data path differs from the running container. Reconcile configuration first.')
    old = copy.deepcopy(current)
    old['services']['easypaper'].pop('build', None)
    old_tag = 'easypaper:rollback-' + snapshot.name
    old['services']['easypaper']['image'] = old_tag
    ops.run('docker', 'tag', running['Image'], old_tag)
    ops.run('docker', 'image', 'save', '-o', snapshot / 'image.tar', old_tag)
    ops.write_json(snapshot / 'previous-compose.json', old)
    next_config = copy.deepcopy(old)
    new_tag = 'easypaper:release-' + revision[:12] + '-' + snapshot.name[-8:]
    next_config['services']['easypaper']['image'] = new_tag
    ops.write_json(snapshot / 'next-compose.json', next_config)
    ops.run('docker', 'build', '-t', new_tag, source)
    return {'deployment': 'docker', 'data': str(path), 'project': str(args.project.resolve()),
            'old_image': running['Image'], 'revision': revision}


def prepare_systemd(args, snapshot, source, revision):
    active = require_systemd_install(args.project)
    release = RELEASES / snapshot.name
    RELEASES.mkdir(mode=0o755, parents=True, exist_ok=True)
    # Build at its final absolute path: virtualenv entrypoints embed this path.
    shutil.copytree(source, release)
    ops.run('python3', '-m', 'venv', release / 'venv')
    ops.run(release / 'venv/bin/pip', 'install', '-r', release / 'backend/requirements.txt')
    ops.run('npm', 'ci', cwd=release / 'frontend')
    ops.run('npm', 'run', 'build', cwd=release / 'frontend')
    archive(active, snapshot / 'application.tar')
    ops.atomic_write(snapshot / 'previous-unit', UNIT.read_text())
    if OVERRIDE.exists():
        ops.atomic_write(snapshot / 'previous-override', OVERRIDE.read_text())
    content = ops.MARKER + f'[Service]\nWorkingDirectory={release}/backend\nExecStart=\nExecStart={release}/venv/bin/python {release}/backend/main.py\n'
    ops.atomic_write(snapshot / 'next-override', content)
    return {'deployment': 'systemd', 'data': str(STATE), 'project': str(args.project.resolve()),
            'application': str(active), 'release': str(release), 'revision': revision}


def stop(snapshot, manifest):
    if manifest['deployment'] == 'docker':
        compose(snapshot / 'previous-compose.json', 'stop', 'easypaper')
    else:
        ops.run('systemctl', 'stop', 'easypaper-lab.service')


def start_previous(snapshot, manifest):
    if manifest['deployment'] == 'docker':
        compose(snapshot / 'previous-compose.json', 'up', '-d', '--no-build', '--force-recreate', '--wait', '--wait-timeout', '180', 'easypaper')
        set_runtime(json.loads((snapshot / 'previous-compose.json').read_text()))
    else:
        ops.run('systemctl', 'daemon-reload')
        ops.run('systemctl', 'start', 'easypaper-lab.service')
        ops.wait_for(ops.check_app)
        ops.run('systemctl', 'is-active', '--quiet', 'easypaper-lab.service')


def apply_next(snapshot, manifest):
    if manifest['deployment'] == 'docker':
        compose(snapshot / 'next-compose.json', 'up', '-d', '--no-build', '--force-recreate', '--wait', '--wait-timeout', '180', 'easypaper')
    else:
        ops.atomic_write(OVERRIDE, (snapshot / 'next-override').read_text(), 0o644)
        ops.run('systemctl', 'daemon-reload')
        ops.run('systemctl', 'start', 'easypaper-lab.service')
        ops.wait_for(ops.check_app)
        ops.run('systemctl', 'is-active', '--quiet', 'easypaper-lab.service')
    ops.check_app()


def restore(snapshot, manifest):
    stop(snapshot, manifest)
    if manifest['deployment'] == 'docker':
        ops.run('docker', 'image', 'load', '-i', snapshot / 'image.tar')
    else:
        restore_directory(snapshot / 'application.tar', manifest['application'], snapshot_id())
        ops.atomic_write(UNIT, (snapshot / 'previous-unit').read_text(), 0o644)
        if (snapshot / 'previous-override').exists():
            ops.atomic_write(OVERRIDE, (snapshot / 'previous-override').read_text(), 0o644)
        else:
            OVERRIDE.unlink(missing_ok=True)
    retained = restore_directory(snapshot / 'data.tar', manifest['data'], snapshot_id())
    start_previous(snapshot, manifest)
    ops.check_app()
    print(f'Restored previous application and data. Displaced data retained at: {retained}')


def update(args):
    # Fail before any downtime for an unsupported deployment or repository.
    ops.check_app()
    if args.deployment == 'systemd':
        require_systemd_install(args.project)
    else:
        data_path(ops.docker_config(args.project))
    BACKUPS.mkdir(mode=0o700, parents=True, exist_ok=True)
    snapshot = BACKUPS / snapshot_id()
    snapshot.mkdir(mode=0o700)
    print(f'Preparing update. Snapshot: {snapshot.name}', flush=True)
    source, revision = prepare_source(args, snapshot)
    prepare = prepare_docker if args.deployment == 'docker' else prepare_systemd
    manifest = prepare(args, snapshot, source, revision)
    manifest['status'] = 'preparing'
    ops.write_json(snapshot / 'manifest.json', manifest)
    stopped = False
    backup_complete = False
    try:
        # Set before stop: even an interrupted stop should try to restart the old app.
        stopped = True
        stop(snapshot, manifest)
        archive(manifest['data'], snapshot / 'data.tar')
        manifest['status'] = 'backed-up'
        ops.write_json(snapshot / 'manifest.json', manifest)
        backup_complete = True
        apply_next(snapshot, manifest)
        if args.deployment == 'docker':
            set_runtime(json.loads((snapshot / 'next-compose.json').read_text()))
        manifest['status'] = 'updated'
        ops.write_json(snapshot / 'manifest.json', manifest)
    except BaseException as error:
        try:
            if backup_complete:
                restore(snapshot, manifest)
                manifest['status'] = 'auto-restored'
                ops.write_json(snapshot / 'manifest.json', manifest)
            elif stopped:
                start_previous(snapshot, manifest)
        except BaseException as recovery:
            raise ops.OperationError(f'Update and recovery failed. Keep snapshot {snapshot}; inspect logs and run rollback.sh --deployment {args.deployment} --snapshot {snapshot.name}.') from recovery
        raise ops.OperationError(f'Update failed; previous service recovered. Snapshot: {snapshot.name}') from error
    print(f'Updated to {revision}. Rollback (restores pre-update data): sudo bash deploy/lab/rollback.sh --deployment {args.deployment} --snapshot {snapshot.name}')


def rollback(args):
    if not re.fullmatch(r'\d{8}T\d{6}Z-[0-9a-f]{8}', args.snapshot):
        raise ops.OperationError('Use the snapshot ID printed by update.sh, not an arbitrary path.')
    snapshot = BACKUPS / args.snapshot
    if snapshot.is_symlink() or not snapshot.is_dir() or snapshot.stat().st_uid != 0 or snapshot.stat().st_mode & 0o077:
        raise ops.OperationError('Snapshot must be a root-owned private directory.')
    manifest = json.loads((snapshot / 'manifest.json').read_text())
    if manifest['deployment'] != args.deployment or manifest['project'] != str(args.project.resolve()):
        raise ops.OperationError('Snapshot belongs to another deployment/project.')
    if manifest['status'] not in ['backed-up', 'updated', 'auto-restored', 'restored']:
        raise ops.OperationError('Snapshot has no complete data backup.')
    required = ['data.tar', 'image.tar', 'previous-compose.json'] if args.deployment == 'docker' else ['data.tar', 'application.tar', 'previous-unit']
    if any(not (snapshot / name).is_file() for name in required):
        raise ops.OperationError('Snapshot is incomplete. No running service has been changed.')
    # Verify archive structure before stopping a currently running service.
    for name in ['data.tar', 'image.tar'] if args.deployment == 'docker' else ['data.tar', 'application.tar']:
        with tarfile.open(snapshot / name) as saved:
            saved.getmembers()
    if args.deployment == 'docker':
        ops.require_local_docker()
    restore(snapshot, manifest)
    manifest['status'] = 'restored'
    ops.write_json(snapshot / 'manifest.json', manifest)
