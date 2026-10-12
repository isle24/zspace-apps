#!/usr/bin/env bash
# 生成 NAS 部署产物到 ./dist-deploy（前端构建 + linux/amd64 网关 + 运行期配置）
#   bash deploy/nas-appstore/build.sh http://192.168.3.56:5055
set -euo pipefail
task_root="$(cd "$(dirname "$0")/../.." && pwd)"
nas_origin="${1:-}"
out="$task_root/deploy/nas-appstore/dist-deploy"

if [ -z "$nas_origin" ]; then
  echo "（NAS 接口地址现在由 compose 的 NAS_ORIGIN 提供，此参数仅保留兼容）" >&2
fi

mkdir -p "$out"
echo "== 构建前端 =="
# 不用 pnpm：这台机器上没有它，而且 node_modules 已经装好了
( cd "$task_root/apps/client" && ./node_modules/.bin/tsc -b && ./node_modules/.bin/vite build )

echo "== 交叉编译 space-gateway 与 space-proxy (linux/amd64) =="
( cd "$task_root/server" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags "-s -w" -o "$out/space-gateway" ./cmd/space-gateway )
( cd "$task_root/deploy/nas-appstore/proxy" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags "-s -w" -o "$out/space-proxy" . )

echo "== 组装文件 =="
rm -rf "$out/web" && mkdir -p "$out/web"
cp -R "$task_root/apps/client/dist/." "$out/web/"
# 根路径要留给新 UI：gateway 会优先把 / 解析成 store.html，因此把独立商店页改名
if [ -f "$out/web/store.html" ]; then mv "$out/web/store.html" "$out/web/shop.html"; fi
cp "$task_root/deploy/nas-appstore/Dockerfile" "$task_root/deploy/nas-appstore/docker-compose.yml" \
   "$task_root/deploy/nas-appstore/entrypoint.sh" "$out/"

python3 - "$out/web/runtime-config.json" "$nas_origin" <<'PY'
import json, sys
path, origin = sys.argv[1], sys.argv[2]
json.dump({
    "_comment": "同源部署：页面与接口都是本容器的地址，留空即按同源规则使用当前 origin。"
                "如果改成直连 5055（跨源），受 cookie 保护的接口会失败。",
    "nasOrigin": "",
}, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("runtime-config.json ->", origin)
PY

# 预压缩静态资源：NAS 那台反代不会自己 gzip，而 client.js 有 964 KB。
# 只压文本类型，图片/字体本来就已经压过了。
echo "== 预压缩静态资源 =="
python3 - "$out/web" <<'PY2'
import gzip, os, pathlib, sys

root = pathlib.Path(sys.argv[1])
exts = {".js", ".css", ".html", ".svg", ".json", ".webmanifest"}
saved = 0
count = 0
for path in root.rglob("*"):
    if not path.is_file() or path.suffix.lower() not in exts or path.name.endswith(".gz"):
        continue
    raw = path.read_bytes()
    packed = gzip.compress(raw, 9, mtime=0)
    if len(packed) < len(raw):
        path.with_name(path.name + ".gz").write_bytes(packed)
        saved += len(raw) - len(packed)
        count += 1
print(f"  压缩 {count} 个文件，省下 {saved / 1024:.0f} KB")
PY2

# 体积报告：防止以后悄悄变胖（超预算只警告，不阻断构建）
echo "== 体积 =="
python3 - "$out/web" <<'PY3'
import pathlib, sys

root = pathlib.Path(sys.argv[1])
total = sum(p.stat().st_size for p in root.rglob("*") if p.is_file() and not p.name.endswith(".gz"))
packed = sum(p.stat().st_size for p in root.rglob("*.gz") if p.is_file())
big = sorted(((p.stat().st_size, p.relative_to(root)) for p in root.rglob("*") if p.is_file() and not p.name.endswith(".gz")), reverse=True)[:5]
print(f"  未压缩 {total / 1048576:.1f} MB，gzip 后约 {(total - packed) / 1048576:.1f} MB")
for size, name in big:
    print(f"    {size / 1024:8.0f} KB  {name}")
BUDGET = 6 * 1048576
if total > BUDGET:
    print(f"  ⚠️ 超过 {BUDGET / 1048576:.0f} MB 预算 —— 检查是不是又塞了大图/大依赖")
PY3

echo
echo "产物目录: $out"
echo "下一步：bash deploy/nas-appstore/push.sh（只更新客户端与 proxy，先备份，不清空 NAS 目录）"
