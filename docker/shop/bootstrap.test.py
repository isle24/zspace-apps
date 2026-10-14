import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

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
        self.self_receipt = None
        self.deferred_phases = set()
        self.pending_helpers = {}

    def complete_helper(self, identity):
        command = self.pending_helpers.pop(identity)
        old, new = map(json.loads, command[2:4])
        if self.self_receipt not in (old, new): raise ValueError('Foreign self receipt')
        self.self_receipt = new
        self.containers[identity]['State'] = {'Status': 'exited', 'Running': False, 'ExitCode': 0}

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
            phase = row['Config']['Labels'].get('io.space-store.bootstrap-phase')
            if runtime and any(other['State']['Running'] and other['Config']['Labels']['io.space.role'] == 'standalone-shop-runtime' for other_id, other in self.containers.items() if other_id != cid):
                raise AssertionError('Two managed runtimes must never run together')
            if runtime and self.self_receipt is not None and self.self_receipt['containerId'] != cid:
                raise ValueError('Runtime self receipt differs')
            if not runtime:
                command = row['Config']['Cmd']
                if command[1] == '--write-receipt': self.self_receipt = json.loads(command[2])
                if command[1] == '--replace-receipt':
                    if phase in self.deferred_phases: self.pending_helpers[cid] = command
                    else:
                        old, new = map(json.loads, command[2:4])
                        if self.self_receipt not in (old, new): raise ValueError('Foreign self receipt')
                        self.self_receipt = new
            running = runtime or cid in self.pending_helpers
            row['State'] = {'Status': 'running' if running else 'exited', 'Running': running, 'ExitCode': 0}
            self.effect('runtime-start' if runtime else (phase + '-start' if phase in ('switch', 'rollback') else ('init-start' if row['Name'].startswith('/shop-initialize-') else 'receipt-start')))
            return cid
        if args[:2] == ('container', 'stop'):
            self.pending_helpers.pop(args[-1], None)
            self.containers[args[-1]]['State'] = {'Status': 'exited', 'Running': False, 'ExitCode': 137}
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


class UpgradeTests(unittest.TestCase):
    setUp = RuntimeTests.setUp
    ensure = RuntimeTests.ensure

    def prepare_upgrade(self):
        with patch.object(shop, 'RELEASE', 'shop-2026.10.14-r1'):
            self.source = self.ensure()
        self.old_self = dict(self.api.self_receipt)
        self.own = {**self.own, 'Image': 'sha256:' + 'c' * 64}
        self.state = {'authMode': 'independent', 'setupRequiresLoopback': False, 'configured': True, 'nasAuth': {'enabled': False, 'storeId': 'd' * 48}}
        self.state_patch = patch.object(shop, 'bootstrap_state', side_effect=lambda config: dict(self.state), create=True)
        self.state_patch.start(); self.addCleanup(self.state_patch.stop)
        self.sleep_patch = patch.object(shop.time, 'sleep'); self.sleep_patch.start(); self.addCleanup(self.sleep_patch.stop)

    def test_upgrade_retains_paths_account_identity_and_old_container(self):
        self.prepare_upgrade(); receipt = self.ensure()
        self.assertNotEqual(receipt['containerId'], self.source['containerId'])
        self.assertEqual(receipt['imageId'], self.own['Image'])
        self.assertTrue(receipt['plan']['release'].endswith('-' + 'c' * 12))
        for key in ('root', 'storage', 'uid', 'gid', 'ip', 'port', 'mounts'):
            self.assertEqual(receipt['plan'][key], self.source['plan'][key])
        self.assertFalse(self.api.inspect(self.source['containerId'])['State']['Running'])
        self.assertTrue(self.api.inspect(receipt['containerId'])['State']['Running'])
        self.assertEqual(self.api.self_receipt['containerId'], receipt['containerId'])
        self.assertEqual(shop.read_private(self.control/'deployment.json'), receipt)
        self.assertEqual(self.ensure(), receipt)

    def test_candidate_failure_restores_exact_old_self_and_runtime(self):
        self.prepare_upgrade(); self.api.fail_after = 'runtime-start'
        self.assertEqual(self.ensure(), self.source)
        self.assertEqual(self.api.self_receipt, self.old_self)
        self.assertTrue(self.api.inspect(self.source['containerId'])['State']['Running'])
        self.assertEqual(shop.read_private(self.control/'deployment.json'), self.source)
        self.assertEqual(sum(row['State']['Running'] for row in self.api.containers.values()), 1)

    def test_failed_upgrade_restart_checks_old_self_before_runtime_start(self):
        self.prepare_upgrade(); self.api.fail_after = 'runtime-start'; self.ensure()
        self.api.inspect(self.source['containerId'])['State']['Running'] = False
        self.api.self_receipt = {**self.old_self, 'containerId': 'f' * 64}
        self.api.commands.clear()
        with self.assertRaises(ValueError): self.ensure()
        self.assertFalse(any(command[-1] == self.source['containerId'] for command in self.api.mutations('start')))
        self.assertEqual(self.api.self_receipt['containerId'], 'f' * 64)

    def test_mismatched_store_id_rolls_back_before_commit(self):
        self.prepare_upgrade()
        def status(config):
            current = next(row for row in self.api.containers.values() if row['State']['Running'])
            return {**self.state, 'nasAuth': {'enabled': False, 'storeId': 'e' * 48 if current['Image'] == self.own['Image'] else 'd' * 48}}
        self.state_patch.stop(); self.state_patch = patch.object(shop, 'bootstrap_state', side_effect=status, create=True); self.state_patch.start()
        self.assertEqual(self.ensure(), self.source)
        self.assertEqual(self.api.self_receipt, self.old_self)

    def test_cancelled_switch_restores_old_self_without_starting_either_worker(self):
        self.prepare_upgrade(); stopped = False
        def event(name):
            nonlocal stopped
            if name == 'switch-start': stopped = True
        self.api.on_event = event
        with self.assertRaises(shop.Cancelled):
            shop.ensure_runtime(self.api, self.own, self.config, 989, cancelled=lambda: stopped)
        self.assertEqual(self.api.self_receipt, self.old_self)
        self.assertFalse(any(row['State']['Running'] for row in self.api.containers.values()))
        self.api.on_event = lambda event: None
        self.assertNotEqual(self.ensure()['containerId'], self.source['containerId'])

    def test_foreign_source_or_candidate_is_rejected_without_start_or_stop(self):
        self.prepare_upgrade()
        self.api.inspect(self.source['containerId'])['Config']['Labels']['io.space.role'] = 'foreign'
        self.api.commands.clear()
        with self.assertRaises(ValueError): self.ensure()
        self.assertEqual(self.api.mutations('start'), [])
        self.assertEqual(self.api.mutations('stop'), [])

    def test_atomic_self_receipt_switch_rejects_foreign_contents(self):
        path = self.control/'self.json'; old = {'containerId': 'a' * 64}; new = {'containerId': 'b' * 64}
        shop.write_private(path, old)
        shop.replace_private(path, old, new)
        shop.replace_private(path, old, new)
        self.assertEqual(shop.read_private(path), new)
        with self.assertRaises(ValueError): shop.replace_private(path, old, {'containerId': 'c' * 64})

    def test_interrupted_switch_or_start_resumes_with_one_runtime(self):
        class PowerLoss(BaseException): pass
        for event in ('switch-start', 'runtime-start'):
            with self.subTest(event=event):
                for file in self.control.iterdir(): file.unlink()
                self.api = FakeDocker(); self.own = self.api.inspect('a' * 12)
                self.prepare_upgrade()
                def interrupted(actual):
                    if actual == event: raise PowerLoss()
                self.api.on_event = interrupted
                with self.assertRaises(PowerLoss): self.ensure()
                self.api.on_event = lambda event: None
                receipt = self.ensure()
                self.assertEqual(receipt['imageId'], self.own['Image'])
                self.assertEqual(self.api.self_receipt['containerId'], receipt['containerId'])
                self.assertEqual(sum(row['State']['Running'] for row in self.api.containers.values()), 1)

    def test_lost_deployment_commit_response_keeps_committed_candidate(self):
        self.prepare_upgrade(); replace = shop.replace_private
        def lost_response(path, old, new):
            replace(path, old, new)
            if Path(path).name == 'deployment.json': raise OSError('lost commit response')
        with patch.object(shop, 'replace_private', side_effect=lost_response): receipt = self.ensure()
        self.assertEqual(receipt['imageId'], self.own['Image'])
        self.assertEqual(shop.read_private(self.control/'deployment.json'), receipt)
        self.assertEqual(self.api.self_receipt['containerId'], receipt['containerId'])
        self.assertFalse(self.api.inspect(self.source['containerId'])['State']['Running'])

    def test_foreign_candidate_after_lost_create_response_is_not_controlled(self):
        class PowerLoss(BaseException): pass
        self.prepare_upgrade()
        def interrupted(event):
            if event == 'runtime-create': raise PowerLoss()
        self.api.on_event = interrupted
        with self.assertRaises(PowerLoss): self.ensure()
        candidate = next(row for row in self.api.containers.values() if row['Image'] == self.own['Image'])
        candidate['Config']['Labels']['io.space-store.bootstrap-intent'] = 'foreign'
        self.api.on_event = lambda event: None; self.api.commands.clear()
        self.assertEqual(self.ensure(), self.source)
        self.assertEqual(self.api.mutations('start'), [])
        self.assertEqual(self.api.mutations('stop'), [])

    def test_changed_upgrade_intent_schema_is_rejected_before_runtime_control(self):
        class PowerLoss(BaseException): pass
        self.prepare_upgrade()
        def interrupted(event):
            if event == 'runtime-create': raise PowerLoss()
        self.api.on_event = interrupted
        with self.assertRaises(PowerLoss): self.ensure()
        path = next(self.control.glob('upgrade-*-intent.json'))
        intent = shop.read_private(path); intent['target']['schema'] = 2
        path.unlink(); shop.write_private(path, intent)
        self.api.on_event = lambda event: None; self.api.commands.clear()
        self.assertEqual(self.ensure(), self.source)
        self.assertEqual(self.api.mutations('start'), [])
        self.assertEqual(self.api.mutations('stop'), [])

    def test_interrupted_async_rollback_is_stopped_before_forward_switch(self):
        class PowerLoss(BaseException): pass
        self.prepare_upgrade(); self.api.fail_after = 'runtime-start'; self.api.deferred_phases.add('rollback')
        def interrupted(event):
            if event == 'rollback-start': raise PowerLoss()
        self.api.on_event = interrupted
        with self.assertRaises(PowerLoss): self.ensure()
        stale = next(cid for cid, row in self.api.containers.items() if row['Config']['Labels'].get('io.space-store.bootstrap-phase') == 'rollback')
        self.assertTrue(self.api.inspect(stale)['State']['Running'])
        self.api.on_event = lambda event: None; self.api.deferred_phases.clear()
        receipt = self.ensure()
        self.assertFalse(self.api.inspect(stale)['State']['Running'])
        self.assertNotIn(stale, self.api.pending_helpers)
        self.assertEqual(self.api.self_receipt['containerId'], receipt['containerId'])
        self.assertEqual(shop.read_private(self.control/'deployment.json'), receipt)

    def test_timed_out_async_switch_is_stopped_before_rollback(self):
        self.prepare_upgrade(); self.api.deferred_phases.add('switch')
        receipt = self.ensure()
        stale = next(cid for cid, row in self.api.containers.items() if row['Config']['Labels'].get('io.space-store.bootstrap-phase') == 'switch')
        self.assertEqual(receipt, self.source)
        self.assertFalse(self.api.inspect(stale)['State']['Running'])
        self.assertNotIn(stale, self.api.pending_helpers)
        self.assertEqual(self.api.self_receipt, self.old_self)

    def test_supervisor_keeps_or_restores_source_when_foreign_candidate_is_rejected(self):
        for running in (True, False):
            with self.subTest(source_running=running):
                for file in self.control.iterdir(): file.unlink()
                self.api = FakeDocker(); self.own = self.api.inspect('a' * 12); self.prepare_upgrade()
                self.api.inspect(self.source['containerId'])['State']['Running'] = running
                target_plan = shop.runtime_plan(self.config, 989, shop.RELEASE + '-' + self.own['Image'][7:19])
                args = shop.host_module().create_arguments(target_plan, self.own['Image'])
                foreign = self.api.command(*args[1:])
                self.api.inspect(foreign)['Config']['Labels']['io.space.role'] = 'foreign'
                handlers = {}; observed = []
                self.api.commands.clear()
                def slept(_):
                    observed.append(self.api.inspect(self.source['containerId'])['State']['Running'])
                    handlers[shop.signal.SIGTERM](shop.signal.SIGTERM, None)
                inspect = self.api.inspect
                def own_inspect(identity):
                    return self.own if identity == 'a'*12 else inspect(identity)
                socket_path = self.control/'docker.sock'; socket_path.touch(); original_stat = os.stat
                def socket_stat(path, *args, **kwargs):
                    return SimpleNamespace(st_gid=989) if str(path) == str(socket_path) else original_stat(path, *args, **kwargs)
                with patch.object(self.api, 'inspect', side_effect=own_inspect), patch.object(shop, 'DockerAPI', return_value=self.api), patch.object(shop.socket, 'gethostname', return_value='a'*12), patch.dict(shop.os.environ, {'HOSTNAME': 'a'*12, 'NAS_IP': self.config['ip'], 'SHOP_DATA_ROOT': self.config['root']}, clear=True), patch.object(shop, 'SOCKET', str(socket_path)), patch.object(shop.os, 'stat', side_effect=socket_stat), patch.object(shop.signal, 'signal', side_effect=lambda number, handler: handlers.__setitem__(number, handler)), patch.object(shop.time, 'sleep', side_effect=slept):
                    shop.supervise()
                self.assertEqual(observed, [True], 'source must stay online until the explicit stop signal')
                self.assertFalse(any(command[-1] == foreign for command in self.api.mutations('start') + self.api.mutations('stop')))

    def test_running_candidate_without_source_checkpoint_is_stopped_before_source_start(self):
        class PowerLoss(BaseException): pass
        self.prepare_upgrade()
        def interrupted(event):
            if event == 'runtime-start': raise PowerLoss()
        self.api.on_event = interrupted
        with self.assertRaises(PowerLoss): self.ensure()
        next(self.control.glob('upgrade-*-source-state.json')).unlink()
        candidate = next(row for row in self.api.containers.values() if row['Image'] == self.own['Image'] and row['Config']['Labels']['io.space.role'] == 'standalone-shop-runtime')
        self.api.on_event = lambda event: None; self.api.commands.clear()
        self.assertEqual(self.ensure(), self.source)
        stops = [i for i, command in enumerate(self.api.commands) if command[:2] == ('container', 'stop') and command[-1] == candidate['Id']]
        starts = [i for i, command in enumerate(self.api.commands) if command[:2] == ('container', 'start') and command[-1] == self.source['containerId']]
        self.assertTrue(stops and starts)
        self.assertLess(stops[0], starts[0])

    def test_running_foreign_candidate_does_not_trigger_unsafe_source_restore(self):
        class PowerLoss(BaseException): pass
        self.prepare_upgrade()
        def interrupted(event):
            if event == 'runtime-create': raise PowerLoss()
        self.api.on_event = interrupted
        with self.assertRaises(PowerLoss): self.ensure()
        candidate = next(row for row in self.api.containers.values() if row['Image'] == self.own['Image'])
        candidate['Config']['Labels']['io.space-store.bootstrap-intent'] = 'foreign'
        candidate['State']['Running'] = True
        self.api.inspect(self.source['containerId'])['State']['Running'] = False
        self.api.on_event = lambda event: None; self.api.commands.clear()
        with self.assertRaises(ValueError): self.ensure()
        self.assertEqual(self.api.mutations('start'), [])
        self.assertEqual(self.api.mutations('stop'), [])

if __name__ == '__main__': unittest.main()
