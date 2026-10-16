import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class UpdateTests(unittest.TestCase):
    def run_update(self, *, files=1, symlink=False, failure='', args=()):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            for number in range(files):
                path = base / ('data_' + str(number)) / 'zspace-suite'
                path.mkdir(parents=True)
                (path / 'compose.yaml').write_text('name: zspace-suite\nservices: {}\n')
            if symlink:
                source = base/'data_0/zspace-suite/compose.yaml'
                source.rename(source.with_name('original.yaml'))
                source.symlink_to('original.yaml')
            log = base/'log'
            docker = base/'docker'
            docker.write_text('''#!/usr/bin/env python3
import json,os,sys
with open(os.environ['UPDATE_LOG'],'a') as f:f.write(json.dumps(sys.argv[1:])+'\\n')
a=sys.argv[3:]
if a[0]==os.environ.get('UPDATE_FAILURE'):sys.exit(1)
if a[0]=='version':print('26.1.4')
elif a[0]=='info':print('linux|x86_64')
elif a[:2]==['image','inspect']:print('sha256:'+'a'*64)
''')
            docker.chmod(0o755)
            source = Path(__file__).with_name('update.sh').read_text().replace('/data_*/zspace-suite/compose.yaml', str(base)+'/data_*/zspace-suite/compose.yaml')
            script = base/'update.sh'; script.write_text(source)
            result = subprocess.run(['sh', str(script), *args], text=True, capture_output=True,
                                    env=dict(os.environ, PATH=str(base)+':'+os.environ['PATH'], UPDATE_LOG=str(log), UPDATE_FAILURE=failure))
            calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            for path in base.glob('data_*/zspace-suite/*.yaml'):
                self.assertEqual(path.read_text(), 'name: zspace-suite\nservices: {}\n')
            return result, calls

    def test_update_uses_saved_compose_and_ephemeral_bundled_cli(self):
        result, calls = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Update ready', result.stdout)
        self.assertTrue(all(c[:2] == ['--host','unix:///var/run/docker.sock'] for c in calls))
        pulls = [c[-1] for c in calls if c[2]=='pull']
        self.assertEqual(pulls, ['isle204/zspace-shop:latest','isle204/zspace-ui:latest'])
        runner = next(c for c in calls if c[2]=='run')
        for option in ('--rm','--read-only','--network','none','--cap-drop','ALL','--cgroupns','private','--ipc'):
            self.assertIn(option, runner)
        self.assertIn('sha256:'+'a'*64, runner)
        self.assertTrue(any('dst=/deploy/compose.yaml,readonly' in arg for arg in runner))
        self.assertEqual(runner[-7:], ['up','--detach','--pull','never','--wait','--wait-timeout','180'])
        self.assertNotIn('down', runner)
        self.assertNotIn('-v', runner)

    def test_missing_ambiguous_or_symlink_file_never_calls_docker(self):
        for options in ({'files':0}, {'files':2}, {'symlink':True}):
            with self.subTest(options=options):
                result, calls = self.run_update(**options)
                self.assertNotEqual(result.returncode,0)
                self.assertEqual(calls,[])

    def test_failed_pull_never_starts_updater(self):
        result, calls = self.run_update(failure='pull')
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(any(c[2]=='run' for c in calls))
        self.assertNotIn('Update ready',result.stdout)

    def test_failed_compose_never_claims_ready(self):
        result, calls = self.run_update(failure='run')
        self.assertNotEqual(result.returncode,0)
        self.assertNotIn('Update ready',result.stdout)

    def test_help_is_read_only(self):
        result, calls = self.run_update(files=0,args=('--help',))
        self.assertEqual(result.returncode,0)
        self.assertEqual(calls,[])


if __name__ == '__main__': unittest.main()
