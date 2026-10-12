#!/usr/bin/env bash
# Safe client-only update, with backups. Does not replace the store gateway.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/../.." && pwd)"
exec python3 "$task_root/deploy/nas-appstore/push-client.py"
