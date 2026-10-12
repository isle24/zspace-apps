import copy
import unittest

from runtime_host_test import GuardTests, h


class CloudPermissions(GuardTests):
    def test_cloud_container_requires_restricted_permissions_on_readback(self):
        self.g['appId'] = 'cloud-test-app'
        self.g['recipe']['appId'] = 'cloud-test-app'
        container, _, _, service, record = self.fixture()
        container['HostConfig']['CapDrop'] = ['ALL']
        container['HostConfig']['SecurityOpt'] = ['no-new-privileges']
        self.assertEqual('exited', h.check_container(self.g, service, record)['State']['Status'])
        for field, value in [('CapDrop', []), ('SecurityOpt', []), ('Privileged', True), ('NetworkMode', 'host')]:
            previous = copy.deepcopy(container['HostConfig'])
            container['HostConfig'][field] = value
            with self.assertRaises(ValueError):
                h.check_container(self.g, service, record)
            container['HostConfig'] = previous


if __name__ == '__main__':
    unittest.main()
