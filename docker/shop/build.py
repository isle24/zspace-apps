#!/usr/bin/env python3
"""Build only public shop assets and fixed, checksum-verified Docker tools."""
import argparse
import importlib.util
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--tag', default='isle204/zspace-shop:2026.10.14-r1')
    parser.add_argument('--push', action='store_true')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location('shop_host_build', repo/'scripts/store-container-host.py')
    host = importlib.util.module_from_spec(spec); spec.loader.exec_module(host)
    runtime = repo/'.runtime'; runtime.mkdir(exist_ok=True)
    context = Path(tempfile.mkdtemp(prefix='shop-build-', dir=runtime))
    artifact = host.build_bundle(repo, context)
    with tarfile.open(artifact, 'r:gz') as archive:
        # Compatible with macOS Python 3.9; only regular public build files.
        for member in archive.getmembers():
            relative = Path(member.name)
            if not member.isfile() or relative.is_absolute() or '..' in relative.parts or not (member.name in ('Dockerfile', 'space-store', 'docker', 'docker-compose') or member.name.startswith('web/')):
                raise ValueError('Unsafe public build artifact')
            target = context/relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, target.open('wb') as destination:
                shutil.copyfileobj(source, destination)
    for source, target in [(repo/'docker/shop/Dockerfile', 'Dockerfile'), (repo/'docker/shop/bootstrap.py', 'bootstrap.py'), (repo/'scripts/store-container-host.py', 'host.py')]:
        shutil.copyfile(source, context/target)
    print('Public shop build context: '+str(context), flush=True)
    subprocess.run(['docker', 'buildx', 'build', '--platform', 'linux/amd64', '--tag', args.tag, '--push' if args.push else '--load', str(context)], check=True)

if __name__ == '__main__': main()
