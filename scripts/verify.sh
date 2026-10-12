#!/usr/bin/env bash
# 一条命令重跑全部验收
#
#   bash scripts/verify.sh              # 离线部分：类型检查 + 单元测试 + 构建
#   bash scripts/verify.sh --live       # 再加上真机部分：两种主题的功能回归、深色对比度、窄窗口布局
#   bash scripts/verify.sh --all        # 再加上 WebKit 渲染检查（Mac 客户端同款引擎）
#
# --live 包含：两种主题的功能回归、深色对比度、窄窗口布局、可访问性、窗口交互
#
# 真机部分需要一个**开着远程调试端口**的浏览器（默认 9455），并且页面已经登录到 NAS。
# 端口可用 DSH_CDP_PORT 覆盖，目标站点用 VERIFY_URL 覆盖。
#
# 为什么要有这个脚本：验收手段这十几轮攒了六个（单测、功能回归、对比度、
# 布局、WebKit 渲染、部署指纹），散在各处；而且每一种都出现过"尺子坏了"的情况。
# 集中到一条命令，接手的人跑一次就知道当前状态。
set -uo pipefail
# Every subprocess shell must also preserve pipeline failures.
export SHELLOPTS

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT="$ROOT/apps/client"
export PATH="/opt/homebrew/bin:/usr/local/go/bin:$HOME/.cargo/bin:$PATH"
export DSH_CDP_PORT="${DSH_CDP_PORT:-9455}"
VERIFY_URL="${VERIFY_URL:-http://192.168.3.56:18436/}"

LIVE=0; WEBKIT=0
for arg in "$@"; do
  case "$arg" in
    --live) LIVE=1 ;;
    --all) LIVE=1; WEBKIT=1 ;;
    --help|-h) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

pass=0; fail=0; skipped=0
declare -a RESULTS
record() { # record <名称> <状态> <说明>
  RESULTS+=("$(printf '%-22s %-8s %s' "$1" "$2" "$3")")
  case "$2" in
    PASS) pass=$((pass + 1)) ;;
    FAIL) fail=$((fail + 1)) ;;
    SKIP) skipped=$((skipped + 1)) ;;
  esac
}
step() { # step <名称> <命令...>
  local name="$1"; shift
  local log; log="$(mktemp)"
  if "$@" >"$log" 2>&1; then
    record "$name" PASS "$(tail -1 "$log" | cut -c1-70)"
  else
    record "$name" FAIL "$(tail -3 "$log" | tr '\n' ' ' | cut -c1-100)"
    echo "—— $name 失败，最后几行："
    tail -12 "$log" | sed 's/^/    /'
  fi
  rm -f "$log"
}

cd "$ROOT"

echo "=== 离线部分 ==="
step "类型检查" bash -c "cd '$CLIENT' && ./node_modules/.bin/tsc -b --pretty false"
step "单元测试" bash -c "cd '$CLIENT' && ./node_modules/.bin/vitest run"
step "前端构建" bash -c "cd '$CLIENT' && ./node_modules/.bin/vite build"
step "产物守卫" bash -c "cd '$ROOT' && node scripts/bundle-guard.mjs 2>&1"
# macOS 客户端产物是否比源码旧（存在才检查；不存在就跳过）
app_bin="$CLIENT/src-tauri/target/release/bundle/macos/Space Desktop.app/Contents/MacOS/space-desktop"
if [ -f "$app_bin" ]; then
  newer="$(find "$CLIENT/src" "$CLIENT/src-tauri/src" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.rs' \) -newer "$app_bin" 2>/dev/null | head -3)"
  if [ -z "$newer" ]; then
    record "Mac 产物新鲜度" PASS "包比所有源码新"
  else
    record "Mac 产物新鲜度" FAIL "以下源码比包新：$(echo "$newer" | tr '\n' ' ' | cut -c1-90)"
  fi
else
  record "Mac 产物新鲜度" SKIP "没有打包产物（未在 macOS 上打包过）"
fi

step "文档引用检查" bash -c "cd '$ROOT' && node scripts/docs-check.mjs 2>&1"
step "静态质量扫描" bash -c "cd '$ROOT' && node scripts/static-audit.mjs 2>&1"

if [ "$LIVE" = 1 ]; then
  echo
  echo "=== 真机部分（浏览器 ${DSH_CDP_PORT}，站点 ${VERIFY_URL}）==="
  if ! curl -fsS -o /dev/null "http://127.0.0.1:$DSH_CDP_PORT/json/version"; then
    record "真机巡检" SKIP "远程调试端口 $DSH_CDP_PORT 未就绪"
  else
    if ! curl -fsS -o /dev/null "$VERIFY_URL"; then
      record "真机巡检" SKIP "站点不可达：$VERIFY_URL"
    elif [ "$(node scripts/page-state.mjs)" = "login" ]; then
      # 未登录时那些脚本会各报各的失败（找不到行、列表为空），看起来像功能坏了
      record "真机巡检" SKIP "页面停在登录页 —— 先在浏览器里登录，再重跑 --live"
    else
      for theme in light dark; do
        step "功能回归($theme)" bash -c "cd '$ROOT' && node scripts/functional-regression.mjs --theme $theme 2>&1 | grep -q '控制台异常: 0'"
      done
      step "深色对比度" bash -c "cd '$ROOT' && node scripts/dark-contrast-audit.mjs 2>&1 | grep -oE 'count=[0-9]+' | sort -t= -k2 -rn | head -1 | grep -qE 'count=([0-3])\$'"
      step "窄窗口布局" bash -c "cd '$ROOT' && node scripts/layout-audit.mjs 2>&1 | grep -cE 'ok\$' | grep -q '^33\$'"
      step "线上冒烟" bash -c "cd '$ROOT' && node scripts/deploy-smoke.mjs '$VERIFY_URL' 2>&1"
      step "可访问性" bash -c "cd '$ROOT' && node scripts/a11y-audit.mjs 2>&1 | grep -q '无名称 0，无可见焦点 0'"
      # 窗口交互（拖动/缩放/⌘W）需要浏览器窗口可见，否则 CDP 输入不送达 —— 退出码 2 记为 SKIP
      inter_log="$(mktemp)"
      if node scripts/window-interaction.mjs --reset >"$inter_log" 2>&1; then
        record "窗口交互" PASS "$(tail -1 "$inter_log" | cut -c1-70)"
      elif [ $? -eq 2 ]; then
        record "窗口交互" SKIP "窗口在后台，输入不送达（前置条件不满足）"
      else
        record "窗口交互" FAIL "$(tail -2 "$inter_log" | tr '\n' ' ' | cut -c1-90)"
        tail -8 "$inter_log" | sed 's/^/    /'
      fi
      rm -f "$inter_log"
    fi
  fi
fi

if [ "$WEBKIT" = 1 ]; then
  echo
  echo "=== WebKit（Mac 客户端同款引擎）==="
  serve_port=18999
  serve_dir="$(mktemp -d)"
  cp -R "$CLIENT/dist/." "$serve_dir/"
  python3 -m http.server "$serve_port" --bind 127.0.0.1 --directory "$serve_dir" >/dev/null 2>&1 &
  serve_pid=$!
  trap 'kill "$serve_pid" 2>/dev/null' EXIT
  sleep 2
  step "WebKit 渲染" bash -c "cd '$ROOT' && node scripts/webkit-render-check.cjs http://127.0.0.1:$serve_port/"
  step "界面流程" bash -c "cd '$ROOT' && node scripts/ui-flows-check.cjs 2>&1"
  kill "$serve_pid" 2>/dev/null
  rm -rf "$serve_dir"
fi

echo
echo "=== 汇总 ==="
printf '%s\n' "${RESULTS[@]}"
echo
echo "通过 ${pass}，失败 ${fail}，跳过 ${skipped}"
[ "$fail" -eq 0 ] || exit 1
