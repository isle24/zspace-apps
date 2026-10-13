import json
import os
import pathlib
import shutil
import stat
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent


class DockerHubDeployment(unittest.TestCase):
    def fixture(self, base):
        self.assertTrue((ROOT/'deploy.sh').is_file(), 'Missing image-only DockerHub deployment script')
        work = pathlib.Path(base)/'delivery'; shutil.copytree(ROOT, work)
        tools = pathlib.Path(base)/'tools'; tools.mkdir()
        logfile = pathlib.Path(base)/'docker.jsonl'
        mock = tools/'docker'
        mock.write_text('''#!/usr/bin/env python3
import json,os,pathlib,sys
a=sys.argv[1:]
log=pathlib.Path(os.environ['DOCKER_TEST_LOG'])
with log.open('a') as out: out.write(json.dumps({'args':a})+'\\n')
if os.environ.get('DOCKER_TEST_CONSUME_STDIN')=='1' and '--post-file=/dev/stdin' not in a: sys.stdin.read()
if 'version' in a: print('Docker Compose version v2.40.0')
elif 'ps' in a and 'catalog' in a:
 if os.environ.get('DOCKER_TEST_EXISTING')=='1': print('synthetic-existing-catalog')
elif 'volume' in a and 'ls' in a:
 if os.environ.get('DOCKER_TEST_VOLUME')=='1': print('synthetic-existing-volume')
elif 'volume' in a and 'inspect' in a:
 sys.exit(0 if os.environ.get('DOCKER_TEST_UNLABELED_VOLUME')=='1' else 1)
elif 'exec' in a and 'bootstrap' in a:
 if '--post-file=/dev/stdin' in a:
  body=json.loads(sys.stdin.read())
  assert body['username']=='sample-admin' and body['password']==os.environ['DOCKER_TEST_PASSWORD']
  assert '-O' in a and a[a.index('-O')+1]=='/dev/null'
  with log.open('a') as out: out.write(json.dumps({'stdin_json_ok':True})+'\\n')
 else: print('{"ok":true,"data":{"configured":false}}')
''')
        mock.chmod(0o755)
        for mode in ('ui','catalog'):
            shutil.copyfile(work/mode/'config.example.env', work/mode/'.env')
        env={**os.environ,'PATH':str(tools)+os.pathsep+os.environ['PATH'],'DOCKER_TEST_LOG':str(logfile)}
        return work, logfile, env

    def run_deploy(self, work, env, args, inputs=''):
        return subprocess.run(['bash',str(work/'deploy.sh'),*args],input=inputs,text=True,capture_output=True,env=env)

    def test_fresh_catalog_safely_initializes_without_exposing_password(self):
        with tempfile.TemporaryDirectory() as base:
            work, log, env=self.fixture(base)
            password='safe-quote"-slash\\-中文'
            env['DOCKER_TEST_PASSWORD']=password
            result=self.run_deploy(work,env,['catalog'],f'sample-admin\n{password}\n{password}\n')
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertNotIn(password,result.stdout+result.stderr+log.read_text())
            events=[json.loads(line) for line in log.read_text().splitlines()]
            self.assertTrue(any(row.get('stdin_json_ok') for row in events))
            secret=work/'catalog/.env.postgres-password'
            self.assertEqual(stat.S_IMODE(secret.stat().st_mode),0o600)
            self.assertEqual(len(secret.read_text()),64)
            self.assertFalse(any('build' in row.get('args',[]) or 'rm' in row.get('args',[]) or 'down' in row.get('args',[]) for row in events))

    def test_password_control_characters_are_valid_json(self):
        with tempfile.TemporaryDirectory() as base:
            work, log, env=self.fixture(base)
            password='private-control-\x0b-\x1f-value'
            env['DOCKER_TEST_PASSWORD']=password
            result=self.run_deploy(work,env,['catalog','--no-pull'],f'sample-admin\n{password}\n{password}\n')
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertNotIn(password,result.stdout+result.stderr+log.read_text())

    def test_noninteractive_docker_commands_cannot_consume_admin_input(self):
        with tempfile.TemporaryDirectory() as base:
            work, log, env=self.fixture(base)
            env['DOCKER_TEST_PASSWORD']='safe-private-test-password';env['DOCKER_TEST_CONSUME_STDIN']='1'
            result=self.run_deploy(work,env,['catalog','--no-pull'],'sample-admin\nsafe-private-test-password\nsafe-private-test-password\n')
            self.assertEqual(result.returncode,0,result.stderr)

    def test_existing_catalog_preserves_secret_and_skips_admin(self):
        with tempfile.TemporaryDirectory() as base:
            work, log, env=self.fixture(base); env['DOCKER_TEST_EXISTING']='1'
            secret=work/'catalog/.env.postgres-password'; secret.write_text('existing-private-test-secret');secret.chmod(0o600)
            result=self.run_deploy(work,env,['catalog'])
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(secret.read_text(),'existing-private-test-secret')
            events=[json.loads(line) for line in log.read_text().splitlines()]
            self.assertFalse(any('bootstrap' in row.get('args',[]) for row in events if 'up' in row.get('args',[]) or 'exec' in row.get('args',[])))

    def test_skip_admin_option_never_reads_password(self):
        with tempfile.TemporaryDirectory() as base:
            work, log, env=self.fixture(base)
            result=self.run_deploy(work,env,['catalog','--skip-admin-bootstrap'])
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertNotIn('管理员密码',result.stderr+result.stdout)
            events=[json.loads(line) for line in log.read_text().splitlines()]
            self.assertFalse(any('bootstrap' in row.get('args',[]) for row in events if 'up' in row.get('args',[]) or 'exec' in row.get('args',[])))

    def test_no_pull_uses_only_available_images(self):
        with tempfile.TemporaryDirectory() as base:
            work, log, env=self.fixture(base)
            result=self.run_deploy(work,env,['catalog','--skip-admin-bootstrap','--no-pull'])
            self.assertEqual(result.returncode,0,result.stderr)
            events=[json.loads(line) for line in log.read_text().splitlines()]
            self.assertFalse(any('pull' in row.get('args',[]) for row in events))
            self.assertTrue(any('--pull' in row.get('args',[]) and 'never' in row.get('args',[]) for row in events))

    def test_missing_secret_refuses_existing_container_or_project_volume(self):
        for marker in ('DOCKER_TEST_EXISTING', 'DOCKER_TEST_VOLUME', 'DOCKER_TEST_UNLABELED_VOLUME'):
            with self.subTest(marker=marker), tempfile.TemporaryDirectory() as base:
                work, log, env=self.fixture(base); env[marker]='1'
                result=self.run_deploy(work,env,['catalog','--skip-admin-bootstrap','--no-pull'])
                self.assertNotEqual(result.returncode,0)
                self.assertFalse((work/'catalog/.env.postgres-password').exists())
                self.assertIn('恢复原',result.stderr)

    def test_password_mismatch_stops_bootstrap_and_keeps_resources(self):
        with tempfile.TemporaryDirectory() as base:
            work, log, env=self.fixture(base)
            result=self.run_deploy(work,env,['catalog'],'sample-admin\nfirst-private-value\nsecond-private-value\n')
            self.assertNotEqual(result.returncode,0)
            self.assertNotIn('first-private-value',result.stderr+result.stdout+log.read_text())
            events=[json.loads(line) for line in log.read_text().splitlines()]
            self.assertTrue(any('stop' in row.get('args',[]) and 'bootstrap' in row.get('args',[]) for row in events))
            self.assertFalse(any('--post-file=/dev/stdin' in row.get('args',[]) for row in events))


if __name__=='__main__': unittest.main()
