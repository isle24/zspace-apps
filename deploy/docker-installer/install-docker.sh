#!/bin/sh
set -eu
RELEASE=docker-2026.10.12-r1
ARTIFACT_SHA256=BUILD_ARTIFACT_SHA256
STORE_IMAGE_ID=BUILD_STORE_IMAGE_ID
CLIENT_IMAGE_ID=BUILD_CLIENT_IMAGE_ID
ARTIFACT_URL=https://github.com/isle24/nas-app-store-catalog/releases/download/docker-2026.10.12-r1/space-store-linux-amd64.tgz
ip='';root='';uid="$(id -u)";gid="$(id -g)";client_port=18436;store_port=18441;client_name=space-desktop
fail(){ printf '%s\n' "$*" >&2; exit 1; }
# Preserve NonRecursive on old and new CLIs: bind-recursive was added in 25,
# while 20.10-24 use bind-nonrecursive. Select by CLI, not daemon, version.
nonrecursive_mount_option() {
 printf '%s\n' "$1" | awk -F. '
  NR == 1 && /^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9_.+-]+)?$/ {
   major=$1+0;minor=$2+0
   valid=(major>20 || (major==20 && minor>=10))
   option=(major>=25 ? "bind-recursive=disabled" : "bind-nonrecursive=true")
  }
  END {if (!valid || NR!=1) exit 1; print option}'
}
usage(){ cat <<'HELP'
空间商店 Docker 一键安装（Linux amd64，Docker 20.10 或以上）
  sh install-docker.sh --ip NAS_IP --root /data_数据盘/space-store
可选：--uid NAS用户ID --gid NAS用户组ID --client-port 18436 --store-port 18441
      --client-name space-desktop
只安装到不存在的专用目录；已有目录、容器或占用端口会中止，不覆盖原有数据。
停止与日志使用 docker stop / docker logs；再次安装不会替换旧服务。
HELP
}
while [ "$#" -gt 0 ]; do
 case "$1" in
  --help|-h) usage;exit 0;;
  --ip|--root|--uid|--gid|--client-port|--store-port|--client-name)
   [ "$#" -ge 2 ] || fail "参数 $1 缺少值";key="$1";value="$2";shift 2
   case "$key" in --ip) ip="$value";;--root) root="$value";;--uid) uid="$value";;--gid) gid="$value";;--client-port) client_port="$value";;--store-port) store_port="$value";;--client-name) client_name="$value";;esac;;
  *) fail "未知参数 $1，请使用 --help";;
 esac
done
[ -n "$ip" ] && [ -n "$root" ] || fail '请指定 --ip NAS_IP 和 --root 数据盘专用目录'
printf '%s\n' "$ip" | awk -F. 'NF!=4{exit 1}{for(i=1;i<=4;i++)if($i!~/^[0-9]+$/||$i>255)exit 1}' || fail 'NAS IP 无效'
printf '%s\n' "$root" | grep -Eq '^/data_[A-Za-z0-9]+/[A-Za-z0-9_./-]+$' || fail '请选择 /data_ 数据盘上的专用目录'
case "$root" in *'/../'*|*'/./'*|*'//'*|*/..|*/.|*/|*'/docker/'*) fail '数据盘目录路径无效';;esac
for v in "$uid" "$gid" "$client_port" "$store_port"; do case "$v" in ''|*[!0-9]*) fail '用户 ID、组 ID 和端口必须是数字';;esac;done
[ "$uid" -gt 0 ] && [ "$gid" -gt 0 ] || fail '请用普通 NAS 账号运行，或通过 --uid 和 --gid 指定该账号的 ID'
[ "$client_port" -ge 1024 ] && [ "$client_port" -le 65535 ] && [ "$store_port" -ge 1024 ] && [ "$store_port" -le 65535 ] && [ "$client_port" != "$store_port" ] || fail '端口须在 1024 到 65535 之间且互不相同'
printf '%s\n' "$client_name" | grep -Eq '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$' || fail '客户端容器名称无效'
for tool in docker curl sha256sum tar readlink stat; do command -v "$tool" >/dev/null || fail "缺少 $tool";done
[ "$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')" = linux/amd64 ] || fail '此安装包目前支持 Linux amd64'
version="$(docker version --format '{{.Server.Version}}')";major="${version%%.*}";rest="${version#*.}";minor="${rest%%.*}"
case "$major:$minor" in *[!0-9:]*) fail '无法确认 Docker 版本';;esac
[ "$major" -gt 20 ] || { [ "$major" -eq 20 ] && [ "$minor" -ge 10 ]; } || fail '需要 Docker 20.10 或以上版本'
client_version="$(docker version --format '{{.Client.Version}}')" || fail '无法确认 Docker CLI 版本'
nonrecursive_mount="$(nonrecursive_mount_option "$client_version")" || fail '需要 Docker CLI 20.10 或以上，且版本号必须可确认'
! docker inspect "$client_name" >/dev/null 2>&1 || fail "已有客户端容器 ${client_name}，请保留现有服务并选择其他名称"
[ ! -e "$root" ] && [ ! -L "$root" ] || fail '目标目录已存在；安装不会覆盖，请选择新的专用目录'
parent="$(dirname "$root")";[ -d "$parent" ] && [ "$(readlink -f "$parent")" = "$parent" ] || fail '数据盘父目录不存在或不是实际路径'
cache="$(docker info --format '{{.DockerRootDir}}')";case "$cache" in /data_*) ;;*) fail 'Docker 缓存须位于 NAS 数据盘';;esac
case "$root/" in "$cache/"*) fail '应用目录不能位于 Docker 缓存内';;esac
if command -v ss >/dev/null; then
 for port in "$client_port" "$store_port"; do ! ss -ltn | awk '{print $4}' | grep -Eq ":$port$" || fail "端口 $port 已占用";done
fi
socket_gid="$(stat -c %g /var/run/docker.sock)"
[ "$(id -u)" -eq 0 ] || { [ "$uid" = "$(id -u)" ] && [ "$gid" = "$(id -g)" ]; } || fail '非 root 安装须使用当前 NAS 账号的 ID'
# Only new directories are touched. Failures retain every file and container.
mkdir "$root";chmod 700 "$root"
mkdir "$root/install" "$root/service" "$root/service/metadata" "$root/apps" "$root/client-data"
chmod 700 "$root/install" "$root/service" "$root/service/metadata" "$root/apps" "$root/client-data"
if [ "$(id -u)" -eq 0 ];then chown "$uid:$gid" "$root" "$root/service" "$root/service/metadata" "$root/apps" "$root/client-data";fi
curl -fL --connect-timeout 20 --retry 2 "$ARTIFACT_URL" -o "$root/install/package.tgz"
printf '%s  %s\n' "$ARTIFACT_SHA256" "$root/install/package.tgz" | sha256sum -c - || fail '安装包校验失败；保留文件供检查'
tar xzf "$root/install/package.tgz" -C "$root/install"
store_image="space-store:$RELEASE";client_image="space-desktop:$RELEASE"
for pair in "$store_image:$STORE_IMAGE_ID" "$client_image:$CLIENT_IMAGE_ID"; do
 image="${pair%%:sha256:*}";expected="sha256:${pair##*:sha256:}"
 existing="$(docker image inspect "$image" --format '{{.Id}}' 2>/dev/null || true)"
 [ -z "$existing" ] || [ "$existing" = "$expected" ] || fail "已有同名不同内容的镜像 ${image}，保留原镜像并中止安装"
done
docker load --input "$root/install/images/store.tar.gz"
docker load --input "$root/install/images/client.tar.gz"
[ "$(docker image inspect "$store_image" --format '{{.Id}}')" = "$STORE_IMAGE_ID" ] || fail '商店镜像身份未通过校验'
[ "$(docker image inspect "$client_image" --format '{{.Id}}')" = "$CLIENT_IMAGE_ID" ] || fail '客户端镜像身份未通过校验'
deploy_root="$root/service";metadata="$deploy_root/metadata";data="$root/apps"
deployment="$(printf '%s' "$deploy_root" | sha256sum | cut -c1-24)"
store_name="space-store-$deployment-$RELEASE";origin="http://$ip:$client_port"
cid="$(docker create --name "$store_name" --user "$uid:$gid" --group-add "$socket_gid" --network bridge --cgroupns private --restart unless-stopped --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,size=32m -p "$ip:$store_port:18435/tcp" \
 --label io.space-store.service=space-store --label "io.space-store.deployment=$deployment" --label "io.space-store.release=$RELEASE" --label io.space-store.control-protocol=v1 --label io.space-store.host-metadata=v1 \
 --mount "type=bind,src=$metadata,dst=$metadata,bind-propagation=rprivate,$nonrecursive_mount" \
 --mount "type=bind,src=$data,dst=$data,bind-propagation=rprivate,$nonrecursive_mount" \
 --mount "type=bind,src=$cache,dst=$cache,readonly,bind-propagation=rslave,$nonrecursive_mount" \
 --mount "type=bind,src=/proc/1/mountinfo,dst=/run/space-store-host/mountinfo,readonly,bind-propagation=rprivate,$nonrecursive_mount" \
 --mount "type=bind,src=/proc/1/net,dst=/run/space-store-host/net,readonly,bind-propagation=rprivate,$nonrecursive_mount" \
 --mount "type=bind,src=/sys,dst=/sys,readonly,bind-propagation=rprivate,$nonrecursive_mount" \
 --mount "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock,bind-propagation=rprivate,$nonrecursive_mount" \
 "$store_image" --listen 0.0.0.0:18435 --data-dir "$metadata" --storage-root "$data" --engine local --publish-host "$ip" --access-host "$ip" --nas-origin "$origin" --nas-admin-only --public-origin "$origin")"
printf '%s\n' "$cid" | grep -Eq '^[a-f0-9]{64}$' || fail '商店容器创建身份未确认'
image_id="$(docker inspect "$cid" --format '{{.Image}}')"
printf '{"schema":1,"service":"space-store","deployment":"%s","release":"%s","containerId":"%s","imageId":"%s"}\n' "$deployment" "$RELEASE" "$cid" "$image_id" > "$metadata/.space-store-container-self.json"
chmod 600 "$metadata/.space-store-container-self.json"
if [ "$(id -u)" -eq 0 ];then chown "$uid:$gid" "$metadata/.space-store-container-self.json";fi
docker start "$cid" >/dev/null
client_id="$(docker create --name "$client_name" --user "$uid:$gid" --group-add "$socket_gid" --network bridge --restart unless-stopped --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,size=16m -p "$ip:$client_port:18436/tcp" --label com.docker.compose.project=space-desktop --label com.docker.compose.service=client --mount "type=bind,src=$root/client-data,dst=/data" --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock -e "NAS_ORIGIN=http://$ip:5055" -e "SPACE_STORE_ENDPOINT=http://$ip:$store_port" "$client_image")"
docker start "$client_id" >/dev/null
ready=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
 if curl -fsS --max-time 3 "$origin/healthz" >/dev/null && curl -fsS --max-time 3 "$origin/api/store/bootstrap" | grep -q 'nas-admin-only';then ready=1;break;fi
 sleep 2
done
[ "$ready" -eq 1 ] || fail '服务状态尚未确认。所有容器和数据均保留，请用 docker logs 查看启动日志'
printf '\n安装完成：%s\n客户端：%s\n商店：%s\n数据目录：%s\n' "$origin" "$client_name" "$store_name" "$root"
printf '在页面登录 NAS 管理员，然后打开“空间商店”。\n'
