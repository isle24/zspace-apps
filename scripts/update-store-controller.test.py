import copy
import importlib.util
import json
import os
import pathlib
import sqlite3
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parent
fixture_spec = importlib.util.spec_from_file_location('controller_fixture', ROOT / 'store-container-host.test.py')
fixture_module = importlib.util.module_from_spec(fixture_spec)
fixture_spec.loader.exec_module(fixture_module)
host = fixture_module.host
updater = types.SimpleNamespace()
if (ROOT / 'update-store-controller.py').exists():
    spec = importlib.util.spec_from_file_location('controller_updater', ROOT / 'update-store-controller.py')
    updater = importlib.util.module_from_spec(spec)
    updater.container_host = host
    spec.loader.exec_module(updater)


class ControllerUpdate(unittest.TestCase):
    def fixture(self, base):
        self.assertTrue(callable(getattr(updater, 'apply_update', None)), 'Missing safe controller updater')
        f = fixture_module.ContainerDeployment()
        plan, record, actual, receipt, db = f.clone_fixture(base)
        actual['State']['Running'] = True
        # NAS-only installations have no separately bootstrapped password account.
        plan['nasOrigin'] = 'http://192.168.3.56:18436'
        plan = host.plan(plan['root'], plan['storage'], plan['ip'], plan['port'], plan['release'],
                         plan['uid'], plan['gid'], nas_origin=plan['nasOrigin'], nas_only=True)
        record['plan'] = plan
        actual = f.fixture(plan)
        actual['State'] = {'Running': True}
        receipt.write_text(json.dumps(record)); os.chmod(receipt, 0o600)
        with sqlite3.connect(db) as connection:
            connection.execute('DELETE FROM sessions')
            connection.execute('DELETE FROM admin')
        self.source = actual
        self.candidate = None
        self.calls = []
        self.old_image, self.new_image = record['imageId'], 'sha256:' + '9' * 64
        self.target = host.plan(plan['root'], plan['storage'], plan['ip'], plan['port'], 'next-release',
                                plan['uid'], plan['gid'], nas_origin=plan['nasOrigin'], nas_only=True)
        self.plan, self.record = plan, record
        def command(args):
            self.calls.append(args)
            if args[:3] == ['docker', 'image', 'inspect']:
                image = args[3]
                layers = ['sha256:base'] + (['sha256:update'] if image == self.new_image else [])
                return json.dumps([{'Id': image, 'Architecture': 'amd64', 'Os': 'linux',
                                    'Config': {'Env': plan['env'], 'Entrypoint': actual['Config']['Entrypoint']},
                                    'RootFS': {'Layers': layers}}])
            if args[:3] == ['docker', 'image', 'ls']:
                return ''
            if args[:2] == ['docker', 'inspect']:
                item = self.source if args[2] == self.source['Id'] else self.candidate
                return json.dumps([item])
            if args[:2] == ['docker', 'create']:
                self.candidate = f.fixture(self.target)
                self.candidate['Id'] = '8' * 64
                self.candidate['Image'] = self.new_image
                self.candidate['State'] = {'Running': False}
                return self.candidate['Id']
            if args[:2] == ['docker', 'stop']:
                item = self.source if args[-1] == self.source['Id'] else self.candidate
                item['State']['Running'] = False
                return args[-1]
            if args[:2] == ['docker', 'start']:
                item = self.source if args[-1] == self.source['Id'] else self.candidate
                item['State']['Running'] = True
                return args[-1]
            raise AssertionError('Unexpected Docker command: ' + str(args[:3]))
        return plan, record, actual, receipt, db, command

    def test_preserves_nas_only_sqlite_store_id_and_root_mapping(self):
        with tempfile.TemporaryDirectory() as base:
            plan, record, actual, receipt, db, command = self.fixture(base)
            original_receipt = receipt.read_bytes()
            before = updater.database_proof(db)
            with patch.object(host, 'command', side_effect=command), patch.object(host, 'controller_health', return_value='1'*32), patch.object(host, 'health_check'):
                result = updater.apply_update(str(receipt), self.new_image, 'next-release')
                self.assertFalse(self.source['State']['Running'])
                self.assertTrue(self.candidate['State']['Running'])
                target_record, _ = host.validate_receipt(result['receipt'])
                self.assertEqual(target_record['plan']['mounts'], plan['mounts'])
                self.assertEqual(target_record['plan']['command'], plan['command'])
                self.assertEqual(updater.database_proof(db)['identity'], before['identity'])
                self.assertEqual(receipt.read_bytes(), original_receipt)
                backup = pathlib.Path(result['backup'])
                with sqlite3.connect('file:' + str(backup/'store.sqlite') + '?mode=ro', uri=True) as connection:
                    self.assertEqual(connection.execute('PRAGMA integrity_check').fetchone(), ('ok',))
                    self.assertEqual(connection.execute('SELECT count(*) FROM admin').fetchone()[0], 0)
                self.assertEqual(host.assert_quiesced(db)['status'], 'quiesced')
                rollback = updater.rollback_update(str(pathlib.Path(result['receipt']).parent/'update.json'))
                self.assertTrue(self.source['State']['Running'])
                self.assertFalse(self.candidate['State']['Running'])
                host.validate_receipt(str(receipt))
                self.assertEqual(rollback['containerId'], record['containerId'])
            self.assertFalse(any('rm' in call or 'remove' in call or 'prune' in call for call in self.calls))

    def test_active_and_unknown_jobs_refuse_before_stop(self):
        for table, status in [('jobs', 'queued'), ('runtime_jobs', 'running'), ('runtime_jobs', 'needs_attention')]:
            with self.subTest(table=table, status=status), tempfile.TemporaryDirectory() as base:
                plan, record, actual, receipt, db, command = self.fixture(base)
                fixture_module.ContainerDeployment().insert_job(db, table, status)
                with patch.object(host, 'command', side_effect=command), patch.object(host, 'controller_health', return_value='1'*32):
                    with self.assertRaises(ValueError): updater.apply_update(str(receipt), self.new_image, 'next-release')
                self.assertFalse(any(call[:2] == ['docker', 'stop'] for call in self.calls))
                self.assertFalse((pathlib.Path(plan['root'])/'releases/next-release').exists())

    def test_unpaused_store_refuses_before_stop(self):
        with tempfile.TemporaryDirectory() as base:
            plan, record, actual, receipt, db, command = self.fixture(base)
            with sqlite3.connect(db) as connection:
                connection.execute('DELETE FROM store_maintenance')
            with patch.object(host, 'command', side_effect=command), patch.object(host, 'controller_health', return_value='1'*32):
                with self.assertRaises(ValueError): updater.apply_update(str(receipt), self.new_image, 'next-release')
            self.assertFalse(any(call[:2] == ['docker', 'stop'] for call in self.calls))

    def test_authorized_offline_pause_resume_and_rollback_need_no_nas_credentials(self):
        self.assertTrue(callable(getattr(updater, 'offline_maintenance', None)), 'Missing audited offline maintenance')
        with tempfile.TemporaryDirectory() as base:
            plan, record, actual, receipt, db, command = self.fixture(base)
            with sqlite3.connect(db) as connection: connection.execute('DELETE FROM store_maintenance')
            before = updater.database_proof(db)['identity']
            with patch.object(host, 'command', side_effect=command), patch.object(host, 'controller_health', return_value='1'*32), patch.object(host, 'health_check'):
                result = updater.apply_update(str(receipt), self.new_image, 'next-release', offline=True, resume=True)
                self.assertEqual(result['state'], 'ready')
                self.assertEqual(updater.database_proof(db)['identity'], before)
                with sqlite3.connect(db) as connection:
                    rows = connection.execute('SELECT request_id,status,body FROM store_maintenance').fetchall()
                    self.assertEqual(len(rows), 1)
                    self.assertTrue(rows[0][0].startswith('offline-update-'))
                    self.assertEqual(rows[0][1], 'resumed')
                    self.assertEqual(connection.execute('SELECT count(*) FROM sessions').fetchone()[0], 0)
                rollback = updater.rollback_update(str(pathlib.Path(result['receipt']).parent/'update.json'), offline=True, resume=True)
                self.assertEqual(rollback['state'], 'ready')
                self.assertEqual(updater.database_proof(db)['identity'], before)

    def test_offline_writer_refuses_active_job_without_pause_or_stop(self):
        self.assertTrue(callable(getattr(updater, 'offline_maintenance', None)), 'Missing audited offline maintenance')
        with tempfile.TemporaryDirectory() as base:
            plan, record, actual, receipt, db, command = self.fixture(base)
            with sqlite3.connect(db) as connection: connection.execute('DELETE FROM store_maintenance')
            fixture_module.ContainerDeployment().insert_job(db, 'runtime_jobs', 'running')
            before = db.read_bytes()
            with patch.object(host, 'command', side_effect=command), patch.object(host, 'controller_health', return_value='1'*32):
                with self.assertRaises(ValueError): updater.apply_update(str(receipt), self.new_image, 'next-release', offline=True, resume=True)
            self.assertEqual(db.read_bytes(), before)
            self.assertFalse(any(call[:2] == ['docker', 'stop'] for call in self.calls))

    def test_offline_writer_requires_the_real_native_lease(self):
        with tempfile.TemporaryDirectory() as base:
            plan, record, actual, receipt, db, command = self.fixture(base)
            before = db.read_bytes()
            with self.assertRaises(ValueError): updater.offline_maintenance(record, lambda: None)
            self.assertEqual(db.read_bytes(), before)

    def test_incompatible_overlay_image_refuses_before_stop(self):
        with tempfile.TemporaryDirectory() as base:
            plan, record, actual, receipt, db, command = self.fixture(base)
            def wrong_image(args):
                result = command(args)
                if args[:3] == ['docker', 'image', 'inspect'] and args[3] == self.new_image:
                    image = json.loads(result)[0]; image['RootFS']['Layers'][0] = 'sha256:foreign'
                    return json.dumps([image])
                return result
            with patch.object(host, 'command', side_effect=wrong_image), patch.object(host, 'controller_health', return_value='1'*32):
                with self.assertRaises(ValueError): updater.apply_update(str(receipt), self.new_image, 'next-release')
            self.assertFalse(any(call[:2] == ['docker', 'stop'] for call in self.calls))

    def test_complete_accepts_exact_empty_runtime_tables_without_reapplying(self):
        self.assertTrue(callable(getattr(updater, 'complete_update', None)), 'Missing safe completion of retained candidate')
        with tempfile.TemporaryDirectory() as base:
            plan, record, actual, receipt, db, command = self.fixture(base)
            with patch.object(host, 'command', side_effect=command), patch.object(host, 'controller_health', return_value='1'*32), patch.object(host, 'health_check'):
                result = updater.apply_update(str(receipt), self.new_image, 'next-release')
                version = pathlib.Path(result['receipt']).parent
                (version/'switch-result.json').unlink()  # Reproduce the interrupted post-start validation.
                with sqlite3.connect(db) as connection:
                    connection.execute('CREATE TABLE runtime_secret_sets(id TEXT PRIMARY KEY,scope TEXT NOT NULL,ciphertext BLOB NOT NULL)')
                    connection.execute('CREATE TABLE runtime_cloud_recipes(id TEXT PRIMARY KEY,body TEXT NOT NULL)')
                calls_before = len(self.calls)
                completed = updater.complete_update(str(version/'update.json'), offline=True, resume=True)
                self.assertEqual(completed['state'], 'ready')
                self.assertEqual(set(completed['schemaAdditions']), {'runtime_secret_sets', 'runtime_cloud_recipes'})
                self.assertFalse(any(call[:2] in (['docker','stop'],['docker','start'],['docker','create']) for call in self.calls[calls_before:]))
                self.assertTrue((version/'backup/store.sqlite').is_file())
                self.assertEqual(updater.complete_update(str(version/'update.json'), offline=True, resume=True), completed)

    def test_complete_refuses_extra_changed_or_nonempty_migrations(self):
        self.assertTrue(callable(getattr(updater, 'complete_update', None)), 'Missing safe completion of retained candidate')
        for kind in ('wrong-columns', 'nonempty', 'extra-table', 'extra-index', 'modified-old'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as base:
                plan, record, actual, receipt, db, command = self.fixture(base)
                with patch.object(host, 'command', side_effect=command), patch.object(host, 'controller_health', return_value='1'*32), patch.object(host, 'health_check'):
                    result = updater.apply_update(str(receipt), self.new_image, 'next-release')
                    version = pathlib.Path(result['receipt']).parent
                    (version/'switch-result.json').unlink()
                    with sqlite3.connect(db) as connection:
                        if kind == 'wrong-columns': connection.execute('CREATE TABLE runtime_secret_sets(id TEXT PRIMARY KEY,scope TEXT,ciphertext TEXT)')
                        else:
                            connection.execute('CREATE TABLE runtime_secret_sets(id TEXT PRIMARY KEY,scope TEXT NOT NULL,ciphertext BLOB NOT NULL)')
                            connection.execute('CREATE TABLE runtime_cloud_recipes(id TEXT PRIMARY KEY,body TEXT NOT NULL)')
                            if kind == 'nonempty': connection.execute("INSERT INTO runtime_cloud_recipes VALUES('synthetic','{}')")
                            elif kind == 'extra-table': connection.execute('CREATE TABLE extra_runtime(id TEXT)')
                            elif kind == 'extra-index': connection.execute('CREATE INDEX extra_runtime_index ON runtime_cloud_recipes(body)')
                            elif kind == 'modified-old': connection.execute('ALTER TABLE plans ADD COLUMN incompatible TEXT')
                    with self.assertRaises(ValueError): updater.complete_update(str(version/'update.json'), offline=True, resume=True)
                    self.assertEqual(host.assert_quiesced(db)['status'], 'quiesced')
                    self.assertFalse((version/'switch-result.json').exists())

    def test_rollback_refuses_changed_root_mapping_and_preserves_sqlite(self):
        with tempfile.TemporaryDirectory() as base:
            plan, record, actual, receipt, db, command = self.fixture(base)
            with patch.object(host, 'command', side_effect=command), patch.object(host, 'controller_health', return_value='1'*32), patch.object(host, 'health_check'):
                result = updater.apply_update(str(receipt), self.new_image, 'next-release')
                with sqlite3.connect(db) as connection:
                    connection.execute('UPDATE runtime_instances SET body=?', (json.dumps({'id':'runtime_instances','changed':True}),))
                before = db.read_bytes()
                with self.assertRaises(ValueError): updater.rollback_update(str(pathlib.Path(result['receipt']).parent/'update.json'))
                self.assertEqual(db.read_bytes(), before)
                self.assertFalse(self.source['State']['Running'])


if __name__ == '__main__': unittest.main()
