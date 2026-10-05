#!/usr/bin/env python3
"""Build an RPM from Tauri's DEB payload using the system RPM packager."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


root = Path.cwd()
config = json.loads((root / 'src-tauri/tauri.conf.json').read_text())
version = config['version']
product = config['productName']
name = re.sub(r'([a-z0-9])([A-Z])', r'\1-\2', product).lower()
assert re.fullmatch(r'[A-Za-z0-9_.-]+', product)
assert re.fullmatch(r'\d+\.\d+\.\d+', version)
debs = list((root / 'src-tauri/target/release/bundle/deb').glob('*.deb'))
assert len(debs) == 1, 'Expected one Tauri DEB'
arch = subprocess.check_output(['dpkg-deb', '--field', str(debs[0]), 'Architecture'], text=True).strip()
assert arch == 'amd64', f'Unsupported architecture: {arch}'

# Tauri embeds the installed bundle type in the executable for its updater.
# Let the CLI patch the executable for RPM, then stop its slow RPM builder.
process = subprocess.Popen(
    ['npm', 'run', 'tauri', '--', 'bundle', '--bundles', 'rpm'],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    start_new_session=True,
)
try:
    assert process.stdout is not None
    for line in process.stdout:
        print(line, end='', flush=True)
        if 'Bundling ' in line and '.rpm' in line:
            break
    else:
        raise RuntimeError('Tauri did not reach RPM packaging')
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()

with tempfile.TemporaryDirectory(prefix='easypaper-rpm-', dir=os.environ.get('RUNNER_TEMP')) as directory:
    temporary = Path(directory)
    payload = temporary / 'payload'
    payload.mkdir()
    run('dpkg-deb', '--extract', str(debs[0]), str(payload))
    binaries = list((payload / 'usr/bin').iterdir())
    assert len(binaries) == 1 and binaries[0].is_file(), 'Expected one app executable'
    compiled = root / 'src-tauri/target/release/app'
    assert compiled.is_file(), 'Missing RPM-patched app executable'
    shutil.copyfile(compiled, binaries[0])

    entries = sorted(p for p in payload.rglob('*') if p.is_file() or p.is_symlink())
    manifest = []
    for entry in entries:
        target = '/' + entry.relative_to(payload).as_posix()
        assert '\n' not in target and '"' not in target
        manifest.append('"' + target.replace('%', '%%') + '"')
    manifest.insert(0, '%dir /usr/lib/' + product)
    for folder in sorted((payload / 'usr/lib' / product).rglob('*')):
        if folder.is_dir() and not folder.is_symlink():
            target = '/' + folder.relative_to(payload).as_posix()
            manifest.append('%dir "' + target.replace('%', '%%') + '"')

    top = temporary / 'rpmbuild'
    for folder in ['BUILD', 'BUILDROOT', 'RPMS', 'SOURCES', 'SPECS', 'SRPMS']:
        (top / folder).mkdir(parents=True, exist_ok=True)
    spec = top / 'SPECS/app.spec'
    spec.write_text(f'''Name: {name}
Version: {version}
Release: 1
Summary: {product} desktop
License: Unspecified
BuildArch: x86_64
AutoReqProv: no

%description
{product} desktop application.

%install
mkdir -p "%{{buildroot}}"
cp -a "{payload}/." "%{{buildroot}}/"

%files
%defattr(-,root,root,-)
''' + '\n'.join(manifest) + '\n')
    run('rpmbuild', '-bb', '--define', f'_topdir {top}',
        '--define', '_binary_payload w3.zstdio',
        '--define', '_build_id_links none',
        '--define', '__os_install_post %{nil}', str(spec))
    packages = list((top / 'RPMS').rglob('*.rpm'))
    assert len(packages) == 1, 'Expected one RPM'
    rpm = packages[0]
    metadata = subprocess.check_output(['rpm', '-qp', '--qf', '%{NAME} %{VERSION} %{ARCH}', str(rpm)], text=True)
    assert metadata == f'{name} {version} x86_64', metadata

    # Verify packaged bytes, permissions, and symlinks before signing/uploading.
    extracted = temporary / 'verify'
    extracted.mkdir()
    converter = subprocess.Popen(['rpm2cpio', str(rpm)], stdout=subprocess.PIPE)
    try:
        run('cpio', '-idm', '--quiet', stdin=converter.stdout, cwd=extracted)
    finally:
        if converter.stdout is not None:
            converter.stdout.close()
    assert converter.wait() == 0
    for entry in entries:
        restored = extracted / entry.relative_to(payload)
        if entry.is_symlink():
            assert restored.is_symlink() and os.readlink(restored) == os.readlink(entry), str(entry)
        else:
            assert restored.is_file() and digest(restored) == digest(entry), str(entry)
            assert (restored.stat().st_mode & 0o7777) == (entry.stat().st_mode & 0o7777), str(entry)
    destination = root / 'src-tauri/target/release/bundle/rpm' / f'{product}-{version}-1.x86_64.rpm'
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(rpm, destination)
    print(f'Verified {len(entries)} payload files in {destination.name}')
