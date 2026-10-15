import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('shop_ui_origin', Path(__file__).with_name('bootstrap.py'))
shop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shop)


class CombinedOriginTests(unittest.TestCase):
    def setUp(self):
        self.env = {'NAS_IP': '192.168.3.56'}
        self.info = {'DockerRootDir': '/data_disk/docker', 'OSType': 'linux', 'Architecture': 'amd64', 'ServerVersion': '27.3.1', 'Driver': 'overlay2'}

    def test_explicit_ui_origin_reaches_managed_gateway_allowlist(self):
        config = shop.configuration({**self.env, 'SHOP_UI_ORIGIN': 'http://192.168.3.56:18436'}, self.info, '/control/source')
        plan = shop.runtime_plan(config, 989)
        self.assertIn('--public-origin', plan['command'])
        self.assertEqual(plan['command'][plan['command'].index('--public-origin') + 1], 'http://192.168.3.56:18436')
        self.assertNotIn('--nas-admin-only', plan['command'])

    def test_default_standalone_plan_does_not_gain_extra_trusted_origin(self):
        config = shop.configuration(self.env, self.info, '/control/source')
        self.assertNotIn('--public-origin', shop.runtime_plan(config, 989)['command'])

    def test_ui_origin_must_be_bare_and_have_no_credentials(self):
        for value in ['*', 'http://user:pass@192.168.3.56:18436', 'http://192.168.3.56:18436/path', 'http://192.168.3.56:18436?q=x', 'http://192.168.3.56:18436#x', 'ftp://192.168.3.56:18436', 'http://192.168.3.56:18436\n']:
            with self.subTest(origin=value), self.assertRaises(ValueError):
                shop.configuration({**self.env, 'SHOP_UI_ORIGIN': value}, self.info, '/control/source')


if __name__ == '__main__':
    unittest.main()
