import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest

ENTRYPOINT = Path(__file__).resolve().parent / 'entrypoint.sh'


class UIProcessSupervision(unittest.TestCase):
    def fixture(self, root, gateway_code=None, proxy_code=None):
        for name, code in [('space-gateway', gateway_code), ('space-proxy', proxy_code)]:
            body = '''#!/bin/sh
set -eu
service="${0##*/}"
printf ready > "$TEST_STATE/$service.started"
trap 'printf terminated > "$TEST_STATE/$service.stopped"; exit 0' TERM INT
'''
            if code is not None:
                body += 'sleep 1\nexit ' + str(code) + '\n'
            else:
                body += 'sleep 1\nsleep 1\nsleep 1\nexit 0\n'
            file = root / name
            file.write_text(body)
            file.chmod(0o700)
        return {**os.environ, 'PATH': str(root) + ':' + os.environ['PATH'],
                'TEST_STATE': str(root), 'NAS_ORIGIN': 'http://127.0.0.1:5055',
                'UI_PUBLIC_ORIGIN': 'http://127.0.0.1:18436', 'SPACE_STORE_ENDPOINT': ''}

    def run_entrypoint(self, env):
        return subprocess.run(['sh', str(ENTRYPOINT)], env=env,
                              capture_output=True, text=True, timeout=6)

    def test_gateway_failure_stops_proxy_and_preserves_nonzero_exit(self):
        with tempfile.TemporaryDirectory(prefix='ui-supervision-') as temp:
            root = Path(temp)
            result = self.run_entrypoint(self.fixture(root, gateway_code=7))
            self.assertEqual(result.returncode, 7, result.stderr)
            self.assertTrue((root / 'space-proxy.stopped').exists(), 'proxy left running after gateway failed')

    def test_proxy_failure_stops_gateway_and_preserves_nonzero_exit(self):
        with tempfile.TemporaryDirectory(prefix='ui-supervision-') as temp:
            root = Path(temp)
            result = self.run_entrypoint(self.fixture(root, proxy_code=9))
            self.assertEqual(result.returncode, 9, result.stderr)
            self.assertTrue((root / 'space-gateway.stopped').exists(), 'gateway left running after proxy failed')

    def test_unexpected_success_exit_of_gateway_still_fails_service(self):
        with tempfile.TemporaryDirectory(prefix='ui-supervision-') as temp:
            root = Path(temp)
            result = self.run_entrypoint(self.fixture(root, gateway_code=0))
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue((root / 'space-proxy.stopped').exists())

    def test_term_stops_owned_children_and_exits_successfully(self):
        for external in (False, True):
            with self.subTest(external=external), tempfile.TemporaryDirectory(prefix='ui-supervision-') as temp:
                root = Path(temp)
                env = self.fixture(root)
                if external:
                    env['SPACE_STORE_ENDPOINT'] = 'http://controller.test:18435'
                process = subprocess.Popen(['sh', str(ENTRYPOINT)], env=env,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    required = ['space-proxy.started'] + ([] if external else ['space-gateway.started'])
                    deadline = time.monotonic() + 3
                    while not all((root / name).exists() for name in required):
                        self.assertIsNone(process.poll(), 'entrypoint exited before children started')
                        if time.monotonic() >= deadline:
                            self.fail('children did not start')
                        time.sleep(.01)
                    process.send_signal(signal.SIGTERM)
                    _, stderr = process.communicate(timeout=4)
                    self.assertEqual(process.returncode, 0, stderr)
                    self.assertTrue((root / 'space-proxy.stopped').exists())
                    if external:
                        self.assertFalse((root / 'space-gateway.started').exists())
                    else:
                        self.assertTrue((root / 'space-gateway.stopped').exists())
                finally:
                    if process.poll() is None:
                        process.terminate()
                        process.communicate(timeout=4)

    def test_external_controller_only_starts_and_supervises_proxy(self):
        with tempfile.TemporaryDirectory(prefix='ui-supervision-') as temp:
            root = Path(temp)
            env = self.fixture(root, proxy_code=9)
            env['SPACE_STORE_ENDPOINT'] = 'http://controller.test:18435'
            result = self.run_entrypoint(env)
            self.assertEqual(result.returncode, 9, result.stderr)
            self.assertFalse((root / 'space-gateway.started').exists())


if __name__ == '__main__':
    unittest.main()
