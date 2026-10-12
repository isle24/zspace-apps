import importlib.util
import io
import pathlib
import runpy
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

PATH = pathlib.Path(__file__).with_name('transfer-store-sshbind.py')


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(PATH.exists(), 'sshbind-only transport helper is missing')
        spec = importlib.util.spec_from_file_location('transport', PATH)
        self.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.helper)

    def test_exact_bytes_and_remote_command(self):
        artifact = bytes(range(256)) * 1024
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'release.tar.gz'
            path.write_bytes(artifact)
            seen = []
            def runner(argv, **kwargs):
                seen.append(argv)
                self.assertEqual(argv[:5], ['sshbind', 'exec', '--timeout', '300', 'nas'])
                # Exercise the real remote downloader against the local server.
                result = subprocess.run(['bash', '-c', argv[5]], capture_output=True)
                self.assertEqual(result.stdout, artifact)
                self.assertEqual(result.returncode, 0, result.stderr)
                return result
            self.helper.transfer('nas', '127.0.0.1', path, 'cat', runner=runner)
            self.assertEqual(len(seen), 1)

    def test_unknown_path_and_foreign_peer_denied(self):
        with self.helper.artifact_server(b'payload', '127.0.0.1', '127.0.0.1') as url:
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(url + '/unknown')
            self.assertEqual(error.exception.code, 404)
        with self.helper.artifact_server(b'payload', '127.0.0.1', '127.0.0.2') as url:
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(url)
            self.assertEqual(error.exception.code, 403)

    def test_runner_failure_closes_server(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'archive'
            path.write_bytes(b'payload')
            urls = []
            original = self.helper.remote_command
            def command(url, *args):
                urls.append(url)
                return original(url, *args)
            self.helper.remote_command = command
            def runner(*args, **kwargs):
                raise RuntimeError('runner failed')
            with self.assertRaisesRegex(RuntimeError, 'runner failed'):
                self.helper.transfer('nas', '127.0.0.1', path, 'cat', runner=runner)
            with self.assertRaises(urllib.error.URLError):
                urllib.request.urlopen(urls[0], timeout=1)

    def test_unsafe_local_artifacts_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'archive'
            path.write_bytes(b'oversize')
            link = pathlib.Path(directory) / 'link'
            link.symlink_to(path)
            for candidate in [link, pathlib.Path(directory)]:
                with self.assertRaises((ValueError, OSError)):
                    self.helper.read_artifact(candidate)
            with self.assertRaises(ValueError):
                self.helper.read_artifact(path, limit=2)

    def test_remote_download_bounded_and_deploy_exit_preserved(self):
        with self.helper.artifact_server(b'payload', '127.0.0.1', '127.0.0.1') as url:
            result = subprocess.run(['bash', '-c', self.helper.remote_command(url, 2, 'cat')], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            result = subprocess.run(['bash', '-c', self.helper.remote_command(url, 7, 'exit 23')], capture_output=True)
            self.assertEqual(result.returncode, 23)

    def test_existing_remote_checksum_guard_rejects_before_archive_write(self):
        definitions = runpy.run_path(str(PATH.with_name('deploy-store-ssh.test.py')))['remote']
        with patch.dict(definitions, preflight=lambda *args: None), patch.object(definitions['sys'], 'stdin', io.TextIOWrapper(io.BytesIO(b'wrong archive'))):
            with self.assertRaisesRegex(definitions['DeploymentError'], 'checksum differs; no release was written'):
                definitions['deploy']('/unused', '/unused', 'release', 18435, 'disabled', '0.0.0.0', 'nas', '', '', '0' * 64)

    def test_cli_preserves_remote_exit_and_controlled_diagnostic(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact = pathlib.Path(directory) / 'archive'
            artifact.write_bytes(b'payload')
            transfer = self.helper.transfer
            for status in (23, 255):
                with self.subTest(status=status), patch.object(self.helper.sys, 'argv', ['transfer', 'nas', '127.0.0.1', str(artifact), 'private-command']), patch.object(self.helper, 'transfer', side_effect=lambda *args: transfer(*args, runner=lambda *a, **kw: subprocess.CompletedProcess([], status))), patch('sys.stderr', new_callable=io.StringIO) as stderr:
                    with self.assertRaises(SystemExit) as stopped:
                        self.helper.main()
                    self.assertEqual(stopped.exception.code, status)
                    self.assertEqual(stderr.getvalue(), 'Transfer stopped: sshbind deployment failed (exit %s)\n' % status)

    def test_cli_timeout_keeps_controlled_failure(self):
        with patch.object(self.helper.sys, 'argv', ['transfer', 'nas', '127.0.0.1', 'unused', 'private-command']), patch.object(self.helper, 'transfer', side_effect=subprocess.TimeoutExpired(['sshbind', 'exec', 'nas', 'private-command http://private-token'], 315)):
            with self.assertRaises(SystemExit) as stopped:
                self.helper.main()
            self.assertEqual(stopped.exception.code, 'Transfer stopped: sshbind deployment timed out')

    def test_no_direct_ssh_or_scp_runner(self):
        source = PATH.read_text()
        self.assertNotIn("['ssh',", source)
        self.assertNotIn("['scp',", source)
        deploy_source = PATH.with_name('deploy-store-ssh.sh').read_text()
        self.assertIn('python3 "$task_root/scripts/transfer-store-sshbind.py"', deploy_source)
        self.assertNotIn('ssh -o BatchMode=yes -o ConnectTimeout=15 "$task_alias" "$task_deploy_command"', deploy_source)


if __name__ == '__main__':
    unittest.main()
