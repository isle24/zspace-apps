import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('shop_bootstrap', Path(__file__).with_name('bootstrap.py'))
shop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shop)


class FakeDocker:
    """Docker's create/start effects can succeed before the CLI reports failure."""
    def __init__(self, default_propagation='rslave', daemon_root='/data_disk/docker'):
        self.containers = {}
        self.commands = []
        self.fail_after = None
        self.on_event = lambda event: None
        self.default_propagation = default_propagation
        self.daemon_root = daemon_root

    def find(self, name):
        return next((cid for cid, row in self.containers.items() if row['Name'] == '/' + name), '')

    def inspect(self, identity):
        if identity == 'a' * 12:
            return {'Id': 'a' * 64, 'Image': 'sha256:' + 'b' * 64,
                    'Config': {'Hostname': identity, 'Labels': {'io.space.role': 'standalone-shop-bootstrap'}},
                    'Mounts': [{'Type': 'volume', 'Destination': '/control', 'Source': '/control/source', 'RW': True}]}
        return self.containers[next(cid for cid in self.containers if cid.startswith(identity))]

    def effect(self, event):
        self.on_event(event)
        if self.fail_after == event:
            self.fail_after = None
            raise ValueError('simulated lost Docker response')

    def command(self, *args, **kwargs):
        self.commands.append(args)
        if args[0] == 'info':
            return json.dumps({'DockerRootDir': '/data_disk/docker', 'OSType': 'linux', 'Architecture': 'amd64', 'ServerVersion': '27.3.1', 'Driver': 'overlay2'})
        if args[0] == 'create' or args[:2] == ('container', 'create'):
            options = list(args[1:] if args[0] == 'create' else args[2:])
            values = {}; labels = {}; mounts = []; caps = []
            while options[0].startswith('--'):
                key = options.pop(0)
                if key in ('--read-only', '--no-healthcheck'):
                    values[key] = True; continue
                value = options.pop(0)
                if key == '--label':
                    label, content = value.split('=', 1); labels[label] = content
                elif key == '--cap-add': caps.append(value)
                elif key == '--mount':
                    fields = dict(piece.split('=', 1) for piece in value.split(',') if '=' in piece)
                    if (self.daemon_root == fields['src'] or self.daemon_root.startswith(fields['src'] + '/')) and fields.get('bind-propagation', self.default_propagation) not in ('rslave', 'rshared'):
                        raise ValueError('Daemon root parent requires slave propagation')
                    mounts.append({'Type': fields['type'], 'Source': fields['src'], 'Destination': fields['dst'], 'RW': 'readonly' not in value.split(','), 'Propagation': fields.get('bind-propagation', self.default_propagation)})
                else: values[key] = value
            image = options.pop(0)
            labels = {**shop.host_module().BASE_LABELS, **labels}
            cid = format(len(self.containers) + 1, '064x')
            host = {'Privileged': False, 'ReadonlyRootfs': values.get('--read-only', False), 'NetworkMode': values['--network'], 'CapDrop': [values['--cap-drop']], 'CapAdd': caps or None, 'SecurityOpt': [values['--security-opt']], 'Tmpfs': {'/tmp': 'rw,noexec,nosuid,size=32m'}, 'GroupAdd': [values['--group-add']] if '--group-add' in values else None, 'RestartPolicy': {'Name': values.get('--restart', 'no'), 'MaximumRetryCount': 0}, 'PortBindings': {}}
            if '--publish' in values:
                ip, port, target = values['--publish'].split(':')
                host['PortBindings'] = {target if '/' in target else target + '/tcp': [{'HostIp': ip, 'HostPort': port}]}
            self.containers[cid] = {'Id': cid, 'Image': image, 'Name': '/' + values['--name'], 'Config': {'User': values['--user'], 'Entrypoint': [values['--entrypoint']], 'Cmd': options, 'Labels': labels, 'Env': []}, 'HostConfig': host, 'Mounts': mounts, 'State': {'Status': 'created', 'Running': False, 'ExitCode': 0}}
            role = labels.get('io.space.role')
            event = 'runtime-create' if role == 'standalone-shop-runtime' else ('init-create' if values['--name'].startswith('shop-initialize-') else 'receipt-create')
            self.effect(event)
            return cid
        if args[:2] == ('container', 'start'):
            cid = args[-1]; row = self.containers[cid]
            runtime = row['Config']['Labels']['io.space.role'] == 'standalone-shop-runtime'
            row['State'] = {'Status': 'running' if runtime else 'exited', 'Running': runtime, 'ExitCode': 0}
            self.effect('runtime-start' if runtime else ('init-start' if row['Name'].startswith('/shop-initialize-') else 'receipt-start'))
            return cid
        if args[:2] == ('container', 'stop'):
            self.containers[args[-1]]['State']['Running'] = False
            return args[-1]
        raise AssertionError(args)

    def mutations(self, action):
        return [cmd for cmd in self.commands if cmd[:2] == ('container', action)]

class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.info = {'DockerRootDir': '/data_n008/data/udata/real/zdocker', 'OSType': 'linux', 'Architecture': 'x86_64', 'ServerVersion': '27.3.1', 'Driver': 'overlay2', 'DriverStatus': []}
        self.environment = {'NAS_IP': '192.168.3.56'}

    def test_default_storage_is_separate_from_docker_cache_and_stable(self):
        c = shop.configuration(self.environment, self.info, '/data_n008/zdocker/volumes/player_shop_control/_data')
        self.assertTrue(c['root'].startswith('/data_n008/space-shop-'), 'NAS user-data bind mappings cannot be selected as the physical data root')
        self.assertFalse(c['root'].startswith(self.info['DockerRootDir']))
        self.assertEqual(c, shop.configuration(self.environment, self.info, '/data_n008/zdocker/volumes/player_shop_control/_data'))

    def test_untrusted_configuration_is_rejected(self):
        for key, value in [('NAS_IP', '203.0.113.1'), ('NAS_IP', '0.0.0.0'), ('SHOP_PORT', '5055'), ('SHOP_DATA_ROOT', '/'), ('SHOP_DATA_ROOT', '/data_n008/data/udata/real/zdocker/apps'), ('SHOP_DATA_ROOT', '/data_n008/../etc/apps')]:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                shop.configuration({**self.environment, key: value}, self.info, '/control/source')
        for change in [{'DockerRootDir': '/var/lib/docker'}, {'ServerVersion': '26.1.0'}, {'Architecture': 'aarch64'}]:
            with self.assertRaises(ValueError):
                shop.configuration(self.environment, {**self.info, **change}, '/control/source')

    def test_initialization_never_changes_an_existing_directory(self):
        with tempfile.TemporaryDirectory() as base:
            root = Path(base).resolve() / 'shop'
            root.mkdir(mode=0o755)
            sentinel = root / 'keep'; sentinel.write_text('user file')
            with self.assertRaises(ValueError): shop.initialize(str(root), os.getuid(), os.getgid())
            self.assertEqual(sentinel.read_text(), 'user file')
            self.assertEqual(root.stat().st_mode & 0o777, 0o755)

    def test_new_directories_are_private_and_not_followed_through_links(self):
        with tempfile.TemporaryDirectory() as base:
            base = Path(base).resolve(); root = base / 'shop'
            shop.initialize(str(root), os.getuid(), os.getgid())
            for path in [root, root/'service', root/'service'/'metadata', root/'apps']:
                self.assertEqual(path.stat().st_mode & 0o777, 0o700)
            (base/'link').symlink_to(root, target_is_directory=True)
            with self.assertRaises(ValueError): shop.initialize(str(base/'link'/'new'), os.getuid(), os.getgid())

    def test_existing_managed_runtime_keeps_disjoint_metadata_and_application_roots(self):
        c = shop.configuration(self.environment, self.info, '/control/source')
        p = shop.host_module().plan(c['root']+'/service', c['root']+'/apps', c['ip'], c['port'], shop.RELEASE, c['uid'], c['gid'], 'local', c['cache'], 989)
        self.assertNotEqual(p['root'], p['storage'])
        self.assertFalse(p['storage'].startswith(p['root']+'/'))
        self.assertIn('--web-root', p['command'])
        self.assertNotIn('--nas-admin-only', p['command'])

    def test_foreign_runtime_cannot_be_started_or_stopped(self):
        receipt = {'containerId': 'a'*64, 'imageId': 'sha256:'+'b'*64, 'plan': {'name':'space-store-own', 'labels': {'io.space-store.service':'space-store'}, 'user':'10001:10001', 'command':['--engine','local'], 'mounts':[]}, 'socketGid':989}
        actual = {'Id':'f'*64, 'Image':receipt['imageId'], 'Name':'/space-store-own'}
        with self.assertRaises(ValueError): shop.validate_runtime(actual, receipt)
        commands = []
        class API:
            def inspect(self, identity): return actual
            def command(self, *args): commands.append(args)
        with self.assertRaises(ValueError): shop.stop_owned(API(), receipt)
        self.assertEqual(commands, [])

    def test_directory_initialization_resumes_only_its_own_marker(self):
        with tempfile.TemporaryDirectory() as base:
            root = Path(base).resolve() / 'shop'; token = 'c' * 64
            mkdir = os.mkdir
            def interrupted(path, *args, **kwargs):
                if str(path) == str(root / 'apps'): raise OSError('interrupted')
                return mkdir(path, *args, **kwargs)
            with patch.object(shop.os, 'mkdir', side_effect=interrupted), self.assertRaises(OSError):
                shop.initialize(str(root), os.getuid(), os.getgid(), token)
            sentinel = root / 'service' / 'keep'; sentinel.write_text('preserved')
            shop.initialize(str(root), os.getuid(), os.getgid(), token)
            self.assertEqual(sentinel.read_text(), 'preserved')
            for path in [root, root/'service', root/'service'/'metadata', root/'apps']:
                self.assertEqual(path.stat().st_mode & 0o777, 0o700)
            with self.assertRaises(ValueError):
                shop.initialize(str(root), os.getuid(), os.getgid(), 'd' * 64)
            self.assertEqual(sentinel.read_text(), 'preserved')

    def test_private_receipts_are_atomic_and_never_overwrite_foreign_files(self):
        with tempfile.TemporaryDirectory() as base:
            path = Path(base) / 'receipt.json'
            with patch.object(shop.os, 'fsync', side_effect=OSError('interrupted write')), self.assertRaises(OSError):
                shop.write_private(path, {'schema': 1})
            self.assertFalse(path.exists())
            shop.commit_private(path, {'schema': 1})
            shop.commit_private(path, {'schema': 1})
            with self.assertRaises(ValueError): shop.commit_private(path, {'schema': 2})
            with self.assertRaises(FileExistsError): shop.write_private(path, {'schema': 2})
            self.assertEqual(shop.read_private(path), {'schema': 1})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.stat().st_nlink, 1)

    def test_resume_rejects_changed_directory_mode_before_creating_other_paths(self):
        with tempfile.TemporaryDirectory() as base:
            root = Path(base).resolve() / 'shop'; token = 'c' * 64; mkdir = os.mkdir
            def interrupted(path, *args, **kwargs):
                if str(path) == str(root / 'apps'): raise OSError('interrupted')
                return mkdir(path, *args, **kwargs)
            with patch.object(shop.os, 'mkdir', side_effect=interrupted), self.assertRaises(OSError):
                shop.initialize(str(root), os.getuid(), os.getgid(), token)
            (root/'service').chmod(0o755)
            with self.assertRaises(ValueError): shop.initialize(str(root), os.getuid(), os.getgid(), token)
            self.assertFalse((root/'apps').exists())
            self.assertFalse((root/'service'/'metadata').exists())
            self.assertEqual((root/'service').stat().st_mode & 0o777, 0o755)

    def test_private_receipt_directory_fsync_failure_keeps_a_complete_single_link(self):
        with tempfile.TemporaryDirectory() as base:
            path = Path(base) / 'receipt.json'; fsync = os.fsync; calls = 0
            def interrupted(fd):
                nonlocal calls
                calls += 1
                if calls == 2: raise OSError('interrupted directory flush')
                return fsync(fd)
            with patch.object(shop.os, 'fsync', side_effect=interrupted), self.assertRaises(OSError):
                shop.write_private(path, {'schema': 1})
            self.assertEqual(shop.read_private(path), {'schema': 1})
            self.assertEqual(path.stat().st_nlink, 1)
            shop.commit_private(path, {'schema': 1})


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.control = Path(self.directory.name).resolve()
        self.control.chmod(0o700)
        self.control_patch = patch.object(shop, 'CONTROL', self.control); self.control_patch.start()
        self.addCleanup(self.control_patch.stop); self.addCleanup(self.directory.cleanup)
        self.api = FakeDocker(); self.own = self.api.inspect('a' * 12)
        self.config = {'root': '/data_disk/shop', 'cache': '/data_disk/docker', 'ip': '192.168.3.56', 'port': 18443, 'uid': 10001, 'gid': 10001}

    def ensure(self):
        return shop.ensure_runtime(self.api, self.own, self.config, 989)

    def test_helpers_use_exact_daemon_required_propagation_on_nas(self):
        self.api = FakeDocker(default_propagation='rslave')
        self.ensure()
        helpers = self.api.mutations('create')
        self.assertEqual(len(helpers), 2)
        for command in helpers:
            mount = command[command.index('--mount') + 1]
            expected = 'rslave' if command[command.index('--name') + 1].startswith('shop-initialize-') else 'rprivate'
            self.assertIn('bind-propagation=' + expected, mount.split(','))
            identity = self.api.find(command[command.index('--name') + 1])
            self.assertEqual(self.api.inspect(identity)['Mounts'][0]['Propagation'], expected)

    def test_initializer_parent_outside_daemon_root_stays_private(self):
        self.config['root'] = '/data_disk/stores/shop'
        self.ensure()
        for command in self.api.mutations('create'):
            self.assertIn('bind-propagation=rprivate', command[command.index('--mount') + 1].split(','))

    def test_helpers_reject_propagation_that_differs_from_exact_plan(self):
        for event in ('init-create', 'receipt-create'):
            with self.subTest(event=event):
                for file in self.control.iterdir(): file.unlink()
                self.api = FakeDocker(); self.api.fail_after = event
                with self.assertRaises(ValueError): self.ensure()
                changed = next(row for row in self.api.containers.values() if row['Name'].startswith('/shop-initialize-' if event == 'init-create' else '/shop-receipt-'))
                changed['Mounts'][0]['Propagation'] = 'rprivate' if event == 'init-create' else 'rslave'
                self.api.commands.clear()
                with self.assertRaises(ValueError): self.ensure()
                self.assertEqual(self.api.mutations('start'), [])
                self.assertEqual(self.api.mutations('stop'), [])

    def test_interrupted_phases_resume_without_duplicate_resources(self):
        for event in ('init-create', 'init-start', 'runtime-create', 'receipt-create', 'receipt-start'):
            with self.subTest(event=event):
                for file in self.control.iterdir(): file.unlink()
                self.api = FakeDocker(); self.api.fail_after = event
                with self.assertRaises(ValueError): self.ensure()
                created = dict(self.api.containers)
                receipt = self.ensure()
                self.assertEqual(len(self.api.containers), 3)
                self.assertTrue(set(created).issubset(self.api.containers))
                self.assertTrue(self.api.inspect(receipt['containerId'])['State']['Running'])
                self.assertEqual(shop.read_private(self.control/'deployment.json'), receipt)

    def test_final_receipt_failure_resumes_created_worker(self):
        original = shop.write_private
        def failed_commit(path, value):
            if Path(path).name == 'deployment.json': raise OSError('interrupted commit')
            return original(path, value)
        with patch.object(shop, 'write_private', side_effect=failed_commit), self.assertRaises(OSError):
            self.ensure()
        ids = set(self.api.containers)
        receipt = self.ensure()
        self.assertEqual(set(self.api.containers), ids)
        self.assertTrue(self.api.inspect(receipt['containerId'])['State']['Running'])

    def test_normal_restart_preserves_completed_receipt(self):
        receipt = self.ensure(); ids = set(self.api.containers)
        shop.stop_owned(self.api, receipt)
        self.assertEqual(self.ensure(), receipt)
        self.assertEqual(set(self.api.containers), ids)
        self.assertTrue(self.api.inspect(receipt['containerId'])['State']['Running'])

    def test_completed_legacy_receipt_without_intent_is_compatible(self):
        receipt = self.ensure(); cid = receipt['containerId']
        del receipt['intentId']
        del self.api.inspect(cid)['Config']['Labels']['io.space-store.bootstrap-intent']
        for file in self.control.iterdir(): file.unlink()
        shop.write_private(self.control/'deployment.json', receipt)
        self.api.inspect(cid)['State']['Running'] = False
        self.api.commands.clear()
        self.assertEqual(self.ensure(), receipt)
        self.assertEqual([cmd[-1] for cmd in self.api.mutations('start')], [cid])
        self.assertEqual(len(self.api.containers), 3)

    def test_foreign_name_or_receipt_never_starts_or_stops(self):
        receipt = self.ensure()
        self.api.inspect(receipt['containerId'])['Config']['Labels']['io.space.role'] = 'foreign'
        self.api.commands.clear()
        with self.assertRaises(ValueError): self.ensure()
        with self.assertRaises(ValueError): shop.stop_owned(self.api, receipt)
        self.assertEqual(self.api.mutations('start'), [])
        self.assertEqual(self.api.mutations('stop'), [])
        (self.control/'deployment.json').unlink()
        with self.assertRaises(ValueError): self.ensure()
        self.assertEqual(self.api.mutations('start'), [])
        self.assertEqual(self.api.mutations('stop'), [])

    def test_existing_name_without_persisted_intent_is_never_adopted(self):
        self.ensure()
        for file in self.control.iterdir(): file.unlink()
        self.api.commands.clear()
        with self.assertRaises(ValueError): self.ensure()
        self.assertFalse((self.control/'intent.json').exists())
        self.assertEqual(self.api.mutations('start'), [])
        self.assertEqual(self.api.mutations('stop'), [])

    def test_changed_private_receipt_never_starts_or_stops(self):
        receipt = self.ensure(); receipt['socketGid'] += 1
        (self.control/'deployment.json').unlink()
        shop.write_private(self.control/'deployment.json', receipt)
        self.api.commands.clear()
        with self.assertRaises(ValueError): self.ensure()
        with self.assertRaises(ValueError): shop.owned_runtime(self.api, self.own, self.config, 989)
        self.assertEqual(self.api.mutations('start'), [])
        self.assertEqual(self.api.mutations('stop'), [])

    def test_foreign_helper_cannot_be_reused_after_lost_create_response(self):
        for key in ('io.space-store.bootstrap-intent', 'io.space-store.bootstrap-phase'):
            with self.subTest(key=key):
                for file in self.control.iterdir(): file.unlink()
                self.api = FakeDocker(); self.api.fail_after = 'init-create'
                with self.assertRaises(ValueError): self.ensure()
                next(iter(self.api.containers.values()))['Config']['Labels'][key] = 'foreign'
                self.api.commands.clear()
                with self.assertRaises(ValueError): self.ensure()
                self.assertEqual(self.api.mutations('start'), [])
                self.assertEqual(self.api.mutations('stop'), [])

    def supervise_with_signal(self, event, failed=False):
        handlers = {}
        def on_event(actual):
            if actual == event:
                self.assertIn(shop.signal.SIGTERM, handlers, 'termination must be registered before creating or starting resources')
                handlers[shop.signal.SIGTERM](shop.signal.SIGTERM, None)
        self.api.on_event = on_event
        if failed: self.api.fail_after = event
        socket_path = self.control / 'docker.sock'; socket_path.touch()
        with patch.object(shop, 'DockerAPI', return_value=self.api), patch.object(shop.socket, 'gethostname', return_value='a'*12), patch.dict(shop.os.environ, {'HOSTNAME': 'a'*12, 'NAS_IP': self.config['ip']}, clear=True), patch.object(shop, 'SOCKET', str(socket_path)), patch.object(shop.signal, 'signal', side_effect=lambda number, handler: handlers.__setitem__(number, handler)), patch.object(shop, 'ready', return_value='http://192.168.3.56:18443'), patch.object(shop.time, 'sleep', side_effect=AssertionError('cancelled startup must not sleep')):
            if failed:
                with self.assertRaises(ValueError): shop.supervise()
            else: shop.supervise()

    def test_signal_during_initialization_prevents_worker_create(self):
        self.supervise_with_signal('init-start')
        self.assertFalse(any(row['Config']['Labels']['io.space.role'] == 'standalone-shop-runtime' for row in self.api.containers.values()))
        self.assertEqual(self.api.mutations('stop'), [])

    def test_signal_during_start_stops_exact_owned_worker(self):
        self.supervise_with_signal('runtime-start')
        workers = [row for row in self.api.containers.values() if row['Config']['Labels']['io.space.role'] == 'standalone-shop-runtime']
        self.assertEqual(len(workers), 1)
        self.assertFalse(workers[0]['State']['Running'])
        self.assertEqual([command[-1] for command in self.api.mutations('stop')], [workers[0]['Id']])

    def test_signal_and_lost_start_response_still_stop_owned_worker(self):
        self.supervise_with_signal('runtime-start', failed=True)
        stopped = self.api.mutations('stop')
        self.assertEqual(len(stopped), 1)
        self.assertFalse(self.api.inspect(stopped[0][-1])['State']['Running'])

    def test_signal_and_lost_create_response_still_resolve_owned_worker(self):
        self.supervise_with_signal('runtime-create', failed=True)
        self.assertEqual(self.api.mutations('start')[-1][-1], next(iter(self.api.containers)))
        self.assertEqual(self.api.mutations('stop'), [])

if __name__ == '__main__': unittest.main()
