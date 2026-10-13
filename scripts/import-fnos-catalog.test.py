import importlib.util
import json
import pathlib
import tempfile
import types
import unittest

ROOT=pathlib.Path(__file__).resolve().parent
importer=types.SimpleNamespace()
if (ROOT/'import-fnos-catalog.py').exists():
    spec=importlib.util.spec_from_file_location('fnos_importer',ROOT/'import-fnos-catalog.py')
    importer=importlib.util.module_from_spec(spec);spec.loader.exec_module(importer)


class FnosCatalogImport(unittest.TestCase):
    def source(self, root, slug, compose=''):
        directory=pathlib.Path(root)/'apps'/slug/'fnos';directory.mkdir(parents=True)
        (directory/'manifest').write_text('appname = '+slug+'\nversion = 0.0.0\n')
        if compose:
            (directory/'docker').mkdir();(directory/'docker/docker-compose.yaml').write_text(compose)

    def app(self, slug='demo', kind='docker'):
        return {'slug':slug,'appname':slug,'display_name':'示例应用','description':'来源应用描述','version':'1.2.3',
                'app_type':kind,'category':'system','service_port':8080,'platforms':['x86','arm'],
                'icon_url':'https://raw.githubusercontent.com/conversun/fnos-apps/main/apps/'+slug+'/fnos/ICON_256.PNG'}

    def test_single_service_preserves_real_image_port_and_managed_data(self):
        self.assertTrue(callable(getattr(importer,'convert_app',None)), 'Missing source-faithful fnOS catalog importer')
        with tempfile.TemporaryDirectory() as root:
            self.source(root,'demo','''services:
  app:
    image: ${DOCKER_MIRROR}docker.io/vendor/demo:${VERSION}
    ports: ["${TRIM_SERVICE_PORT}:8080"]
    volumes: ["${TRIM_PKGVAR:?}/data:/data"]
    environment: {TZ: Asia/Shanghai}
''')
            draft, provenance=importer.convert_app(self.app(),pathlib.Path(root))
            self.assertEqual(draft['image'],'docker.io/vendor/demo:1.2.3')
            self.assertEqual(draft['containerPort'],8080)
            self.assertEqual(draft['dataTargets'],['/data'])
            self.assertEqual(provenance['status'],'candidate')
            self.assertFalse(draft['published'])
            self.assertIn(importer.PINNED_COMMIT,draft['icon'])

    def test_native_has_no_fabricated_container(self):
        self.assertTrue(callable(getattr(importer,'convert_app',None)), 'Missing source-faithful fnOS catalog importer')
        with tempfile.TemporaryDirectory() as root:
            self.source(root,'1panel')
            draft, provenance=importer.convert_app(self.app('1panel','native'),pathlib.Path(root))
            self.assertEqual(draft['id'],'fnos-1panel')
            self.assertEqual(draft['image'],'')
            self.assertEqual(draft['containerPort'],0)
            self.assertEqual(draft['dataTargets'],[])
            self.assertEqual(draft['environment'],[])
            self.assertEqual(provenance['status'],'native-pending')
            self.assertIn('原生 FPK',draft['description'])

    def test_multi_service_and_privileged_are_not_silently_flattened(self):
        self.assertTrue(callable(getattr(importer,'convert_app',None)), 'Missing source-faithful fnOS catalog importer')
        with tempfile.TemporaryDirectory() as root:
            self.source(root,'demo','''services:
  app:
    image: vendor/demo:1.2.3
    ports: ["8080:8080"]
    privileged: true
    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]
  database:
    image: postgres:17
    environment: {POSTGRES_PASSWORD: synthetic-source-password}
''')
            draft, provenance=importer.convert_app(self.app(),pathlib.Path(root))
            self.assertEqual(provenance['status'],'blocked')
            self.assertEqual(len(provenance['compose']['services']),2)
            self.assertEqual(draft['image'],'')
            self.assertEqual(draft['containerPort'],0)
            self.assertNotIn('synthetic-source-password',json.dumps(provenance))
            self.assertTrue(provenance['blockers'])

    def test_sql_is_atomic_insert_only_and_keeps_published_null(self):
        self.assertTrue(callable(getattr(importer,'render_sql',None)), 'Missing idempotent fnOS SQL renderer')
        app={'id':'demo','name':"O'Brien",'description':'说明','category':'tools','icon':'','image':'',
             'version':'1.2.3','containerPort':0,'dataTargets':[],'environment':[],'published':False,'releaseNumber':0}
        sql=importer.render_sql([app],['immich','jellyfin','memos','nasreader','navidrome','syncthing','uptime-kuma'])
        self.assertIn('\\set ON_ERROR_STOP on',sql)
        self.assertIn('BEGIN;',sql)
        self.assertIn('SET LOCAL standard_conforming_strings = on;',sql)
        self.assertIn('ON CONFLICT (id) DO NOTHING',sql)
        self.assertIn('published_json',sql)
        self.assertIn('NULL, 1',sql)
        self.assertNotIn('DO UPDATE',sql)
        self.assertIn('row_hash',sql)
        self.assertIn('COMMIT;',sql)

    def test_encryption_and_setup_keys_are_secret_parameters_not_defaults(self):
        with tempfile.TemporaryDirectory() as root:
            self.source(root,'demo','''services:
  app:
    image: vendor/demo:1.2.3
    ports: ["8080:8080"]
    environment: {ENCRYPTION_KEY: synthetic-private-key, NB_SETUP_KEY: synthetic-setup-key}
''')
            draft, provenance=importer.convert_app(self.app(),pathlib.Path(root))
            self.assertNotIn('synthetic-private-key',json.dumps(draft)+json.dumps(provenance))
            self.assertNotIn('synthetic-setup-key',json.dumps(draft)+json.dumps(provenance))
            self.assertTrue(all(e['secret'] and 'default' not in e for e in draft['environment']))


if __name__=='__main__':unittest.main()
