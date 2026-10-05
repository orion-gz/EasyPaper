#!/usr/bin/env python3
"""Sign/upload a native RPM and merge it into an existing draft updater manifest."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def release(repository, tag):
    return json.loads(subprocess.check_output(
        ['gh', 'release', 'view', tag, '--repo', repository, '--json', 'isDraft,assets'], text=True,
    ))


repository = os.environ['GITHUB_REPOSITORY']
tag = sys.argv[1]
config = json.loads(Path('src-tauri/tauri.conf.json').read_text())
version = config['version']
rpm = Path('src-tauri/target/release/bundle/rpm') / f"{config['productName']}-{version}-1.x86_64.rpm"
assert rpm.is_file()
assert release(repository, tag)['isDraft'], 'Upload requires a draft release'
signer = ['npm', 'run', 'tauri', '--', 'signer', 'sign']
help_text = subprocess.check_output([*signer, '--help'], text=True)
if '--app-version' in help_text:
    signer += ['--app-version', version]
run(*signer, str(rpm))
signature_file = Path(str(rpm) + '.sig')
assert signature_file.is_file()
signature = signature_file.read_text().strip()
assert signature
run('gh', 'release', 'upload', tag, str(rpm), str(signature_file), '--repo', repository, '--clobber')
updated = release(repository, tag)
asset = next(asset for asset in updated['assets'] if asset['name'] == rpm.name)
with tempfile.TemporaryDirectory(prefix='easypaper-updater-', dir=os.environ.get('RUNNER_TEMP')) as directory:
    run('gh', 'release', 'download', tag, '--repo', repository, '--pattern', 'latest.json', '--dir', directory)
    manifest_path = Path(directory) / 'latest.json'
    manifest = json.loads(manifest_path.read_text())
    assert manifest['version'].removeprefix('v') == version
    manifest['platforms']['linux-x86_64-rpm'] = {
        'url': asset['apiUrl'],
        'signature': signature,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    run('gh', 'release', 'upload', tag, str(manifest_path), '--repo', repository, '--clobber')
print(f'Uploaded signed RPM and updater entry for {version}')
