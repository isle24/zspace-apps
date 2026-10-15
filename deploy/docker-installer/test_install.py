#!/usr/bin/env python3
"""Exercise the real POSIX installer with a local Unix socket and fake Docker.

No Docker daemon, network, root account or host resources are used. Fixed host
resource constants are replaced in a temporary copy. The hardened runner runs
its real shell and Python preparation code against a disposable SSD directory.
"""
import json
import os
from pathlib import Path
import re
import shutil
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
    key = 'client_version' if '{{.Client.Version}}' in a else 'version'
    print(scenario.get(key, scenario.get('version', '24.0.9')))
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
    if scenario.get('replace_mount_before_run'):
        parent = pathlib.Path(os.environ['FIXTURE_SSD'])
        parent.rename(parent.with_name(parent.name + '.detached'))
        parent.mkdir()
    if scenario.get('symlink_install_before_run'):
        parent = pathlib.Path(os.environ['FIXTURE_SSD'])
        (parent / 'zspace-suite').symlink_to(scenario['symlink_install_before_run'], target_is_directory=True)
    index = next(i for i, value in enumerate(a) if value.startswith('isle204/zspace-shop:'))
    command = ['/bin/sh', *a[index + 1:]]
    # The entrypoint is an absolute bundled Docker path in production. In this
    # local fixture only, route that executable to the same recording fake CLI.
    command = [part.replace('/usr/local/bin/docker', sys.argv[0]).replace(
        '/usr/local/bin/python3', os.environ['FIXTURE_PYTHON']) for part in command]
    stdin = sys.stdin.read().replace('NAS_IP:', 'NAS_IP_TAMPERED:') if scenario.get('tamper_compose') else None
    sys.exit(subprocess.run(command, env=dict(os.environ, FIXTURE_IN_RUNNER='1'), input=stdin,
                            text=stdin is not None).returncode)
elif a[0] == 'compose':
    compose_file = a[a.index('--file') + 1]
    config = sys.stdin.read() if compose_file == '-' else pathlib.Path(compose_file).read_text()
    pathlib.Path(os.environ['FIXTURE_COMPOSE']).write_text(config)
    if scenario.get('up_failure'):
        sys.exit('compose up failed')
else:
    sys.exit('Unexpected Docker operation: ' + repr(a))
'''

FAKE_HOST = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
a = sys.argv[1:]
scenario = json.loads(pathlib.Path(os.environ['FIXTURE_SCENARIO']).read_text())
ssd = os.environ['FIXTURE_SSD']
mounts = scenario.get('mounts', [
    {'target': '/', 'source': '/dev/sda2', 'fstype': 'ext4', 'options': 'rw'},
    {'target': ssd, 'source': '/dev/nvme0n1p4', 'fstype': 'ext4', 'options': 'rw,noatime'}])
devices = {
    '/dev/sda2': '/dev/sda2 part 1 /dev/sda\n/dev/sda disk 1',
    '/dev/nvme0n1p1': '/dev/nvme0n1p1 part 0 /dev/nvme0n1\n/dev/nvme0n1 disk 0',
    '/dev/nvme0n1p4': '/dev/nvme0n1p4 part 0 /dev/nvme0n1\n/dev/nvme0n1 disk 0',
    '/dev/nvme1n1p1': '/dev/nvme1n1p1 part 0 /dev/nvme1n1\n/dev/nvme1n1 disk 0',
    '/dev/block/259:4': '/dev/nvme0n1p4 part 0 /dev/nvme0n1\n/dev/nvme0n1 disk 0',
    '/dev/block/259:5': '/dev/nvme1n1p1 part 0 /dev/nvme1n1\n/dev/nvme1n1 disk 0',
    '/dev/block/8:1': '/dev/sdb1 part 1 /dev/sdb\n/dev/sdb disk 1',
}
devices.update(scenario.get('devices', {}))
if name == 'findmnt':
    if a[-1] == 'UUID':
        target = a[a.index('-T') + 1]
        match = next((m for m in reversed(mounts) if m['target'] == target), None)
        if match and match.get('uuid'):
            print(match['uuid'])
    elif '-T' in a:
        target = a[a.index('-T') + 1]
        match = next((m for m in reversed(mounts) if m['target'] == target), None)
        if match:
            print(' '.join(match[key] for key in ('target', 'source', 'fstype', 'options')))
    else:
        for m in mounts:
            print(' '.join(m[key] for key in ('target', 'source', 'fstype', 'options')))
elif name == 'lsblk':
    value = devices.get(a[-1])
    if value is None:
        sys.exit(1)
    print(value)
elif name == 'df':
    target = a[-1]
    m = next((m for m in mounts if m['target'] == target), None)
    if not m:
        sys.exit(1)
    print('Filesystem 1024-blocks Used Available Capacity Mounted on')
    print(m['source'], 100000000, 10000, m.get('available', 50000000), '1%', target)
elif name == 'stat':
    if a[:2] != ['-c', '%d:%i']:
        sys.exit('Unexpected stat options: ' + repr(a))
    st = os.lstat(a[-1])
    print(str(st.st_dev) + ':' + str(st.st_ino))
elif name == 'id':
    if a == ['-u']:
        print(scenario.get('id_uid', os.getuid()))
    elif a == ['-g']:
        print(scenario.get('id_gid', os.getgid()))
    else:
        sys.exit('Unexpected id options: ' + repr(a))
else:
    sys.exit('Unexpected host operation: ' + name)
'''

FIXTURE_PYTHON = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
def fixture_fchown(fd, uid, gid):
    st = os.fstat(fd)
    with open(os.environ['FIXTURE_OWNERS'], 'a') as target:
        target.write(json.dumps({'device': st.st_dev, 'inode': st.st_ino, 'uid': uid, 'gid': gid}) + '\n')
os.fchown = fixture_fchown
if sys.argv[1] != '-c':
    sys.exit('Expected production preparation code passed through -c')
code = sys.argv[2]
sys.argv = ['-c', *sys.argv[3:]]
exec(compile(code, '<installer-prepare>', 'exec'))
'''


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='space-installer-', dir=INSTALLER.parent)
        self.root = Path(self.tmp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.ssd = self.root / 'data_fixture'
        self.ssd.mkdir()
        self.sysfs = self.root / 'sys-btrfs'
        self.sysfs.mkdir()
        self.socktmp = tempfile.TemporaryDirectory(prefix='space-socket-')
        self.sockpath = str(Path(self.socktmp.name) / 'docker.sock')
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.bind(self.sockpath)
        self.log = self.root / 'calls.jsonl'
        self.scenario = self.root / 'scenario.json'
        self.compose = self.root / 'captured-compose.yaml'
        self.owners = self.root / 'ownership.jsonl'
        self.write_command('docker', FAKE_DOCKER)
        for command in ('findmnt', 'lsblk', 'df', 'stat', 'id'):
            self.write_command(command, FAKE_HOST)
        self.write_command('fixture-python', FIXTURE_PYTHON)
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
                        FIXTURE_SSD=str(self.ssd), FIXTURE_OWNERS=str(self.owners),
                        FIXTURE_PYTHON=str(self.bin / 'fixture-python'),
                        SSH_CONNECTION='192.168.3.5 4567 192.168.3.56 22',
                        FIXTURE_LISTENERS='')
        self.env.pop('FIXTURE_ADDRESSES', None)
        self.env.pop('FIXTURE_ROUTE', None)
        self.env.pop('SUDO_UID', None)
        self.env.pop('SUDO_GID', None)
        self.scenario.write_text('{}')

    def tearDown(self):
        self.sock.close()
        self.tmp.cleanup()
        self.socktmp.cleanup()

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
        source = source.replace('DOCKER_SOCKET=/var/run/docker.sock',
                                "DOCKER_SOCKET='" + self.sockpath + "'", 1)
        source = source.replace("DATA_MOUNT_PATTERN='^/data_[A-Za-z0-9]+$'",
                                "DATA_MOUNT_PATTERN='^" + re.escape(str(self.root)) + "/data_[A-Za-z0-9]+$'", 1)
        source = source.replace('BTRFS_SYSFS_ROOT=/sys/fs/btrfs',
                                "BTRFS_SYSFS_ROOT='" + str(self.sysfs) + "'", 1)
        script.write_text(source)
        return subprocess.run(['sh', str(script), *args], env=dict(self.env, **(env or {})),
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def writes(self):
        return [call for call in self.calls() if call['args'][2] in ('pull', 'run', 'rm', 'create')]

    def mount(self, target=None, *, source='/dev/nvme0n1p4', fstype='ext4', options='rw,noatime', **extra):
        return dict(target=str(target or self.ssd), source=source, fstype=fstype, options=options, **extra)

    def mounts(self, *candidates, system_source='/dev/sda2'):
        return [self.mount('/', source=system_source), *(candidates or [self.mount()])]

    def btrfs_devices(self, uuid, *members):
        for index, major_minor in enumerate(members, 1):
            path = self.sysfs / uuid / 'devices' / str(index)
            path.mkdir(parents=True)
            (path / 'dev').write_text(major_minor + '\n')
            info = self.sysfs / uuid / 'devinfo' / str(index)
            info.mkdir(parents=True)
            (info / 'missing').write_text('0\n')

    def clear_install(self):
        for child in self.ssd.iterdir():
            if child.is_symlink():
                child.unlink()
            elif child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()

    def ownership_for(self, path):
        st = path.stat()
        rows = [json.loads(line) for line in self.owners.read_text().splitlines()]
        return [(row['uid'], row['gid']) for row in rows
                if row['device'] == st.st_dev and row['inode'] == st.st_ino]

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

    def test_check_reports_selected_ssd_and_compose_file_without_creating_them(self):
        result = self.run_installer('--check')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(str(self.ssd / 'zspace-suite' / 'compose.yaml'), result.stdout)
        self.assertEqual(list(self.ssd.iterdir()), [])
        self.assertFalse(self.writes())

    def test_default_install_persists_compose_on_selected_ssd(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        install_dir = self.ssd / 'zspace-suite'
        config = install_dir / 'compose.yaml'
        self.assertTrue(config.is_file(), 'The selected SSD must contain a reusable compose.yaml')
        self.assertEqual(config.read_text(), self.compose.read_text())
        text = config.read_text()
        self.assertIn('SHOP_DATA_ROOT: ' + str(install_dir / 'runtime'), text)
        for name in ('shop-control', 'ui-data'):
            self.assertTrue((install_dir / name).is_dir())
            self.assertIn('device: ' + str(install_dir / name), text)
        self.assertEqual(text.count('driver: local'), 2)
        self.assertEqual(text.count('o: bind'), 2)
        self.assertFalse((install_dir / 'runtime').exists(), 'Bootstrap must create and attest runtime data')
        self.assertEqual(config.stat().st_mode & 0o777, 0o644)
        self.assertEqual((install_dir / 'shop-control').stat().st_mode & 0o777, 0o700)
        self.assertEqual((install_dir / 'ui-data').stat().st_mode & 0o777, 0o700)
        self.assertIn((os.getuid(), os.getgid()), self.ownership_for(config))
        self.assertIn((0, 0), self.ownership_for(install_dir / 'shop-control'))
        self.assertIn((10001, 10001), self.ownership_for(install_dir / 'ui-data'))
        compose_call = next(call['args'][2:] for call in self.calls() if call['args'][2] == 'compose')
        self.assertEqual(compose_call[compose_call.index('--file') + 1], str(config))
        self.assertEqual(compose_call[compose_call.index('--project-directory') + 1], str(install_dir))

    def test_auto_ip_from_each_nas_network_is_persisted_in_compose(self):
        for ip in ('192.168.24.50', '10.2.8.9'):
            with self.subTest(ip=ip):
                self.clear_install()
                result = self.run_installer(env={
                    'SSH_CONNECTION': '172.16.1.2 4567 ' + ip + ' 22',
                    'FIXTURE_ADDRESSES': '2: eth0 inet ' + ip + '/24 scope global eth0',
                    'FIXTURE_ROUTE': '1.1.1.1 via 10.2.8.1 dev eth0 src ' + ip})
                self.assertEqual(result.returncode, 0, result.stderr)
                config = (self.ssd / 'zspace-suite' / 'compose.yaml').read_text()
                self.assertIn('NAS_IP: ' + ip, config)
                self.assertIn('NAS_ORIGIN: http://' + ip + ':5055', config)
                self.assertIn('SHOP_UI_ORIGIN: http://' + ip + ':18436', config)
                self.assertIn('ports: ["' + ip + ':18436:18436"]', config)
                self.assertNotIn('192.168.3.56', config)

    def test_selects_most_free_verified_ssd_and_preserves_other_mounts(self):
        second = self.root / 'data_second'
        second.mkdir()
        result = self.run_installer(scenario={'mounts': self.mounts(
            self.mount(available=10),
            self.mount(second, source='/dev/nvme1n1p1', available=900000))})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((second / 'zspace-suite' / 'compose.yaml').is_file())
        self.assertEqual(list(self.ssd.iterdir()), [])

    def test_hdd_hidden_below_nonrotational_bcache_is_rejected(self):
        result = self.run_installer('--check', scenario={
            'mounts': self.mounts(self.mount(source='/dev/bcache0')),
            'devices': {'/dev/bcache0': '/dev/bcache0 disk 0\n/dev/sdb disk 1\n/dev/nvme0n1 disk 0'}})
        self.assert_preserved(result)
        self.assertEqual(list(self.ssd.iterdir()), [])

    def test_duplicate_data_mount_targets_rejected_before_pull(self):
        result = self.run_installer('--check', scenario={'mounts': self.mounts(
            self.mount(), self.mount(source='/dev/sda2'))})
        self.assert_preserved(result)
        self.assertEqual(list(self.ssd.iterdir()), [])

    def test_yaml_special_project_names_are_quoted_as_strings(self):
        for project in ('123', 'false', 'null'):
            with self.subTest(project=project):
                self.clear_install()
                result = self.run_installer('--project-name', project)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('name: "' + project + '"\n', self.compose.read_text())

    def test_sudo_install_config_belongs_to_original_nas_account(self):
        result = self.run_installer(scenario={'id_uid': 0, 'id_gid': 0},
                                    env={'SUDO_UID': '1001', 'SUDO_GID': '1002'})
        self.assertEqual(result.returncode, 0, result.stderr)
        install_dir = self.ssd / 'zspace-suite'
        self.assertIn((1001, 1002), self.ownership_for(install_dir / 'compose.yaml'))
        self.assertIn((1001, 1002), self.ownership_for(install_dir))
        self.assertIn((0, 0), self.ownership_for(install_dir / 'shop-control'))
        self.assertIn((10001, 10001), self.ownership_for(install_dir / 'ui-data'))

    def test_unverified_readonly_system_and_hdd_mounts_rejected_before_pull(self):
        cases = [
            {'mounts': [self.mount('/', source='/dev/sda2')]},
            {'mounts': self.mounts(self.mount(options='ro,noatime'))},
            {'mounts': self.mounts(self.mount(source='/dev/sda2'))},
            {'mounts': self.mounts(system_source='/dev/nvme0n1p1')},
            {'mounts': self.mounts(self.mount(fstype='tmpfs', source='tmpfs'))},
            {'mounts': self.mounts(self.mount(source='/dev/missing'))},
            {'devices': {'/dev/nvme0n1p4': '/dev/nvme0n1p4 part 0 /dev/unknown'}},
        ]
        for scenario in cases:
            with self.subTest(scenario=scenario):
                self.log.unlink(missing_ok=True)
                self.assert_preserved(self.run_installer('--check', scenario=scenario))
                self.assertEqual(list(self.ssd.iterdir()), [])

    def test_btrfs_all_members_must_be_present_ssds(self):
        uuid = '11111111-2222-3333-4444-555555555555'
        self.btrfs_devices(uuid, '259:4', '259:5')
        mounts = self.mounts(self.mount(fstype='btrfs', uuid=uuid))
        result = self.run_installer('--check', scenario={'mounts': mounts})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(str(self.ssd), result.stdout)
        for members in ({'/dev/block/259:5': '/dev/sdb1 part 1 /dev/sdb\n/dev/sdb disk 1'},
                        {'/dev/block/259:5': ''}):
            with self.subTest(members=members):
                self.log.unlink(missing_ok=True)
                self.assert_preserved(self.run_installer('--check', scenario={'mounts': mounts, 'devices': members}))
        (self.sysfs / uuid / 'devinfo' / '2' / 'missing').write_text('1\n')
        self.log.unlink(missing_ok=True)
        self.assert_preserved(self.run_installer('--check', scenario={'mounts': mounts}))
        self.assertEqual(list(self.ssd.iterdir()), [])

    def test_btrfs_without_kernel_member_attestation_rejected(self):
        result = self.run_installer('--check', scenario={'mounts': self.mounts(
            self.mount(fstype='btrfs', uuid='11111111-2222-3333-4444-555555555555'))})
        self.assert_preserved(result)

    def test_unverified_system_btrfs_cannot_prove_data_ssd_is_separate(self):
        result = self.run_installer('--check', scenario={'mounts': [
            self.mount('/', source='/dev/sda2', fstype='btrfs',
                       uuid='11111111-2222-3333-4444-555555555555'),
            self.mount()]})
        self.assert_preserved(result)
        self.assertEqual(list(self.ssd.iterdir()), [])

    def test_secondary_system_btrfs_member_is_excluded_from_data_ssds(self):
        uuid = '11111111-2222-3333-4444-555555555555'
        self.btrfs_devices(uuid, '8:1', '259:4')
        result = self.run_installer('--check', scenario={'mounts': [
            self.mount('/', source='/dev/sda2', fstype='btrfs', uuid=uuid), self.mount()]})
        self.assert_preserved(result)
        self.assertEqual(list(self.ssd.iterdir()), [])

    def test_custom_install_directory_is_direct_child_of_verified_ssd(self):
        install_dir = self.ssd / 'my-project'
        runtime = self.ssd / 'dedicated-runtime'
        result = self.run_installer('--install-dir', str(install_dir), '--data-root', str(runtime))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((install_dir / 'compose.yaml').is_file())
        self.assertIn('SHOP_DATA_ROOT: ' + str(runtime), self.compose.read_text())

    def test_install_directory_outside_or_below_mount_root_rejected(self):
        for path in (self.root / 'arbitrary', self.ssd / 'nested' / 'project', self.ssd,
                     self.ssd / '../escaped'):
            with self.subTest(path=path):
                self.log.unlink(missing_ok=True)
                self.assert_preserved(self.run_installer('--install-dir', str(path)))
                self.assertEqual(list(self.ssd.iterdir()), [])

    def test_existing_install_directory_and_symlink_preserved(self):
        target = self.ssd / 'zspace-suite'
        target.mkdir()
        marker = target / 'user-data'
        marker.write_text('preserve me')
        self.assert_preserved(self.run_installer())
        self.assertEqual(marker.read_text(), 'preserve me')
        target.rename(self.ssd / 'existing-data')
        target.symlink_to(self.ssd / 'existing-data', target_is_directory=True)
        self.log.unlink(missing_ok=True)
        self.assert_preserved(self.run_installer())
        self.assertTrue(target.is_symlink())
        self.assertEqual((target / 'user-data').read_text(), 'preserve me')

    def test_ssd_mount_replacement_fails_before_any_directory_write(self):
        result = self.run_installer(scenario={'replace_mount_before_run': True})
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(any(call['args'][2] == 'compose' for call in self.calls()))
        self.assertEqual(list(self.ssd.iterdir()), [])
        self.assertEqual(list(self.ssd.with_name(self.ssd.name + '.detached').iterdir()), [])

    def test_late_install_symlink_is_preserved_without_touching_target(self):
        destination = self.root / 'existing-data'
        destination.mkdir()
        marker = destination / 'user-data'
        marker.write_text('preserve me')
        result = self.run_installer(scenario={'symlink_install_before_run': str(destination)})
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(any(call['args'][2] == 'compose' for call in self.calls()))
        self.assertTrue((self.ssd / 'zspace-suite').is_symlink())
        self.assertEqual(list(destination.iterdir()), [marker])
        self.assertEqual(marker.read_text(), 'preserve me')

    def test_modified_compose_input_rejected_before_any_directory_write(self):
        result = self.run_installer(scenario={'tamper_compose': True})
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(any(call['args'][2] == 'compose' for call in self.calls()))
        self.assertEqual(list(self.ssd.iterdir()), [])

    def test_nonrecursive_bind_option_tracks_local_cli_version(self):
        for client, server, expected in (('24.0.9', '28.0.0', 'bind-nonrecursive=true'),
                                         ('25.0.0', '24.0.9', 'bind-recursive=disabled')):
            with self.subTest(client=client, server=server):
                self.clear_install()
                self.log.unlink(missing_ok=True)
                result = self.run_installer(scenario={'version': server, 'client_version': client})
                self.assertEqual(result.returncode, 0, result.stderr)
                runner = next(call['args'][2:] for call in self.calls() if call['args'][2] == 'run')
                mounts = [runner[i + 1] for i, value in enumerate(runner) if value == '--mount']
                self.assertIn(expected, ' '.join(mounts))

    def test_check_reports_detected_paths_before_docker_project_conflict(self):
        result = self.run_installer('--check', scenario={
            'container_filter': 'label=com.docker.compose.project=zspace-suite'})
        self.assert_preserved(result)
        self.assertIn('192.168.3.56', result.stdout)
        self.assertIn(str(self.ssd / 'zspace-suite' / 'compose.yaml'), result.stdout)
        self.assertEqual(list(self.ssd.iterdir()), [])

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
        runtime = self.ssd / 'space-shop'
        result = self.run_installer('--ip', '192.168.3.56', '--data-root', str(runtime))
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
        self.assertEqual(runner.count('--mount'), 2)
        self.assertIn('--cap-add=CHOWN', runner)
        mounts = [runner[i + 1] for i, value in enumerate(runner) if value == '--mount']
        self.assertIn('type=bind,src=' + str(self.ssd) + ',dst=' + str(self.ssd), ' '.join(mounts))
        self.assertIn('bind-nonrecursive=true', ' '.join(mounts))
        self.assertIn('/usr/local/bin/docker', ' '.join(runner))
        self.assertIn('zspace-suite-installer', runner)
        self.assertTrue(any(call['args'][2:4] == ['container', 'inspect'] for call in calls))
        config = self.compose.read_text()
        self.assertIn('image: isle204/zspace-shop:latest', config)
        self.assertIn('image: isle204/zspace-ui:latest', config)
        self.assertIn('SHOP_DATA_ROOT: ' + str(runtime), config)
        self.assertNotIn('PASSWORD', config)

    def test_shop_only_has_no_ui_image_service_or_health_check(self):
        result = self.run_installer('--shop-only', env={
            'FIXTURE_LISTENERS': 'LISTEN 0 128 0.0.0.0:18436 0.0.0.0:*'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(':18436', result.stdout)
        self.assertNotIn('zspace-ui', self.compose.read_text())
        self.assertNotIn('SHOP_UI_ORIGIN', self.compose.read_text())
        self.assertNotIn('ui-data:', self.compose.read_text())
        self.assertTrue((self.ssd / 'zspace-suite' / 'shop-control').is_dir())
        self.assertFalse((self.ssd / 'zspace-suite' / 'ui-data').exists())
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
                self.clear_install()
                self.log.unlink(missing_ok=True)
                result = self.run_installer(scenario=scenario)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertNotIn('Installation ready', result.stdout)
                self.assertTrue(all(call['args'][2] not in ('rm', 'stop', 'kill') for call in self.calls()))


if __name__ == '__main__':
    unittest.main()
