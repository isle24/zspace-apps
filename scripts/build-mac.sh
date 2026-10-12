#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
bash "$task_root/scripts/build-sidecar.sh"
cd "$task_root/apps/client"
pnpm tauri build --bundles app
