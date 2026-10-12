"""Synthetic process and local socket fixtures; no SSH or NAS file writes."""
import ast
import builtins
import errno
import io
import json
import os
import tempfile
from pathlib import Path
import re
import socket
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("deploy-store-ssh.sh")
SOURCE = SCRIPT.read_text()
BLOCKS = re.findall(r"<<'PY'\n(.*?)\nPY", SOURCE, re.S)
COMMON = next((block for block in BLOCKS if 'def validate_nas_origin(' in block), '')
common_start = SOURCE.index("task_nas_validator=$(cat <<'PY'")
common_end = SOURCE.index('\nPY\n)', common_start) + len('\nPY\n)')
remote_start = SOURCE.index("task_remote_python=$(cat <<'PY'")
remote_end = SOURCE.index('\n\n', SOURCE.index('task_remote_python="$task_nas_validator"', remote_start))
assembly = SOURCE[common_start:common_end] + '\n' + SOURCE[remote_start:remote_end] + "\nprintf '%s' \"$task_remote_python\"\n"
REMOTE = subprocess.check_output(['bash', '-c', assembly], text=True)
local_validator = {}
exec(compile(COMMON, str(SCRIPT) + ':shared-validator', 'exec'), local_validator)
tree = ast.parse(REMOTE)
definitions = ast.Module(body=[node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.ClassDef))], type_ignores=[])
remote = {}
exec(compile(definitions, str(SCRIPT) + ":fixture-definitions", "exec"), remote)
PROBE_FORMATTER = SOURCE.split('task_probe="$(sshbind', 1)[1].split("python3 -c '\n", 1)[1].split("\n')\"", 1)[0]


class ProcessFixtureTests(unittest.TestCase):
    root = "/synthetic/store"
    metadata = root + "/metadata"
    storage = root
    pid = 431937
    ticks = "987654321"
    executable = root + "/releases/synthetic/space-store"

    def check(self, state, identity_matches=True, recorded=True, ticks=None, nas_origin=None, nas_arguments=()):
        # Linux /proc stat field 22 is index 19 after the process name.
        fields = [state] + ["0"] * 18 + [ticks or self.ticks]
        process_stat = f"{self.pid} (space-store) " + " ".join(fields)
        record = {"service": "space-store", "pid": self.pid, "startTicks": self.ticks, "executable": self.executable, "dataDir": self.metadata, "storageRoot": self.storage}
        if nas_origin is not None:
            record["nasOrigin"] = nas_origin
        arguments = [self.executable, "--data-dir", self.metadata, "--storage-root", self.storage] + list(nas_arguments)
        command = ("\0".join(arguments) + "\0").encode() if state != "Z" else b""

        def opened(path, *args, **kwargs):
            if path == f"/proc/{self.pid}/stat":
                return io.StringIO(process_stat)
            if path == f"/proc/{self.pid}/cmdline":
                return io.BytesIO(command)
            raise AssertionError("Unexpected fixture read: " + str(path))

        def listed(path):
            if path == self.root + "/run":
                return ["synthetic.json"]
            if path == "/proc":
                return [str(self.pid)]
            raise AssertionError("Unexpected fixture directory: " + str(path))

        with patch.dict(remote, {"directory": lambda *_: None, "read_json": lambda _: record}), \
             patch.object(builtins, "open", opened), \
             patch.object(remote["os"], "getuid", return_value=1001), \
             patch.object(remote["os"], "stat", return_value=SimpleNamespace(st_uid=1001)), \
             patch.object(remote["os"], "listdir", side_effect=listed), \
             patch.object(remote["os"].path, "lexists", return_value=recorded), \
             patch.object(remote["os"].path, "realpath", return_value=self.executable if identity_matches else f"/proc/{self.pid}/exe") as executable_lookup:
            remote["check_processes"](self.root, self.metadata, self.storage)
            return executable_lookup.call_count

    def test_nas_provider_record_checks_effective_arguments_and_disabled_default(self):
        for recorded, arguments in (('', ['--nas-origin', 'https://other.example']), ('https://nas.example', ['--nas-origin', 'https://nas.example', '--nas-origin=https://other.example'])):
            with self.subTest(recorded=recorded), self.assertRaisesRegex(RuntimeError, 'Live process configuration differs'):
                self.check('S', nas_origin=recorded, nas_arguments=arguments)
        with self.assertRaisesRegex(RuntimeError, 'Store is already running'):
            self.check('S', nas_origin='https://nas.example', nas_arguments=['--nas-origin', 'https://nas.example'])

    def test_remote_record_revalidates_nas_origin_even_for_exited_process(self):
        with self.assertRaisesRegex(ValueError, 'NAS origin must be a canonical'):
            self.check('Z', nas_origin='http://user:synthetic-private-secret@host')

    def test_recorded_zombie_does_not_require_live_executable_identity(self):
        self.assertEqual(self.check("Z", identity_matches=False), 0)

    def test_unrecorded_zombie_is_not_a_running_store(self):
        self.assertEqual(self.check("Z", identity_matches=False, recorded=False), 0)

    def test_live_matching_process_still_blocks_duplicate_deployment(self):
        with self.assertRaisesRegex(RuntimeError, "Store is already running"):
            self.check("S")

    def test_live_identity_mismatch_is_not_skipped(self):
        for state in ("R", "S", "T"):
            with self.subTest(state=state), self.assertRaisesRegex(RuntimeError, "Live process identity differs"):
                self.check(state, identity_matches=False)


class DiagnosticFormatterTests(unittest.TestCase):
    def formatted(self, stderr):
        result = {"exit_code": 1, "command": "sensitive command sentinel", "stdout": "secret stdout sentinel", "stderr": stderr}
        return subprocess.run([sys.executable, "-c", PROBE_FORMATTER], input=json.dumps(result), capture_output=True, text=True)

    def test_reports_controlled_remote_reason_without_command_stdout_or_shell_noise(self):
        result = self.formatted("synthetic shell noise\nDeployment stopped: Store is already running (PID 431937); process, metadata and releases preserved\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Store is already running (PID 431937)", result.stderr)
        for forbidden in ("sensitive command sentinel", "secret stdout sentinel", "synthetic shell noise"):
            self.assertNotIn(forbidden, result.stderr + result.stdout)

    def test_unknown_remote_stderr_stays_opaque(self):
        for stderr in ("untrusted command and private host content sentinel\n", "Deployment stopped: private host content sentinel\n", "Deployment stopped: Command [private host content sentinel] returned nonzero exit status\n"):
            with self.subTest(stderr=stderr):
                result = self.formatted(stderr)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Remote preflight failed", result.stderr)
                self.assertNotIn("private host content sentinel", result.stderr + result.stdout)


class SocketPreflightFixtureTests(unittest.TestCase):
    def test_allows_rebind_after_real_orderly_tcp_close(self):
        # Emulate Go's listener option, then actively close the accepted socket.
        # FIN/EOF in both directions creates a real kernel TIME_WAIT connection.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.settimeout(2)
            listener.bind(("0.0.0.0", 0))
            listener.listen(1)
            port = listener.getsockname()[1]
            with socket.create_connection(("127.0.0.1", port), timeout=2) as client:
                connection, _ = listener.accept()
                with connection:
                    connection.settimeout(2)
                    connection.shutdown(socket.SHUT_WR)
                    self.assertEqual(client.recv(1), b"")
                    client.shutdown(socket.SHUT_WR)
                    self.assertEqual(connection.recv(1), b"")
        # Prove this fixture needs REUSEADDR, rather than silently testing a free port.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as plain:
            with self.assertRaises(OSError) as rejected:
                plain.bind(("0.0.0.0", port))
            self.assertEqual(rejected.exception.errno, errno.EADDRINUSE)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reusable:
            reusable.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            reusable.bind(("0.0.0.0", port))
            reusable.listen(1)
        remote["port_available"](port)

    def test_rejects_a_real_live_listener_even_when_it_uses_reuseaddr(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("0.0.0.0", 0))
            listener.listen(1)
            with self.assertRaisesRegex(RuntimeError, "Chosen port is occupied"):
                remote["port_available"](listener.getsockname()[1])



class NASProviderConfigurationTests(unittest.TestCase):
    def test_cli_invalid_origin_is_rejected_before_any_server_contact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root / 'contacted'
            for command in ('sshbind', 'ssh', 'pnpm', 'go'):
                stub = root / command
                stub.write_text('#!/bin/sh\nprintf contacted >> "$NAS_TEST_MARKER"\nexit 97\n')
                stub.chmod(0o700)
            environment = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'], NAS_TEST_MARKER=str(marker))
            for origin in ('http://user:synthetic-private-secret@host', 'http://HOST', 'http://host/', 'http://host:0'):
                result = subprocess.run(['bash', str(SCRIPT), '--alias', 'synthetic', '--deploy-root', '/synthetic/store', '--storage-root', '/synthetic/storage', '--nas-origin', origin], env=environment, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('NAS origin must be a canonical bare HTTP(S) origin', result.stderr)
                self.assertNotIn('synthetic-private-secret', result.stdout + result.stderr)
                self.assertFalse(marker.exists(), 'Invalid local NAS origin contacted a server or build tool')

    def test_one_shared_definition_is_executed_locally_and_remotely(self):
        self.assertTrue('task_nas_validator' in SOURCE, 'Local and remote origin checks still use independent implementations')
        self.assertEqual(SOURCE.count('def validate_nas_origin('), 1)
        # Run the pure shared definition directly for the local boundary, and
        # the assembled remote program for the second boundary.
        for scope in (local_validator, remote):
            self.assertEqual(scope['validate_nas_origin']('https://nas.example'), None)
            with self.assertRaisesRegex(ValueError, 'NAS origin must be a canonical'):
                scope['validate_nas_origin']('http://HOST')

    def test_remote_rejects_noncanonical_or_credential_origins(self):
        for value in ('http://user:private-secret@host', 'http://host/', 'http://host/path', 'http://host?', 'http://HOST', 'http://host:80', 'http://host:0', 'http://host:65536', 'http://0.0.0.0', 'http://[::]', 'http://host:00123', 'file:///tmp/x'):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'NAS origin must be a canonical bare HTTP\\(S\\) origin'):
                remote['validate_nas_origin'](value)

    def test_remote_accepts_only_bare_fixed_origin_or_disabled_default(self):
        for value in ('', 'https://nas.example', 'http://127.0.0.1:5055', 'http://[::1]:5055'):
            remote['validate_nas_origin'](value)

    def test_process_argument_plumbing_preserves_default_and_exact_provider(self):
        args = ('/synthetic/space-store', '0.0.0.0:18435', '/synthetic/web', '/synthetic/metadata', 'local', '/synthetic/storage', '0.0.0.0', 'nas.example', '')
        disabled = remote['store_arguments'](*args, '')
        self.assertNotIn('--nas-origin', disabled)
        configured = remote['store_arguments'](*args, 'http://127.0.0.1:5055')
        self.assertEqual(configured[-2:], ['--nas-origin', 'http://127.0.0.1:5055'])
        self.assertEqual(configured[:-2], disabled)

if __name__ == "__main__":
    unittest.main()
