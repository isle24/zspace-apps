#!/usr/bin/env python3
"""Transfer a bounded release through a temporary peer-restricted LAN endpoint."""
import argparse
import contextlib
import http.server
import os
import secrets
import shlex
import socket
import stat
import subprocess
import sys
import threading

class RemoteExit(RuntimeError):
    def __init__(self, status):
        self.status = status if 1 <= status <= 255 else 1
        super().__init__('sshbind deployment failed (exit %s)' % status)


MAX_ARCHIVE = 200 * 1024 * 1024


def read_artifact(path, limit=MAX_ARCHIVE):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as handle:
        entry = os.fstat(handle.fileno())
        if not stat.S_ISREG(entry.st_mode) or not 0 < entry.st_size <= limit:
            raise ValueError('Release artifact must be a nonempty bounded regular file')
        data = handle.read(limit + 1)
        if len(data) != entry.st_size:
            raise ValueError('Release artifact changed while reading')
        return data


def route(host):
    failures = []
    for family, _, _, _, address in socket.getaddrinfo(host, 22, type=socket.SOCK_DGRAM):
        try:
            with socket.socket(family, socket.SOCK_DGRAM) as probe:
                probe.connect(address)
                return probe.getsockname()[0], address[0]
        except OSError as error:
            failures.append(str(error))
    raise ValueError('No route to selected sshbind host: ' + '; '.join(failures))


@contextlib.contextmanager
def artifact_server(data, source_ip, target_ip):
    artifact_path = '/' + secrets.token_urlsafe(32)
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.connection.settimeout(30)
            if self.client_address[0] != target_ip:
                self.send_error(403)
                return
            if self.path != artifact_path:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (OSError, TimeoutError):
                pass

    class Server(http.server.ThreadingHTTPServer):
        address_family = socket.AF_INET6 if ':' in source_ip else socket.AF_INET
        daemon_threads = True

        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(30)
            return connection, address

    server = Server((source_ip, 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        host = '[' + source_ip + ']' if ':' in source_ip else source_ip
        yield 'http://%s:%s%s' % (host, server.server_port, artifact_path)
    finally:
        server.shutdown()
        server.server_close()
        worker.join()


def remote_command(url, size, deploy_command):
    program = '''import subprocess, sys, urllib.request
url, size, command = sys.argv[1], int(sys.argv[2]), sys.argv[3]
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
with opener.open(url, timeout=30) as response:
    if response.status != 200 or response.geturl() != url:
        sys.exit('Unexpected artifact response')
    if response.headers.get('Content-Length') != str(size):
        sys.exit('Unexpected artifact length')
    data = response.read(size + 1)
if len(data) != size:
    sys.exit('Artifact download incomplete or oversized')
sys.exit(subprocess.run(command, shell=True, input=data).returncode)
'''
    return 'python3 -c ' + ' '.join(shlex.quote(arg) for arg in (program, url, str(size), deploy_command))


def transfer(alias, host, artifact, deploy_command, runner=subprocess.run):
    data = read_artifact(artifact)
    source_ip, target_ip = route(host)
    with artifact_server(data, source_ip, target_ip) as url:
        result = runner(['sshbind', 'exec', '--timeout', '300', alias,
                         remote_command(url, len(data), deploy_command)], timeout=315)
        if result.returncode:
            raise RemoteExit(result.returncode)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('alias')
    parser.add_argument('host')
    parser.add_argument('artifact')
    parser.add_argument('deploy_command')
    args = parser.parse_args()
    try:
        transfer(args.alias, args.host, args.artifact, args.deploy_command)
    except RemoteExit as error:
        print('Transfer stopped: ' + str(error), file=sys.stderr)
        sys.exit(error.status)
    except subprocess.TimeoutExpired:
        sys.exit('Transfer stopped: sshbind deployment timed out')
    except (OSError, ValueError, RuntimeError) as error:
        sys.exit('Transfer stopped: ' + str(error))


if __name__ == '__main__':
    main()
