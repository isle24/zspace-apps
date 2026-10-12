#!/usr/bin/env bash
# 打包 macOS 客户端（Tauri）
#
#   bash deploy/mac/build.sh [NAS地址]
#
# 做的事：
#   1. 前端构建（tsc + vite）
#   2. 把 NAS 地址写进 dist/runtime-config.json —— 原生客户端默认连它，登录页仍可改
#   3. tauri build（用 --config 把 beforeBuildCommand 置空，避免二次构建冲掉第 2 步的配置）
#   4. ad-hoc 签名：Apple Silicon 上未签名的 bundle 会被 Gatekeeper 拦，自用足够
#   5. 打印产物路径与体积
#
# **顺序不能改**：vite 会清空 dist 并把 public/runtime-config.json（默认 nasOrigin 为空）
# 拷进去。第一版就是"先写配置再 tauri build"，而 tauri build 内部又跑了一次前端构建，
# 于是刚写好的地址被覆盖 —— Mac 客户端因此一直让用户手填地址
# （网页版是同源部署，看不出这个问题）。
set -euo pipefail

NAS_ORIGIN="${1:-http://192.168.3.56:5055}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLIENT="$ROOT/apps/client"

export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"

echo "== 构建前端 =="
( cd "$CLIENT" && ./node_modules/.bin/tsc -b && ./node_modules/.bin/vite build )

echo "== 写入客户端默认设备地址 =="
python3 - "$CLIENT/dist/runtime-config.json" "$NAS_ORIGIN" <<'PY'
import json, sys, pathlib

target, origin = sys.argv[1], sys.argv[2]
path = pathlib.Path(target)
path.write_text(json.dumps({
    "_comment": "原生客户端默认连接的设备地址；登录页可以改。网页版部署时会被覆盖成同源配置。",
    "nasOrigin": origin,
}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("runtime-config.json ->", origin)
PY

echo "== 打包（跳过 beforeBuildCommand，保住上面写的配置）=="
( cd "$CLIENT" && ./node_modules/.bin/tauri build --config '{"build":{"beforeBuildCommand":""}}' )

APP="$CLIENT/src-tauri/target/release/bundle/macos/Space Desktop.app"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

# 打包后核对：配置真的还在（否则又会被静默覆盖）
grep -q "$NAS_ORIGIN" "$CLIENT/dist/runtime-config.json" \
  || { echo "runtime-config.json 里的地址丢了：$(cat "$CLIENT/dist/runtime-config.json")" >&2; exit 1; }
echo "配置核对通过：$(grep -o '"nasOrigin": "[^"]*"' "$CLIENT/dist/runtime-config.json")"

echo
echo "产物：$APP"
du -sh "$APP"
