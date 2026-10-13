#!/usr/bin/env bash
# Image-only deployment. No Node, Go, Python, package build or data removal.
set +x
set -euo pipefail
export LC_ALL=C
umask 077
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
task_mode="${1:-}"
task_config=
task_project=
task_with_docker=0
task_skip_admin=0
task_pull=1
task_bootstrap_started=0
task_compose=()
fail() { printf '%s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
用法：bash deploy.sh ui|catalog [选项]
  --config PATH             配置文件（默认项目目录/.env）
  --project-name NAME       独立 Compose 项目名（默认 zspace-ui/zspace-store）
  --with-docker             UI 授权挂载宿主 Docker socket，并自动匹配 GID
  --skip-admin-bootstrap    商店迁移或恢复时跳过管理员初始化
  --no-pull                 已载入本地镜像时不访问镜像仓库
首次使用：复制对应 config.example.env 为 .env，填写 NAS/公开来源后运行。
只 pull/up；保留所有卷、数据库、镜像、容器和旧配置。
HELP
}
if [[ "$task_mode" == --help || "$task_mode" == -h || -z "$task_mode" ]]; then usage; exit 0; fi
[[ "$task_mode" == ui || "$task_mode" == catalog ]] || fail '项目必须为 ui 或 catalog'
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config|--project-name)
      [[ $# -ge 2 ]] || fail "选项 $1 缺少值"
      if [[ "$1" == --config ]]; then task_config="$2"; else task_project="$2"; fi
      shift 2 ;;
    --with-docker) task_with_docker=1; shift ;;
    --skip-admin-bootstrap) task_skip_admin=1; shift ;;
    --no-pull) task_pull=0; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "未知选项：$1" ;;
  esac
done
[[ "$task_mode" == ui || "$task_with_docker" == 0 ]] || fail '--with-docker 仅适用于 UI'
[[ "$task_mode" == catalog || "$task_skip_admin" == 0 ]] || fail '--skip-admin-bootstrap 仅适用于商店后台'
task_directory="$task_root/$task_mode"
task_config="${task_config:-$task_directory/.env}"
if [[ "$task_config" != /* ]]; then task_config="$PWD/$task_config"; fi
if [[ ! -f "$task_config" ]]; then
  [[ ! -e "$task_config" && ! -L "$task_config" ]] || fail '配置路径不是普通文件'
  (set -o noclobber; cat "$task_directory/config.example.env" > "$task_config")
  printf '已创建配置：%s\n请填写实际 NAS/公开来源，再运行同一命令。\n' "$task_config" >&2
  exit 2
fi
[[ ! -L "$task_config" ]] || fail '配置不能为符号链接'
task_project="${task_project:-$( [[ "$task_mode" == ui ]] && printf zspace-ui || printf zspace-store )}"
[[ "$task_project" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || fail '项目名须为小写字母、数字、短横线或下划线'
command -v docker >/dev/null || fail '需要 Docker Engine 与 Docker Compose v2+'
docker compose version </dev/null >/dev/null || fail 'Docker Compose 不可用'
task_compose=(docker compose --env-file "$task_config" --project-name "$task_project" -f "$task_directory/compose.yaml")
compose_noninteractive() { "${task_compose[@]}" "$@" </dev/null; }

# Parse only selected literal config values. The config is never sourced/eval'd.
literal_config() {
  local key="$1" fallback="$2" line value=
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ "$line" == "$key="* ]]; then value="${line#*=}"; fi
  done < "$task_config"
  if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then value="${value:1:${#value}-2}"; fi
  printf '%s' "${value:-$fallback}"
}
private_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}
json_escape() {
  local value="$1" task_code task_control task_escape
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  for ((task_code=1; task_code<32; task_code++)); do
    printf -v task_control "\\$(printf '%03o' "$task_code")"
    printf -v task_escape '\\u%04x' "$task_code"
    value="${value//$task_control/$task_escape}"
  done
  printf '%s' "$value"
}
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  unset task_password task_confirm
  if [[ "$task_bootstrap_started" == 1 ]]; then
    compose_noninteractive --profile bootstrap stop bootstrap >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$task_mode" == ui ]]; then
  if [[ "$task_with_docker" == 1 ]]; then
    [[ -S /var/run/docker.sock ]] || fail '宿主 /var/run/docker.sock 不是可用 Unix socket'
    task_socket_gid="$(stat -c '%g' /var/run/docker.sock 2>/dev/null || stat -f '%g' /var/run/docker.sock)"
    [[ "$task_socket_gid" =~ ^[0-9]+$ ]] || fail '无法读取宿主 Docker socket GID'
    export DOCKER_SOCKET_GID="$task_socket_gid"
    task_compose+=(-f "$task_directory/compose.docker.yaml")
    printf '启用已授权的宿主 Docker 管理（socket GID %s）。\n' "$task_socket_gid"
  fi
  compose_noninteractive config --quiet
  if [[ "$task_pull" == 1 ]]; then compose_noninteractive pull ui; fi
  compose_noninteractive up -d --no-build --pull never --wait --wait-timeout 120 ui
  printf 'UI 已启动：%s\n' "$(literal_config UI_PUBLIC_ORIGIN '见配置中的 UI_PUBLIC_ORIGIN')"
  exit 0
fi

task_secret="${POSTGRES_PASSWORD_FILE:-$(literal_config POSTGRES_PASSWORD_FILE './.env.postgres-password')}"
[[ "$task_secret" != *'$'* && "$task_secret" != *'`'* && "$task_secret" != *$'\n'* ]] || fail '密码文件路径必须是直接路径，不能使用变量表达式'
if [[ "$task_secret" != /* ]]; then task_secret="$(dirname "$task_config")/$task_secret"; fi
[[ ! -L "$task_secret" ]] || fail '密码文件不能为符号链接'
export POSTGRES_PASSWORD_FILE="$task_secret"
if [[ ! -e "$task_secret" ]]; then
  task_old_containers="$(compose_noninteractive ps --all --quiet catalog postgres)"
  task_old_volumes="$(docker volume ls --quiet --filter "label=com.docker.compose.project=$task_project" </dev/null)"
  task_named_volume=0
  # Restored volumes may have their original name but no Compose labels.
  if docker volume inspect "${task_project}_catalog-data" </dev/null >/dev/null 2>&1 || \
     docker volume inspect "${task_project}_postgres-data" </dev/null >/dev/null 2>&1; then task_named_volume=1; fi
  if [[ -n "$task_old_containers" || -n "$task_old_volumes" || "$task_named_volume" == 1 ]]; then
    fail '已有商店容器或持久数据卷，但密码文件缺失。请恢复原 PostgreSQL secret；不会生成新密码或更改现有数据库。'
  fi
  [[ -r /dev/urandom ]] || fail '系统随机源不可用'
  (set -o noclobber; od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$task_secret")
fi
[[ -f "$task_secret" && -s "$task_secret" ]] || fail 'PostgreSQL 密码文件必须是非空普通文件'
[[ "$(private_mode "$task_secret")" == 600 ]] || fail '密码文件权限须为 0600；已有文件不会自动修改'
compose_noninteractive config --quiet
if [[ "$task_pull" == 1 ]]; then compose_noninteractive pull catalog postgres; fi
task_existing_catalog="$(compose_noninteractive ps --all --quiet catalog)"
if [[ "$task_skip_admin" == 1 || -n "$task_existing_catalog" ]]; then
  printf '保留已有元数据；跳过管理员初始化。\n'
else
  task_bootstrap_started=1
  compose_noninteractive --profile bootstrap up -d --no-build --pull never --wait --wait-timeout 60 bootstrap
  task_bootstrap_status="$(compose_noninteractive exec -T bootstrap wget -qO- http://127.0.0.1:18542/api/store/bootstrap)"
  if [[ "$task_bootstrap_status" == *'"configured":true'* ]]; then
    printf '已有管理员元数据；跳过密码输入。\n'
  elif [[ "$task_bootstrap_status" == *'"configured":false'* ]]; then
    printf '首次创建商店管理员（密码仅通过标准输入发送）。\n' >&2
    IFS= read -r -p '管理员用户名: ' task_username || fail '未读取到管理员用户名'
    IFS= read -r -s -p '管理员密码: ' task_password || fail '未读取到管理员密码'
    printf '\n' >&2
    IFS= read -r -s -p '再次输入密码: ' task_confirm || fail '未读取到确认密码'
    printf '\n' >&2
    [[ "$task_username" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$ ]] || fail '用户名须为 1 至 64 个字母、数字、下划线或短横线'
    [[ "$task_password" == "$task_confirm" ]] || fail '两次密码不一致，未发送初始化请求'
    [[ ${#task_password} -ge 12 && ${#task_password} -le 72 ]] || fail '管理员密码须为 12 至 72 字节'
    printf '{"username":"%s","password":"%s"}' "$(json_escape "$task_username")" "$(json_escape "$task_password")" | \
      "${task_compose[@]}" exec -T bootstrap wget --post-file=/dev/stdin \
        --header='Content-Type: application/json' -q -O /dev/null http://127.0.0.1:18542/api/store/setup
    unset task_password task_confirm
    printf '管理员已初始化；未显示密码或会话。\n'
  else
    fail '管理员初始化状态无法核验；服务及数据均保留'
  fi
  compose_noninteractive --profile bootstrap stop bootstrap
  task_bootstrap_started=0
fi
compose_noninteractive up -d --no-build --pull never --wait --wait-timeout 120 catalog postgres
printf '商店后台已启动：%s/admin/\n' "$(literal_config SPACE_PUBLIC_ORIGIN '见配置中的 SPACE_PUBLIC_ORIGIN')"
