import json
import os
import pathlib
import unittest

from runtime_host_test import GuardTests, h


class SecretGuard(GuardTests):
    def tearDown(self):
        h.runtime_secret_values = {}
        h.runtime_secret_scope = None
        super().tearDown()

    def secret_fixture(self):
        self.g['appId'] = 'cloud-test-app'
        self.g['secretSetId'] = 'a' * 48
        self.g['recipe']['services'][0]['environment'] = {'APP_PASSWORD': '$secret:app-password'}
        container, _, _, service, record = self.fixture()
        container['HostConfig']['CapDrop'] = ['ALL']
        container['HostConfig']['SecurityOpt'] = ['no-new-privileges']
        container['Config']['Env'].append('APP_PASSWORD=synthetic-private-value')
        config = {key: self.g[key] for key in ['storeId', 'instanceId', 'recipeRevision']}
        config.update(secretSetId=self.g['secretSetId'], generationId=self.g['id'], environment={'APP_PASSWORD': 'synthetic-private-value'})
        path = pathlib.Path(self.root, 'private-env.json')
        path.write_text(json.dumps(config))
        path.chmod(0o600)
        return path, config, container, service, record

    def test_secret_file_permissions_scope_and_exact_readback(self):
        path, config, container, service, record = self.secret_fixture()
        h.load_secret_config(self.g, str(path))
        self.assertEqual('synthetic-private-value', h.secret_environment(self.g, service)['APP_PASSWORD'])
        h.check_container(self.g, service, record)
        container['Config']['Env'][-1] = 'APP_PASSWORD=wrong-secret'
        with self.assertRaises(ValueError):
            h.check_container(self.g, service, record)
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            h.load_secret_config(self.g, str(path))
        path.chmod(0o600)
        config['instanceId'] = 'foreign'
        path.write_text(json.dumps(config))
        with self.assertRaises(ValueError):
            h.load_secret_config(self.g, str(path))

    def test_secret_logs_are_redacted(self):
        path, _, _, _, _ = self.secret_fixture()
        h.load_secret_config(self.g, str(path))
        self.assertEqual('password=[redacted]', h.redact_secret_logs(self.g, 'password=synthetic-private-value'))


if __name__ == '__main__':
    unittest.main()
