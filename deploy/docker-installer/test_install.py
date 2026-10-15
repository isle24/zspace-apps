#!/usr/bin/env python3
"""Exercise the real POSIX installer with a local Unix socket and fake Docker.

No Docker daemon, network, root account or host resources are used. Only the
fixed socket constant is replaced in a temporary copy; production has no socket
override. Every fake Docker call records its arguments and inherited overrides.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest


INSTALLER = Path(__file__).with_name('install.sh')
FAKE_DOCKER = r'''#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys
a = sys.argv[1:]
with open(os.environ['FIXTURE_LOG'], 'a') as target:
    target.write(json.dumps({'args': a, 'overrides': {k: os.environ[k] for k in (
        'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_API_VERSION', 'DOCKER_TLS_VERIFY',
        'DOCKER_CERT_PATH', 'DOCKER_CONFIG', 'DOCKER_DEFAULT_PLATFORM') if k in os.environ}}) + '\n')
expected = '/var/run/docker.sock' if os.environ.get('FIXTURE_IN_RUNNER') else os.environ['FIXTURE_SOCKET']
if a[:2] != ['--host', 'unix://' + expected]:
    sys.exit('Docker was not addressed through the fixed local Unix socket')
a = a[2:]
scenario = json.loads(pathlib.Path(os.environ['FIXTURE_SCENARIO']).read_text())
if scenario.get('permission'):
    sys.exit('permission denied')
if a[0] == 'version':
    print(scenario.get('version', '24.0.9'))
elif a[0] == 'info':
    print(scenario.get('info', 'linux|x86_64|/data_1/docker'))
elif a[:2] == ['container', 'ls']:
    if '--filter' in a:
        for f in [a[i + 1] for i, value in enumerate(a) if value == '--filter']:
            if f == scenario.get('container_filter') or (os.environ.get('FIXTURE_IN_RUNNER') and f == scenario.get('late_container_filter')):
                print('foreign-container')
    else:
        ports = scenario.get('late_docker_ports') if os.environ.get('FIXTURE_IN_RUNNER') else None
        if ports or scenario.get('docker_ports'):
            print(ports or scenario['docker_ports'])
elif a[:2] == ['volume', 'ls']:
    if any(f == scenario.get('volume_filter') or (os.environ.get('FIXTURE_IN_RUNNER') and f == scenario.get('late_volume_filter')) for f in a):
        print('foreign-volume')
elif a[:2] == ['network', 'ls']:
    if any(f == scenario.get('network_filter') or (os.environ.get('FIXTURE_IN_RUNNER') and f == scenario.get('late_network_filter')) for f in a):
        print('foreign-network')
elif a[:2] == ['container', 'inspect']:
    print(scenario.get('health', 'running|healthy'))
elif a[0] == 'pull':
    if scenario.get('pull_failure'):
        sys.exit('registry unavailable')
elif a[0] == 'run':
    index = next(i for i, value in enumerate(a) if value.startswith('isle204/zspace-shop:'))
    command = ['/bin/sh', *a[index + 1:]]
    # The entrypoint is an absolute bundled Docker path in production. In this
    # local fixture only, route that executable to the same recording fake CLI.
    command = [part.replace('/usr/local/bin/docker', sys.argv[0]) for part in command]
    sys.exit(subprocess.run(command, env=dict(os.environ, FIXTURE_IN_RUNNER='1')).returncode)
elif a[0] == 'compose':
    pathlib.Path(os.environ['FIXTURE_COMPOSE']).write_text(sys.stdin.read())
    if scenario.get('up_failure'):
        sys.exit('compose up failed')
else:
    sys.exit('Unexpected Docker operation: ' + repr(a))
'''


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='space-installer-')
        self.root = Path(self.tmp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.sockpath = str(self.root / 'docker.sock')
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.bind(self.sockpath)
        self.log = self.root / 'calls.jsonl'
        self.scenario = self.root / 'scenario.json'
        self.compose = self.root / 'compose.yaml'
        self.write_command('docker', FAKE_DOCKER)
        self.write_command('uname', '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n')
        self.write_command('ip', '''#!/bin/sh
case "$*" in
  "-4 -o addr show") printf '%s\\n' "${FIXTURE_ADDRESSES:-2: eth0 inet 192.168.3.56/24 scope global eth0}";;
  "-4 route get 1.1.1.1") printf '%s\\n' "${FIXTURE_ROUTE:-1.1.1.1 via 192.168.3.1 dev eth0 src 192.168.3.56}";;
  *) exit 1;;
esac
''')
        self.write_command('ss', '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_LISTENERS"\n')
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                        FIXTURE_SOCKET=self.sockpath, FIXTURE_LOG=str(self.log),
                        FIXTURE_SCENARIO=str(self.scenario), FIXTURE_COMPOSE=str(self.compose),
                        SSH_CONNECTION='192.168.3.5 4567 192.168.3.56 22',
                        FIXTURE_LISTENERS='')
        self.env.pop('FIXTURE_ADDRESSES', None)
        self.env.pop('FIXTURE_ROUTE', None)
        self.scenario.write_text('{}')

    def tearDown(self):
        self.sock.close()
        self.tmp.cleanup()

    def write_command(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o755)

    def run_installer(self, *args, scenario=None, env=None):
        if scenario is not None:
            self.scenario.write_text(json.dumps(scenario))
        script = self.root / 'install.sh'
        if not INSTALLER.exists():
            self.fail('The SSH installer has not been implemented')
        source = INSTALLER.read_text()
        self.assertIn('DOCKER_SOCKET=/var/run/docker.sock', source)
        script.write_text(source.replace('DOCKER_SOCKET=/var/run/docker.sock',
                                        "DOCKER_SOCKET='" + self.sockpath + "'", 1))
        return subprocess.run(['sh', str(script), *args], env=dict(self.env, **(env or {})),
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def writes(self):
        return [call for call in self.calls() if call['args'][2] in ('pull', 'run', 'rm', 'create')]

    def assert_preserved(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(self.writes(), self.calls())

    def test_supported_engines_check_without_mutation(self):
        for version in ('20.10.0', '22.0.0', '24.0.9', '26.1.4', '27.3.1', '28.0.0-ce'):
            with self.subTest(version=version):
                result = self.run_installer('--check', scenario={'version': version})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('192.168.3.56', result.stdout)
                self.assertFalse(self.writes())

    def test_old_missing_and_malformed_engine_versions_preserved(self):
        for version in ('19.03.15', '20.9.9', '', '24', '24.0', 'garbage', 'v24.0.9'):
            with self.subTest(version=version):
                self.assert_preserved(self.run_installer('--check', scenario={'version': version}))

    def test_remote_overrides_are_not_inherited(self):
        remote = {'DOCKER_HOST': 'tcp://remote.invalid:2375', 'DOCKER_CONTEXT': 'remote',
                  'DOCKER_API_VERSION': '1.24', 'DOCKER_TLS_VERIFY': '1',
                  'DOCKER_CERT_PATH': '/does/not/exist', 'DOCKER_CONFIG': '/remote/config',
                  'DOCKER_DEFAULT_PLATFORM': 'linux/arm64'}
        result = self.run_installer('--check', env=remote)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.calls())
        self.assertTrue(all(not call['overrides'] for call in self.calls()))

    def test_options_malformed_before_docker_calls(self):
        for args in (('--ip', ''), ('--data-root', ''), ('--ip', '192.168.3.56;id'), ('--ip', '127.0.0.1'),
                     ('--ip', '192.168.003.56'), ('--ip', '192.168.3.257'),
                     ('--ip', '192.168.3.99'), ('--project-name', '../evil'),
                     ('--project-name', 'UPPER'), ('--project-name', '-dash'),
                     ('--data-root', '/'), ('--data-root', '/data_1/../foo'),
                     ('--data-root', '/data_1/x\nservices:'), ('--data-root', '/etc/shop'),
                     ('--data-root', '/data_1/a,b'), ('--data-root', '/data_1/a$HOME'),
                     ('--data-root', '/data_1/a/'), ('--unknown',), ('--ip',)):
            with self.subTest(args=args):
                self.log.unlink(missing_ok=True)
                result = self.run_installer(*args)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertFalse(self.calls(), self.calls())

    def test_help_does_not_require_docker_or_valid_environment(self):
        result = self.run_installer('--help')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--shop-only', result.stdout)
        self.assertIn('--check', result.stdout)
        self.assertFalse(self.calls())

    def test_existing_container_volume_and_network_names_are_preserved(self):
        scenarios = [
            {'container_filter': 'name=^/zspace-suite-shop$'},
            {'container_filter': 'name=^/zspace-suite-ui$'},
            {'container_filter': 'name=^/zspace-suite-installer$'},
            {'container_filter': 'label=com.docker.compose.project=zspace-suite'},
            {'volume_filter': 'name=^zspace-suite_shop-control$'},
            {'volume_filter': 'name=^zspace-suite_ui-data$'},
            {'volume_filter': 'label=com.docker.compose.project=zspace-suite'},
            {'network_filter': 'name=^zspace-suite_default$'},
            {'network_filter': 'label=com.docker.compose.project=zspace-suite'},
        ]
        for scenario in scenarios:
            with self.subTest(scenario=scenario):
                self.log.unlink(missing_ok=True)
                self.assert_preserved(self.run_installer(scenario=scenario))

    def test_host_and_docker_port_conflicts_preserved(self):
        for port in ('18436', '18443'):
            with self.subTest(port=port):
                self.assert_preserved(self.run_installer(env={
                    'FIXTURE_LISTENERS': 'LISTEN 0 128 0.0.0.0:' + port + ' 0.0.0.0:*'}))
                self.assert_preserved(self.run_installer(scenario={
                    'docker_ports': '0.0.0.0:' + port + '->18435/tcp'}))

    def test_permission_error_is_actionable(self):
        result = self.run_installer('--check', scenario={'permission': True})
        self.assert_preserved(result)
        self.assertIn('sudo', result.stderr)

    def test_published_tcp_ranges_conflict_and_udp_does_not(self):
        for ports in ('0.0.0.0:18430-18450->18430-18450/tcp',
                      '[::]:18440-18445->18440-18445/tcp'):
            with self.subTest(ports=ports):
                self.log.unlink(missing_ok=True)
                self.assert_preserved(self.run_installer('--check', scenario={'docker_ports': ports}))
        for ports in ('0.0.0.0:18443->18443/udp',
                      '0.0.0.0:18430-18450->18430-18450/udp',
                      '0.0.0.0:18000-18435->18000-18435/tcp, 18443/tcp'):
            with self.subTest(ports=ports):
                self.assertEqual(self.run_installer('--check', scenario={'docker_ports': ports}).returncode, 0)

    def test_runner_rechecks_published_port_ranges_before_compose(self):
        result = self.run_installer(scenario={'late_docker_ports': '[::]:18430-18450->18430-18450/tcp'})
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertFalse(any(call['args'][2] == 'compose' for call in self.calls()))

    def test_non_socket_and_wrong_architecture_preserved(self):
        self.sock.close()
        os.unlink(self.sockpath)
        Path(self.sockpath).touch()
        self.assert_preserved(self.run_installer('--check'))
        os.unlink(self.sockpath)
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.bind(self.sockpath)
        self.assert_preserved(self.run_installer('--check', scenario={'info': 'linux|aarch64|/data_1/docker'}))

    def test_ambiguous_auto_ip_rejected_but_explicit_local_ip_works(self):
        env = {'SSH_CONNECTION': '', 'FIXTURE_ROUTE': 'unreachable 1.1.1.1',
               'FIXTURE_ADDRESSES': '2: eth0 inet 192.168.3.56/24 scope global eth0\n3: eth1 inet 10.0.0.2/24 scope global eth1'}
        self.assert_preserved(self.run_installer('--check', env=env))
        result = self.run_installer('--check', '--ip', '10.0.0.2', env=env)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_complete_install_hardened_runner_and_health_readiness(self):
        result = self.run_installer('--ip', '192.168.3.56', '--data-root', '/data_1/space-shop')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('http://192.168.3.56:18436', result.stdout)
        self.assertIn('http://192.168.3.56:18443', result.stdout)
        calls = self.calls()
        runs = [call['args'][2:] for call in calls if call['args'][2] == 'run']
        self.assertEqual(len(runs), 1)
        runner = runs[0]
        for option in ('--rm', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
                       '--network=none', '--no-healthcheck', '--wait', '--wait-timeout'):
            self.assertIn(option, ' '.join(runner))
        self.assertNotIn('--privileged', runner)
        self.assertEqual(runner.count('--mount'), 1)
        self.assertIn('/usr/local/bin/docker', ' '.join(runner))
        self.assertIn('zspace-suite-installer', runner)
        self.assertTrue(any(call['args'][2:4] == ['container', 'inspect'] for call in calls))
        config = self.compose.read_text()
        self.assertIn('isle204/zspace-shop:2026.10.15-r3', config)
        self.assertIn('isle204/zspace-ui:2026.10.15-r5', config)
        self.assertIn('SHOP_DATA_ROOT: /data_1/space-shop', config)
        self.assertNotIn('PASSWORD', config)

    def test_shop_only_has_no_ui_image_service_or_health_check(self):
        result = self.run_installer('--shop-only', env={
            'FIXTURE_LISTENERS': 'LISTEN 0 128 0.0.0.0:18436 0.0.0.0:*'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(':18436', result.stdout)
        self.assertNotIn('zspace-ui', self.compose.read_text())
        self.assertNotIn('SHOP_UI_ORIGIN', self.compose.read_text())
        self.assertNotIn('ui-data:', self.compose.read_text())
        for call in self.calls():
            if call['args'][2] == 'pull':
                self.assertNotIn('zspace-ui', ' '.join(call['args']))
            if call['args'][2:4] == ['container', 'inspect']:
                self.assertNotIn('zspace-suite-ui', call['args'])

    def test_custom_project_names_are_used_literally(self):
        result = self.run_installer('--project-name', 'zspace-test_2')
        self.assertEqual(result.returncode, 0, result.stderr)
        config = self.compose.read_text()
        self.assertIn('container_name: zspace-test_2-shop', config)
        self.assertIn('name: zspace-test_2_shop-control', config)

    def test_runner_rechecks_late_foreign_resources_before_compose_up(self):
        for scenario in ({'late_container_filter': 'name=^/zspace-suite-shop$'},
                         {'late_volume_filter': 'name=^zspace-suite_shop-control$'},
                         {'late_volume_filter': 'name=^zspace-suite_ui-data$'},
                         {'late_network_filter': 'label=com.docker.compose.project=zspace-suite'}):
            with self.subTest(scenario=scenario):
                self.log.unlink(missing_ok=True)
                result = self.run_installer(scenario=scenario)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertFalse(any(call['args'][2] == 'compose' for call in self.calls()))

    def test_unhealthy_and_partial_failures_never_claim_success_or_delete(self):
        for scenario in ({'health': 'running|unhealthy'}, {'health': 'running|starting'},
                         {'health': 'exited|healthy'}, {'health': 'running|missing'},
                         {'up_failure': True}, {'pull_failure': True}):
            with self.subTest(scenario=scenario):
                self.log.unlink(missing_ok=True)
                result = self.run_installer(scenario=scenario)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertNotIn('Installation ready', result.stdout)
                self.assertTrue(all(call['args'][2] not in ('rm', 'stop', 'kill') for call in self.calls()))


if __name__ == '__main__':
    unittest.main()
