"""Exercise the installer without touching Docker or host data."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy/lab/install.sh'


class LabInstallTests(unittest.TestCase):
    def run_installer(self, user='1234:5678', fail=''):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            docker = root / 'docker'
            docker.write_text('''#!/usr/bin/env python3
import json, os, sys
with open(os.environ['CALL_LOG'], 'a') as log:
    log.write(json.dumps(sys.argv[1:]) + '\\n')
if 'config' in sys.argv:
    print(json.dumps({'services': {'easypaper': {'user': os.environ['APP_USER']}}}))
if os.environ['FAIL_STEP'] and os.environ['FAIL_STEP'] in sys.argv:
    sys.exit(42)
''')
            docker.chmod(0o755)
            env = dict(os.environ, PATH=f'{root}:{os.environ["PATH"]}',
                       CALL_LOG=str(root / 'calls'), APP_USER=user, FAIL_STEP=fail)
            result = subprocess.run(['bash', str(SCRIPT)], cwd=root, env=env,
                                    capture_output=True, text=True)
            import json
            calls = [json.loads(line) for line in (root / 'calls').read_text().splitlines()]
            return result, calls

    def test_custom_owner_and_arbitrary_working_directory(self):
        result, calls = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        prepare = next(call for call in calls if 'run' in call)
        self.assertEqual(prepare[-1], '1234:5678')
        self.assertIn(str(SCRIPT.parents[2] / 'docker-compose.lab.yml'), prepare)
        self.assertIn('up', calls[-1])

    def test_build_failure_does_not_prepare_or_start(self):
        result, calls = self.run_installer(fail='build')
        self.assertEqual(result.returncode, 42)
        self.assertFalse(any('run' in call or 'up' in call for call in calls))

    def test_preparation_failure_does_not_start(self):
        result, calls = self.run_installer(fail='run')
        self.assertEqual(result.returncode, 42)
        self.assertFalse(any('up' in call for call in calls))

    def test_invalid_or_root_owner_rejected_before_build(self):
        for user in ['0:1000', '1000:0', 'name:group', '1:2;echo unsafe']:
            with self.subTest(user=user):
                result, calls = self.run_installer(user=user)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(any('build' in call for call in calls))


if __name__ == '__main__':
    unittest.main()
