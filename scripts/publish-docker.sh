#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 2 || ! "$2" =~ ^[0-9][A-Za-z0-9._-]*$ ]]; then
  echo 'Usage: bash scripts/publish-docker.sh {shop|ui|store} VERSION' >&2
  exit 2
fi
task_repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
task_version="$2"
case "$1" in
  shop)
    exec python3 "$task_repo/docker/shop/build.py" --tag "isle204/zspace-shop:$task_version" --push
    ;;
  ui) task_dockerfile=ui ;;
  store) task_dockerfile=catalog ;;
  *) echo 'Project must be shop, ui or store.' >&2; exit 2 ;;
esac
exec docker buildx build --platform linux/amd64 \
  --tag "isle204/zspace-$1:$task_version" --tag "isle204/zspace-$1:latest" \
  --file "$task_repo/docker/$task_dockerfile/Dockerfile" --push "$task_repo"
