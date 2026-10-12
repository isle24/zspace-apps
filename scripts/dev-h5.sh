#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$task_root/server"
# LAN binding is opt-in. Store ownership is established through the loopback URL first.
exec go run ./cmd/space-gateway --listen "${SPACE_LISTEN:-127.0.0.1:18435}" --data-dir "$task_root/.runtime/h5" --web-root "$task_root/apps/client/dist" --engine "${SPACE_ENGINE:-disabled}" --ssh-alias "${SPACE_SSH_ALIAS:-}" --storage-root "${SPACE_STORAGE_ROOT:-}"
