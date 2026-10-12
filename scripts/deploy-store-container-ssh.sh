#!/usr/bin/env bash
set -euo pipefail
umask 077
task_root="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 "$task_root/scripts/store-container-host.py" "$@"
