#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_target="${1:-$(rustc --print host-tuple)}"
case "$task_target" in
  aarch64-apple-darwin) task_os=darwin; task_arch=arm64; task_ext= ;;
  x86_64-apple-darwin) task_os=darwin; task_arch=amd64; task_ext= ;;
  x86_64-unknown-linux-gnu) task_os=linux; task_arch=amd64; task_ext= ;;
  aarch64-unknown-linux-gnu) task_os=linux; task_arch=arm64; task_ext= ;;
  x86_64-pc-windows-msvc) task_os=windows; task_arch=amd64; task_ext=.exe ;;
  *) echo "Unsupported target: $task_target" >&2; exit 1 ;;
esac
mkdir -p "$task_root/apps/client/src-tauri/binaries"
cd "$task_root/server"
CGO_ENABLED=0 GOOS="$task_os" GOARCH="$task_arch" go build -trimpath -o "$task_root/apps/client/src-tauri/binaries/space-gateway-$task_target$task_ext" ./cmd/space-gateway
