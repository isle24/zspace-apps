#!/usr/bin/env python3
"""Reviewed in-place managed-controller image switch; keeps SQLite and app roots.

Default is read-only review. Use an authenticated maintenance pause or the
explicit audited SSH-administrator offline path. Apply/rollback retain every
container, image, backup and user file.
"""
import argparse
import base64
import copy
import datetime
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import secrets
import sqlite3
import stat
import subprocess
import sys
import types
import urllib.parse
import zlib

if 'container_host' not in globals():
    spec = importlib.util.spec_from_file_location('container_host', pathlib.Path(__file__).with_name('store-container-host.py'))
    container_host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(container_host)
h = container_host


def database_proof(path, stopped=False):
    with h.readonly_evidence(path, stopped) as db:
        if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise ValueError('controller database integrity differs')
        schema = db.execute('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').fetchall()
        tables = {name for kind, name, owner, sql in schema if kind == 'table'}
        required = {'metadata', 'jobs', 'runtime_jobs', 'instances', 'storage_roots',
                    'runtime_instances', 'runtime_generations', 'store_maintenance'}
        if (not required <= tables or any(kind not in ('table', 'index') for kind, *_ in schema)
                or any(kind == 'table' and (not sql or not re.match(r'^CREATE TABLE\s', sql, re.I)) for kind, name, owner, sql in schema)):
            raise ValueError('controller database schema unsupported')
        identity = db.execute("SELECT value FROM metadata WHERE key='store_id'").fetchall()
        if len(identity) != 1 or not re.fullmatch('[0-9a-f]{48}', identity[0][0]):
            raise ValueError('controller store identity differs')
        digests = {name: h._clone_digest(db.execute('SELECT * FROM ' + h._clone_identifier(name))) for name in tables}
        roots = {name: digests[name] for name in ('instances', 'storage_roots', 'runtime_instances', 'runtime_generations', 'runtime_snapshots') if name in tables}
        return {'identity': {'storeId': identity[0][0], 'schema': h._clone_digest(schema), 'rootMapping': roots}, 'tables': digests}


EMPTY_SCHEMA_ADDITIONS = {
    'runtime_secret_sets': 'CREATE TABLE runtime_secret_sets(id TEXT PRIMARY KEY,scope TEXT NOT NULL,ciphertext BLOB NOT NULL)',
    'runtime_cloud_recipes': 'CREATE TABLE runtime_cloud_recipes(id TEXT PRIMARY KEY,body TEXT NOT NULL)',
}


def compatible_identity(before, after, backup_path, current_path, stopped=False):
    """Allow only the two reviewed empty additive runtime migrations.

    Existing objects retain their complete sqlite_schema rows. No generic
    additive-schema allowance, normalization, data removal or migration runs.
    """
    for key in ('storeId', 'rootMapping'):
        if before['identity'][key] != after['identity'][key]:
            raise ValueError('controller store identity or root mapping changed')
    if before['identity']['schema'] == after['identity']['schema']: return []
    def schema_rows(path, immutable):
        with h.readonly_evidence(path, immutable) as db:
            return db.execute('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').fetchall()
    original = schema_rows(backup_path, True)
    current = schema_rows(current_path, stopped)
    if h._clone_digest(original) != before['identity']['schema'] or h._clone_digest(current) != after['identity']['schema']:
        raise ValueError('controller schema proof changed')
    old_objects = {(row[0], row[1]): row for row in original}
    new_objects = {(row[0], row[1]): row for row in current}
    if any(new_objects.get(key) != value for key, value in old_objects.items()):
        raise ValueError('existing controller schema object changed')
    extras = {key: value for key, value in new_objects.items() if key not in old_objects}
    accepted = {}
    tables = []
    for table, ddl in EMPTY_SCHEMA_ADDITIONS.items():
        table_key = ('table', table)
        if table_key not in extras: continue
        index = 'sqlite_autoindex_' + table + '_1'
        expected = {table_key: ('table', table, table, ddl), ('index', index): ('index', index, table, None)}
        if any(extras.get(key) != row for key, row in expected.items()):
            raise ValueError('runtime additive table definition differs')
        if after['tables'].get(table, {}).get('rows') != 0:
            raise ValueError('runtime additive table must remain empty')
        accepted.update(expected); tables.append(table)
    if extras != accepted or not tables:
        raise ValueError('unapproved controller schema addition')
    return sorted(tables)


def target_plan(source, release):
    if not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}', release) or release.lower() == source['release'].lower():
        raise ValueError('new release must be explicit and different')
    return h.plan(source['root'], source['storage'], source['ip'], source['port'], release,
                  source['uid'], source['gid'], source['engine'], source['dockerRoot'],
                  source['socketGid'], source['nasOrigin'], source.get('nasAdminOnly', False))


def verify_image(source_id, target_id):
    if not re.fullmatch('sha256:[0-9a-f]{64}', target_id) or target_id == source_id:
        raise ValueError('explicit new immutable image ID required')
    source = json.loads(h.command(['docker', 'image', 'inspect', source_id]))[0]
    target = json.loads(h.command(['docker', 'image', 'inspect', target_id]))[0]
    layers = source.get('RootFS', {}).get('Layers', [])
    newer = target.get('RootFS', {}).get('Layers', [])
    if (target.get('Id') != target_id or target.get('Os') != 'linux' or target.get('Architecture') != 'amd64'
            or not layers or len(newer) <= len(layers) or newer[:len(layers)] != layers
            or any(target.get('Config', {}).get(key) != source.get('Config', {}).get(key)
                   for key in ('Env', 'Entrypoint', 'Labels', 'WorkingDir', 'User'))):
        raise ValueError('target image is not a compatible immutable overlay')


def copy_private(source, target):
    before = h._private_file_proof(str(source))
    reader = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    writer = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        while True:
            block = os.read(reader, 1024 * 1024)
            if not block: break
            remainder = memoryview(block)
            while remainder:
                written = os.write(writer, remainder)
                if written <= 0: raise OSError('private backup write failed')
                remainder = remainder[written:]
        os.fsync(writer)
    finally:
        os.close(reader); os.close(writer)
    if h._private_file_proof(str(source)) != before or h._private_file_proof(str(target))['sha256'] != before['sha256']:
        raise ValueError('private backup source changed')
    return before


def persist_directory(path):
    with h.directory_handle(str(path), secure_ancestors=True) as directory:
        os.fsync(directory)


def replace_self(path, expected, replacement, temporary):
    if h.read_json(path) != expected: raise ValueError('controller self record changed')
    h.new_json(temporary, replacement)
    if h.read_json(path) != expected: raise ValueError('controller self record changed')
    os.replace(temporary, path)
    with h.directory_handle(str(pathlib.Path(path).parent), secure_ancestors=True) as directory:
        os.fsync(directory)


def offline_maintenance(record, verify_update, current=None, resume=False):
    """Host-administrator audit write under the real native update lease.

    BEGIN IMMEDIATE makes the idle check and admission pause atomic with the
    Go controller's SQL admission transactions. No NAS identity is fabricated.
    """
    p = record['plan']; path = pathlib.Path(p['root'])/'metadata/store/store.sqlite'
    if h._HELD_CLONE_LEASES.get(verify_update) != ('update.lock', p['storage']):
        raise ValueError('held native update lease required for offline maintenance')
    verify_update()
    retained, actual = h.validate_receipt(str(pathlib.Path(p['root'])/'releases'/p['release']/'receipt.json'))
    if retained != record: raise ValueError('offline controller receipt changed')
    before = h._private_file_proof(str(path))
    connection = sqlite3.connect('file:' + urllib.parse.quote(str(path), safe='/') + '?mode=rw', uri=True, timeout=1)
    try:
        connection.execute('BEGIN IMMEDIATE')
        # The reserved writer lock excludes new jobs until the pause commits.
        h.assert_idle(path)
        try: pause = h.assert_quiesced(path)
        except ValueError as error:
            if str(error) != 'current quiesced maintenance required': raise
            pause = None  # All marker, schema and history checks already passed.
        now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')
        if resume:
            if pause is None or pause != current: raise ValueError('offline resume requires the exact pause')
            if h.evidence_time(now) < h.evidence_time(pause['createdAt']): raise ValueError('offline maintenance clock differs')
            result = {**pause, 'status':'resumed', 'resumedAt':now}
            connection.execute("UPDATE store_maintenance SET status='resumed',body=? WHERE id=? AND status='quiesced'",
                               (json.dumps(result, separators=(',', ':')), pause['id']))
        elif pause is not None:
            result = pause  # Preserve the original operator's existing pause.
        else:
            result = {'id':secrets.token_hex(24), 'requestId':'offline-update-'+secrets.token_hex(12),
                      'purpose':'store-update', 'status':'quiesced', 'createdAt':now}
            connection.execute('INSERT INTO store_maintenance(id,request_id,status,body) VALUES(?,?,?,?)',
                               (result['id'], result['requestId'], result['status'], json.dumps(result, separators=(',', ':'))))
        verify_update(); connection.commit()
    finally: connection.close()
    after = h._private_file_proof(str(path))
    if any(after[key] != before[key] for key in ('device', 'inode', 'uid')):
        raise ValueError('offline maintenance database inode changed')
    return result


def review_update(receipt, image, release, offline=False):
    record, actual = h.validate_receipt(receipt)
    p = record['plan']; db = pathlib.Path(p['root'])/'metadata/store/store.sqlite'
    if actual.get('State', {}).get('Running') is not True: raise ValueError('source controller is not running')
    try: current = h.assert_quiesced(db)
    except ValueError as error:
        if not offline or str(error) != 'current quiesced maintenance required': raise
        current = None
    h.assert_idle(db)
    h.controller_health(p, record['containerId'], record['imageId'])
    candidate = target_plan(p, release)
    if (pathlib.Path(p['root'])/'releases'/release).exists(): raise ValueError('target release already retained')
    verify_image(record['imageId'], image)
    proof = database_proof(db)
    return record, current, candidate, proof


def apply_update(receipt, image, release, offline=False, resume=False):
    if resume and not offline: raise ValueError('offline resume needs explicit offline maintenance')
    source, pause, target, live = review_update(receipt, image, release, offline)
    p = source['plan']; root = pathlib.Path(p['root']); db = root/'metadata/store/store.sqlite'
    version = root/'releases'/release; backup = version/'backup'
    self_path = root/'metadata/.space-store-container-self.json'
    old_self = h.self_record(p, source['containerId'], source['imageId'])
    with h.exclusive_update(source) as update:
        refreshed, actual = h.validate_receipt(receipt)
        if refreshed != source or actual.get('State', {}).get('Running') is not True:
            raise ValueError('source controller changed before stop')
        if offline: pause = offline_maintenance(source, update)
        h.assert_quiesced(db, pause); h.assert_idle(db); update()
        # Prepared evidence is retained even when a later step fails.
        version.mkdir(mode=0o700); backup.mkdir(mode=0o700)
        prepared = {'schema': 1, 'kind': 'in-place-controller-update', 'sourceReceipt': str(receipt),
                    'source': source, 'targetPlan': target, 'targetImageId': image,
                    'sourceReceiptProof': h._private_file_proof(str(receipt)), 'backup': str(backup),
                    'offlineMaintenance': offline, 'resumeReady': resume, 'maintenanceId': pause['id'],
                    'operatorUid': os.getuid(), 'operatorGid': os.getgid()}
        h.new_json(version/'update.json', prepared)
        persist_directory(version); persist_directory(version.parent)
        h.command(['docker', 'stop', '--time', '15', source['containerId']])
        refreshed, actual = h.validate_receipt(receipt)
        if refreshed != source or actual.get('State', {}).get('Running') is not False:
            raise ValueError('source stop unconfirmed; all evidence retained')
        with h.stopped_controller(source) as controller:
            h.assert_quiesced(db, pause, stopped=True); h.assert_idle(db, stopped=True)
            frozen = database_proof(db, stopped=True)
            if frozen['identity'] != live['identity']: raise ValueError('source root mapping changed')
            copy_private(db, backup/'store.sqlite')
            copy_private(self_path, backup/'self.json')
            copy_private(receipt, backup/'source-receipt.json')
            h.new_json(backup/'database-proof.json', frozen)
            persist_directory(backup); persist_directory(version)
            # The SQLite file remains at its original path and is never replaced.
            controller(); update(); h.assert_idle(db, stopped=True)
            cid = h.command(h.create_arguments(target, image))
            if not re.fullmatch('[0-9a-f]{64}', cid): raise ValueError('candidate ID unconfirmed')
            new_record = copy.deepcopy(source)
            new_record.update(containerId=cid, imageId=image, plan=target,
                              artifactSHA256=image.removeprefix('sha256:'), artifactKind='docker-image-config')
            actual = json.loads(h.command(['docker', 'inspect', cid]))[0]
            h.verify_owned(actual, target, cid, image)
            if actual.get('State', {}).get('Running') is not False: raise ValueError('candidate must be stopped')
            h.new_json(version/'receipt.json', new_record)
            persist_directory(version)
            replace_self(self_path, old_self, h.self_record(target, cid, image), version/'self.next.json')
            h.validate_receipt(str(version/'receipt.json')); controller(); update()
        h.command(['docker', 'start', cid])
        h.health_check(target, cid, image, version/'receipt.json')
        h.assert_quiesced(db, pause); h.assert_idle(db)
        additions = compatible_identity(frozen, database_proof(db), backup/'store.sqlite', db)
        update()
        if resume: offline_maintenance(new_record, update, pause, resume=True)
        result = {'ok': True, 'state': 'ready' if resume else 'quiesced', 'containerId': cid, 'imageId': image,
                  'storeId': frozen['identity']['storeId'], 'receipt': str(version/'receipt.json'),
                  'backup': str(backup), 'previousContainerId': source['containerId'], 'schemaAdditions': additions}
        h.new_json(version/'switch-result.json', result)
        persist_directory(version)
        return result


def complete_update(update_path, offline=False, resume=False):
    """Complete an already-created healthy candidate; never replay deployment."""
    if resume and not offline: raise ValueError('offline resume needs explicit offline maintenance')
    prepared = h.read_json(update_path)
    if prepared.get('schema') != 1 or prepared.get('kind') != 'in-place-controller-update':
        raise ValueError('unknown retained update')
    version = pathlib.Path(update_path).parent
    record, actual = h.validate_receipt(str(version/'receipt.json'))
    source = prepared['source']; p = record['plan']; root = pathlib.Path(p['root'])
    if (prepared['targetPlan'] != p or prepared['targetImageId'] != record['imageId']
            or str(version) != str(root/'releases'/p['release'])
            or actual.get('State', {}).get('Running') is not True
            or h._private_file_proof(prepared['sourceReceipt']) != prepared['sourceReceiptProof']):
        raise ValueError('retained running candidate identity changed')
    original = json.loads(h.command(['docker', 'inspect', source['containerId']]))[0]
    h.verify_owned(original, source['plan'], source['containerId'], source['imageId'])
    if original.get('State', {}).get('Running') is not False: raise ValueError('previous controller must be stopped')
    h.controller_health(p, record['containerId'], record['imageId'])
    result_path = version/'switch-result.json'
    if result_path.exists():
        result = h.read_json(result_path)
        if (result.get('ok') is not True or result.get('containerId') != record['containerId']
                or result.get('imageId') != record['imageId'] or result.get('previousContainerId') != source['containerId']
                or result.get('state') not in ('ready', 'quiesced')):
            raise ValueError('retained switch result differs')
        return result
    backup = pathlib.Path(prepared['backup'])
    if backup != version/'backup' or h.read_json(backup/'source-receipt.json') != source:
        raise ValueError('retained source backup differs')
    frozen = h.read_json(backup/'database-proof.json')
    if database_proof(backup/'store.sqlite', stopped=True) != frozen: raise ValueError('database backup differs')
    db = root/'metadata/store/store.sqlite'
    with h.exclusive_update(record) as update:
        refreshed, observed = h.validate_receipt(str(version/'receipt.json'))
        if refreshed != record or observed.get('State', {}).get('Running') is not True:
            raise ValueError('running candidate changed during completion')
        h.controller_health(p, record['containerId'], record['imageId'])
        pause = h.assert_quiesced(db)
        if pause['id'] != prepared.get('maintenanceId'): raise ValueError('original update pause changed')
        h.assert_idle(db)
        additions = compatible_identity(frozen, database_proof(db), backup/'store.sqlite', db)
        update()
        if resume: offline_maintenance(record, update, pause, resume=True)
        result = {'ok': True, 'state': 'ready' if resume else 'quiesced', 'containerId': record['containerId'],
                  'imageId': record['imageId'], 'storeId': frozen['identity']['storeId'],
                  'receipt': str(version/'receipt.json'), 'backup': str(backup),
                  'previousContainerId': source['containerId'], 'schemaAdditions': additions}
        h.new_json(result_path, result); persist_directory(version)
        return result


def rollback_update(update_path, offline=False, resume=False):
    if resume and not offline: raise ValueError('offline resume needs explicit offline maintenance')
    prepared = h.read_json(update_path)
    if prepared.get('schema') != 1 or prepared.get('kind') != 'in-place-controller-update':
        raise ValueError('unknown retained update')
    version = pathlib.Path(update_path).parent
    record, actual = h.validate_receipt(str(version/'receipt.json'))
    source = prepared['source']; p = record['plan']; root = pathlib.Path(p['root'])
    if (prepared['targetPlan'] != p or prepared['targetImageId'] != record['imageId']
            or str(version) != str(root/'releases'/p['release'])
            or h._private_file_proof(prepared['sourceReceipt']) != prepared['sourceReceiptProof']):
        raise ValueError('retained update identity changed')
    original = json.loads(h.command(['docker', 'inspect', source['containerId']]))[0]
    h.verify_owned(original, source['plan'], source['containerId'], source['imageId'])
    if original.get('State', {}).get('Running') is not False: raise ValueError('previous controller must be stopped')
    backup = pathlib.Path(prepared['backup'])
    if backup != version/'backup' or h.read_json(backup/'source-receipt.json') != source:
        raise ValueError('retained backup differs')
    frozen = h.read_json(backup/'database-proof.json')
    if database_proof(backup/'store.sqlite', stopped=True) != frozen: raise ValueError('database backup differs')
    db = root/'metadata/store/store.sqlite'
    try: pause = h.assert_quiesced(db)
    except ValueError as error:
        if not offline or str(error) != 'current quiesced maintenance required': raise
        pause = None
    h.assert_idle(db)
    compatible_identity(frozen, database_proof(db), backup/'store.sqlite', db)
    with h.exclusive_update(record) as update:
        h.validate_receipt(str(version/'receipt.json'))
        if offline: pause = offline_maintenance(record, update)
        h.assert_quiesced(db, pause); h.assert_idle(db); update()
        if actual.get('State', {}).get('Running') is True:
            h.command(['docker', 'stop', '--time', '15', record['containerId']])
        current = json.loads(h.command(['docker', 'inspect', record['containerId']]))[0]
        h.verify_owned(current, p, record['containerId'], record['imageId'])
        if current.get('State', {}).get('Running') is not False: raise ValueError('candidate stop unconfirmed')
        with h.stopped_controller(record) as controller:
            h.assert_quiesced(db, pause, stopped=True); h.assert_idle(db, stopped=True)
            compatible_identity(frozen, database_proof(db, stopped=True), backup/'store.sqlite', db, stopped=True)
            copy_private(db, version/'rollback-current.sqlite')
            persist_directory(version)
            expected = h.self_record(p, record['containerId'], record['imageId'])
            restored = h.self_record(source['plan'], source['containerId'], source['imageId'])
            if h.read_json(backup/'self.json') != restored: raise ValueError('previous self record backup differs')
            replace_self(root/'metadata/.space-store-container-self.json', expected, restored, version/'self.rollback.json')
            h.validate_receipt(prepared['sourceReceipt']); controller(); update()
        h.command(['docker', 'start', source['containerId']])
        h.health_check(source['plan'], source['containerId'], source['imageId'], prepared['sourceReceipt'])
        h.assert_quiesced(db, pause); h.assert_idle(db); update()
        if resume: offline_maintenance(source, update, pause, resume=True)
        result = {'ok': True, 'state': 'ready' if resume else 'quiesced', 'containerId': source['containerId'],
                  'imageId': source['imageId'], 'storeId': frozen['identity']['storeId']}
        h.new_json(version/'rollback-result.json', result)
        persist_directory(version)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--alias')
    parser.add_argument('--remote', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--receipt')
    parser.add_argument('--image-id')
    parser.add_argument('--release')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--offline-maintenance', action='store_true', help='Authorized SSH administrator writes audited pause under native lease; no NAS session')
    parser.add_argument('--resume-offline', action='store_true', help='Explicitly restore ready after successful verification')
    parser.add_argument('--rollback-update')
    parser.add_argument('--complete-update', help='Finish verification of an existing running candidate; never reapply or replace backups')
    args = parser.parse_args()
    if args.resume_offline and not args.offline_maintenance: parser.error('resume-offline requires offline-maintenance')
    if args.rollback_update or args.complete_update:
        if args.rollback_update and args.complete_update: parser.error('complete and rollback are separate operations')
        h.canonical(args.rollback_update or args.complete_update)
        if args.receipt or args.image_id or args.release or args.apply: parser.error('rollback cannot combine update arguments')
    else:
        if not all((args.receipt, args.image_id, args.release)): parser.error('receipt, image-id and release are required')
        h.canonical(args.receipt)
        if not re.fullmatch('sha256:[0-9a-f]{64}', args.image_id) or not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}', args.release): parser.error('invalid image/release')
    if args.remote:
        if args.complete_update: result = complete_update(args.complete_update, args.offline_maintenance, args.resume_offline)
        elif args.rollback_update: result = rollback_update(args.rollback_update, args.offline_maintenance, args.resume_offline)
        elif args.apply: result = apply_update(args.receipt, args.image_id, args.release, args.offline_maintenance, args.resume_offline)
        else:
            record, pause, target, proof = review_update(args.receipt, args.image_id, args.release, args.offline_maintenance)
            result = {'state':'review', 'sourceContainerId':record['containerId'], 'sourceImageId':record['imageId'],
                      'targetImageId':args.image_id, 'targetContainerName':target['name'],
                      'storeId':proof['identity']['storeId'], 'metadata':target['root']+'/metadata',
                      'storage':target['storage'], 'port':target['port'], 'maintenanceId':pause['id'] if pause else None,
                      'offlineMaintenance':args.offline_maintenance, 'resumeReady':args.resume_offline}
        print(json.dumps(result)); return
    if not args.alias or not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9._-]*', args.alias): parser.error('usable sshbind alias required')
    servers = json.loads(h.command(['sshbind','list','--json']))['servers']
    if sum(s.get('name') == args.alias and s.get('usable') is True for s in servers) != 1: raise ValueError('sshbind alias unavailable')
    task_root = pathlib.Path(__file__).resolve().parent
    # Compress public source only; no server credentials or session tokens travel.
    pack = lambda value: base64.b64encode(zlib.compress(value)).decode()
    host_source = pack((task_root/'store-container-host.py').read_bytes())
    updater_source = pack(pathlib.Path(__file__).read_bytes())
    argv = ['update-store-controller.py','--remote']
    if args.complete_update: argv += ['--complete-update',args.complete_update]
    elif args.rollback_update: argv += ['--rollback-update',args.rollback_update]
    else:
        argv += ['--receipt',args.receipt,'--image-id',args.image_id,'--release',args.release]
        if args.apply: argv += ['--apply']
    if args.offline_maintenance: argv += ['--offline-maintenance']
    if args.resume_offline: argv += ['--resume-offline']
    remote = ('import base64,zlib,types,sys; container_host=types.ModuleType("container_host"); '
              'exec(zlib.decompress(base64.b64decode('+repr(host_source)+')),container_host.__dict__); '
              'sys.argv='+repr(argv)+'; exec(zlib.decompress(base64.b64decode('+repr(updater_source)+')))')
    command = 'python3 -c ' + h.shlex.quote(remote)
    raw = h.command(['sshbind','exec','--json',args.alias,command])
    response = json.loads(raw)
    if response.get('exit_code') != 0: raise ValueError('remote update refused; resources retained')
    # Only bounded results leave the remote process; never its command/source.
    print(response['stdout'].strip())


if __name__ == '__main__':
    try: main()
    except (ValueError,OSError,KeyError,sqlite3.Error,subprocess.SubprocessError):
        sys.exit('Controller update stopped; all files, images and containers retained. Inspect the version receipt and service status before continuing.')
