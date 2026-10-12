package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type commandRunner func(context.Context, string, ...string) (string, string, error)
type commandEngine struct {
	secrets                 *runtimeSecretManager
	mode, alias, host, root string
	bindHost                string
	runner                  commandRunner
}
type cappedBuffer struct {
	b     bytes.Buffer
	limit int
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	remaining := b.limit - b.b.Len()
	if remaining > 0 {
		if remaining < len(p) {
			p = p[:remaining]
		}
		b.b.Write(p)
	}
	return n, nil
}
func runCommand(ctx context.Context, name string, args ...string) (string, string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	out := &cappedBuffer{limit: 2 << 20}
	errOut := &cappedBuffer{limit: 64 << 10}
	cmd.Stdout = out
	cmd.Stderr = errOut
	err := cmd.Run()
	return out.b.String(), errOut.b.String(), err
}
func newCommandEngine(opts Options) (Engine, error) {
	bind, err := publishHost(opts.PublishHost, opts.EngineMode)
	if err != nil {
		return nil, err
	}
	configuredAccess, err := accessHost(opts.AccessHost)
	if err != nil {
		return nil, err
	}
	host := "127.0.0.1"
	if configuredAccess != "" {
		host = configuredAccess
	}
	e := &commandEngine{mode: opts.EngineMode, alias: opts.SSHAlias, host: host, bindHost: bind, root: opts.StorageRoot, runner: runCommand}
	switch opts.EngineMode {
	case "disabled", "local":
		return e, nil
	case "sshbind":
		if !segmentRE.MatchString(opts.SSHAlias) {
			return nil, errors.New("sshbind requires a valid registered alias")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		out, _, err := e.runner(ctx, "sshbind", "list", "--json")
		if err != nil {
			return nil, errors.New("cannot discover registered sshbind servers")
		}
		var list struct {
			Servers []struct {
				Name, Host string
				Usable     bool
			}
		}
		if json.Unmarshal([]byte(out), &list) != nil {
			return nil, errors.New("invalid sshbind server inventory")
		}
		for _, s := range list.Servers {
			if s.Name == opts.SSHAlias && s.Usable {
				if net.ParseIP(s.Host) == nil && !regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9.-]*$`).MatchString(s.Host) {
					return nil, errors.New("invalid sshbind host")
				}
				if configuredAccess == "" {
					e.host = s.Host
				}
				return e, nil
			}
		}
		return nil, errors.New("sshbind alias is absent or not usable")
	default:
		return nil, errors.New("EngineMode must be disabled, local or sshbind")
	}
}
func (e *commandEngine) Host() string { return e.host }
func shellQuote(s string) string      { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
func (e *commandEngine) remote(ctx context.Context, args ...string) (string, string, error) {
	parts := make([]string, len(args))
	for i, a := range args {
		parts[i] = shellQuote(a)
	}
	out, stderr, err := e.runner(ctx, "sshbind", "exec", "--json", e.alias, strings.Join(parts, " "))
	var result struct {
		ExitCode int    `json:"exit_code"`
		Stdout   string `json:"stdout"`
		Stderr   string `json:"stderr"`
	}
	if json.Unmarshal([]byte(out), &result) != nil {
		return "", stderr, errors.New("sshbind returned an invalid command result")
	}
	if err != nil || result.ExitCode != 0 {
		return result.Stdout, result.Stderr, errors.New("remote command failed")
	}
	return result.Stdout, result.Stderr, nil
}
func (e *commandEngine) docker(ctx context.Context, args ...string) (string, string, error) {
	if e.mode == "disabled" {
		return "", "", errors.New("请在 NAS 上通过 Docker 安装本地商店服务。")
	}
	if e.mode == "sshbind" {
		return e.remote(ctx, append([]string{"docker"}, args...)...)
	}
	return e.runner(ctx, "docker", args...)
}
func (e *commandEngine) Probe(ctx context.Context) error {
	if e.mode == "disabled" {
		return errors.New("请在 NAS 上通过 Docker 安装本地商店服务。")
	}
	if e.mode == "sshbind" {
		out, _, err := e.remote(ctx, "python3", "-c", remoteProbeScript)
		if err != nil {
			return errors.New("SSH执行引擎需要python3、当前用户可访问的本机Docker端点；请检查别名与权限。")
		}
		var state struct {
			Endpoint string `json:"endpoint"`
			Version  string `json:"version"`
		}
		if json.Unmarshal([]byte(out), &state) != nil || !strings.HasPrefix(state.Endpoint, "unix://") || state.Version == "" {
			return errors.New("SSH主机的Docker端点不属于本机或检查结果无效，拒绝目录挂载。")
		}
		return nil
	}
	if e.mode == "local" {
		host := os.Getenv("DOCKER_HOST")
		if host != "" && !strings.HasPrefix(host, "unix://") && !strings.HasPrefix(host, "npipe://") {
			return errors.New("本机模式拒绝远程Docker端点；请使用已登记sshbind引擎。")
		}
		if host == "" {
			out, _, err := e.runner(ctx, "docker", "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}")
			if err != nil {
				return errors.New("无法验证Docker上下文。")
			}
			var endpoint string
			if json.Unmarshal([]byte(strings.TrimSpace(out)), &endpoint) != nil || (!strings.HasPrefix(endpoint, "unix://") && !strings.HasPrefix(endpoint, "npipe://")) {
				return errors.New("Docker上下文不是本机端点，拒绝使用本机目录挂载。")
			}
		}
	}
	if _, _, err := e.docker(ctx, "info", "--format", "{{json .ServerVersion}}"); err != nil {
		return errors.New("Docker执行引擎不可访问；请检查连接和当前用户权限。")
	}
	return nil
}

const remoteProbeScript = `import os,subprocess,json,sys
try:
 host=os.environ.get("DOCKER_HOST","")
 endpoint=json.loads(subprocess.check_output(["docker","context","inspect","--format","{{json .Endpoints.docker.Host}}"],text=True))
 if host and not host.startswith("unix://"): sys.exit(3)
 if not endpoint.startswith("unix://"): sys.exit(3)
 version=json.loads(subprocess.check_output(["docker","info","--format","{{json .ServerVersion}}"],text=True))
 print(json.dumps({"endpoint":host or endpoint,"version":version}))
except Exception: sys.exit(3)
`

// Remote validation walks directories using file descriptors and O_NOFOLLOW.
// Only a fresh direct child may be created; no removal operation exists.
const remotePathScript = `import os,sys
root,p,mode=sys.argv[1:]
def reject(msg):
 print(msg);sys.exit(3)
if not os.path.isabs(root) or os.path.normpath(root)!=root or root=="/": reject("unsafe root")
if not os.path.isabs(p) or os.path.normpath(p)!=p or (p!=root and not p.startswith(root+"/")): reject("outside registered root")
def open_dir(path):
 fd=os.open("/",os.O_RDONLY|os.O_DIRECTORY)
 try:
  for part in path.split("/")[1:]:
   if part:
    new=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=new
  return fd
 except Exception:
  os.close(fd);raise
try:
 fd=open_dir(root)
 if mode in ("new","create"):
  if os.path.dirname(p)!=root: reject("data must be a new direct child")
  leaf=os.path.basename(p)
  try: os.stat(leaf,dir_fd=fd,follow_symlinks=False);reject("directory already exists; refusing reuse")
  except FileNotFoundError: pass
  if mode=="create": os.mkdir(leaf,mode=0o755,dir_fd=fd)
 else:
  q=open_dir(p);os.close(q)
 os.close(fd)
except (OSError,ValueError): reject("directory unavailable or contains symlink")
`

func (e *commandEngine) ValidatePath(ctx context.Context, root, p string, fresh bool) error {
	if e.mode == "disabled" {
		return errors.New("执行引擎未配置。")
	}
	if e.mode != "sshbind" {
		return validateLocalPath(root, p, fresh)
	}
	mode := "existing"
	if fresh {
		mode = "new"
	}
	if _, _, err := e.remote(ctx, "python3", "-c", remotePathScript, root, p, mode); err != nil {
		return errors.New("目录不属于登记根、含符号链接、已存在或不可访问。")
	}
	return nil
}
func (e *commandEngine) Prepare(ctx context.Context, root, p string) error {
	if e.mode == "sshbind" {
		if _, _, err := e.remote(ctx, "python3", "-c", remotePathScript, root, p, "create"); err != nil {
			return errors.New("无法创建全新实例目录；已有目录不会被复用或清空。")
		}
		return nil
	}
	if err := validateLocalPath(root, p, true); err != nil {
		return err
	}
	dir, err := os.OpenRoot(root)
	if err != nil {
		return errors.New("登记根目录不可访问。")
	}
	defer dir.Close()
	if err = dir.Mkdir(strings.TrimPrefix(p, root+string(os.PathSeparator)), 0755); err != nil {
		return errors.New("无法创建全新实例目录；数据已保留。")
	}
	return nil
}

const remotePortScript = `import sys,socket,subprocess,re
p=int(sys.argv[1])
try:
 out=subprocess.check_output(["docker","container","ls","--format","{{.Ports}}"],text=True)
 if re.search(r":"+str(p)+r"->",out): sys.exit(3)
 s=socket.socket();s.bind(("0.0.0.0",p));s.close()
except Exception: sys.exit(3)
`

// Attested containers check the host network tables; normal hosts explicitly
// hand back to the existing actual-bind check below.
var ownContainerPortScript = "import os,sys,json,subprocess,re\n" + storageHostMetadataScript + `
try:
 host_policy=own_storage_policy()
 if host_policy is None: print("host")
 elif host_port_available(int(sys.argv[1]),publishHost=sys.argv[2]): print("container")
 else: sys.exit(3)
except Exception: sys.exit(3)
`

func (e *commandEngine) PortAvailable(ctx context.Context, p int) error {
	if p < 1024 || p > 65535 || p == 5055 {
		return errors.New("端口无效或属于保留的NAS端口。")
	}
	if e.mode == "sshbind" {
		if _, _, err := e.remote(ctx, "python3", "-c", remotePortScript, strconv.Itoa(p)); err != nil {
			return errors.New("端口被占用或无法完成端口检查。")
		}
		return nil
	}
	if e.mode == "disabled" {
		return errors.New("执行引擎未配置。")
	}
	out, _, err := e.runner(ctx, "python3", "-c", ownContainerPortScript, strconv.Itoa(p), e.bindHost)
	if err != nil {
		return errors.New("端口被占用或无法完成宿主端口核验。")
	}
	switch strings.TrimSpace(out) {
	case "container":
		return nil
	case "host":
	default:
		return errors.New("宿主端口核验结果无效。")
	}
	listen, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", p))
	if err != nil {
		return errors.New("端口被占用。")
	}
	listen.Close()
	out, _, err = e.docker(ctx, "container", "ls", "--format", "{{.Ports}}")
	if err != nil {
		return errors.New("无法检查Docker已发布端口。")
	}
	if strings.Contains(out, ":"+strconv.Itoa(p)+"->") {
		return errors.New("端口已被Docker容器占用。")
	}
	return nil
}
func (e *commandEngine) Pull(ctx context.Context, image string) error {
	if !controlledImage(image) {
		return errors.New("不允许非目录配方中的镜像。")
	}
	if _, _, err := e.docker(ctx, "image", "pull", image); err != nil {
		return errors.New("镜像拉取失败；实例数据目录已保留。")
	}
	return nil
}
func controlledImage(image string) bool {
	_, ok := controlledRecipe(image)
	return ok
}
func (e *commandEngine) Inspect(ctx context.Context, n string) (Container, error) {
	out, stderr, err := e.docker(ctx, "container", "inspect", n)
	if err != nil {
		if strings.Contains(stderr, "No such container") || strings.Contains(stderr, "No such object") {
			return Container{}, ErrNotFound
		}
		return Container{}, errors.New("无法检查容器状态。")
	}
	var raw []struct {
		ID     string `json:"Id"`
		Name   string
		Config struct {
			Image  string
			Labels map[string]string
		}
		State      struct{ Status string }
		HostConfig struct {
			PortBindings map[string][]struct {
				HostIP   string `json:"HostIp"`
				HostPort string
			}
		}
		Mounts []struct {
			Source, Destination string
			RW                  bool
			Type                string
		}
	}
	if json.Unmarshal([]byte(out), &raw) != nil || len(raw) != 1 {
		return Container{}, errors.New("容器检查结果无效。")
	}
	r := raw[0]
	c := Container{ID: r.ID, Name: strings.TrimPrefix(r.Name, "/"), Image: r.Config.Image, Labels: r.Config.Labels, State: r.State.Status, Mounts: []Mount{}}
	for key, bindings := range r.HostConfig.PortBindings {
		parts := strings.Split(key, "/")
		if len(parts) != 2 {
			return Container{}, errors.New("容器发布端口检查结果无效。")
		}
		inner, err := strconv.Atoi(parts[0])
		if err != nil || inner < 1 || inner > 65535 {
			return Container{}, errors.New("容器发布端口检查结果无效。")
		}
		for _, binding := range bindings {
			hostPort, err := strconv.Atoi(binding.HostPort)
			ip := net.ParseIP(binding.HostIP)
			if binding.HostIP == "" {
				ip = net.ParseIP("0.0.0.0")
			}
			if err != nil || hostPort < 1 || hostPort > 65535 || ip == nil || (parts[1] != "tcp" && parts[1] != "udp") {
				return Container{}, errors.New("容器发布端口检查结果无效。")
			}
			c.Ports = append(c.Ports, PortBinding{HostIP: ip.String(), HostPort: hostPort, ContainerPort: inner, Protocol: parts[1]})
		}
	}
	for _, m := range r.Mounts {
		if m.Type != "bind" {
			return Container{}, errors.New("容器包含配方之外的挂载。")
		}
		c.Mounts = append(c.Mounts, Mount{Source: m.Source, Target: m.Destination, ReadOnly: !m.RW})
	}
	return c, nil
}
func (e *commandEngine) Run(ctx context.Context, r RunSpec) error {
	root := r.Root
	if root == "" {
		root = e.root
	}
	recipe, controlled := controlledRecipe(r.Image)
	if !controlled || !strings.HasPrefix(r.Name, "space-store-") || !segmentRE.MatchString(r.Name) || r.Labels["io.spacedesktop.store"] == "" || r.Labels["io.spacedesktop.instance"] == "" {
		return errors.New("拒绝不受控的容器配方。")
	}
	if root == "" || r.HostPort < 1024 || r.HostPort > 65535 || r.HostPort == 5055 {
		return errors.New("执行引擎没有登记安全存储根或端口无效。")
	}
	dataTarget := "/app/data"
	inner := 3001
	mountCount := 1
	if r.Image == "deluan/navidrome:0.64.2" {
		dataTarget = "/data"
		inner = 4533
		mountCount = 2
	}
	if r.ContainerPort != inner || len(r.Mounts) != mountCount {
		return errors.New("受控配方端口或挂载数量不匹配。")
	}
	seen := map[string]bool{}
	for _, m := range r.Mounts {
		if seen[m.Target] {
			return errors.New("拒绝重复挂载目标。")
		}
		seen[m.Target] = true
		if m.Target == dataTarget {
			if m.ReadOnly {
				return errors.New("实例数据挂载必须可写。")
			}
			if filepath.Dir(m.Source) != root {
				return errors.New("数据仅可写入登记根的直接实例子目录。")
			}
		} else if m.Target != "/music" || !m.ReadOnly || mountCount != 2 {
			return errors.New("媒体只能按音乐配方只读挂载。")
		}
		mountRoot := root
		if m.Target == "/music" && r.MediaRootPath != "" {
			mountRoot = r.MediaRootPath
			c, err := e.InspectStorage(ctx, mountRoot)
			if err != nil || !safeMediaStorage(c) || r.MediaStorageIdentity == "" || c.Identity != r.MediaStorageIdentity {
				return errors.New("媒体根的设备、inode或卷身份与受控计划不一致。")
			}
		}
		if err := e.ValidatePath(ctx, mountRoot, m.Source, false); err != nil {
			return err
		}
	}
	if !seen[dataTarget] || (mountCount == 2 && !seen["/music"]) {
		return errors.New("受控配方缺少必须的挂载。")
	}
	port := strconv.Itoa(r.HostPort) + ":" + strconv.Itoa(r.ContainerPort)
	bind := r.PublishHost
	if bind == "" {
		bind = e.bindHost
	}
	bind, err := publishHost(bind, e.mode)
	if err != nil {
		return err
	}
	port = net.JoinHostPort(bind, strconv.Itoa(r.HostPort)) + ":" + strconv.Itoa(r.ContainerPort)
	args := []string{"container", "run", "--detach", "--pull=never", "--name", r.Name, "--restart", "unless-stopped", "--label", "io.spacedesktop.store=" + r.Labels["io.spacedesktop.store"], "--label", "io.spacedesktop.instance=" + r.Labels["io.spacedesktop.instance"], "--publish", port}
	for _, m := range r.Mounts {
		if strings.ContainsAny(m.Source, ",\r\n\x00") || (!strings.HasPrefix(m.Source, "/") && e.mode == "sshbind") || m.Source == "" {
			return errors.New("不安全的挂载路径。")
		}
		valid := (m.Target == "/data" && r.Image == "deluan/navidrome:0.64.2" && !m.ReadOnly) || (m.Target == "/app/data" && recipe.ID == "uptime-kuma" && !m.ReadOnly) || (m.Target == "/music" && r.Image == "deluan/navidrome:0.64.2" && m.ReadOnly)
		if !valid {
			return errors.New("挂载与受控配方不匹配。")
		}
		v := "type=bind,src=" + m.Source + ",dst=" + m.Target
		if m.ReadOnly {
			v += ",readonly"
		}
		args = append(args, "--mount", v)
	}
	for _, v := range r.Env {
		if v != "ND_SCANSCHEDULE=1h" && v != "ND_LOGLEVEL=info" {
			return errors.New("环境参数不属于受控配方。")
		}
		args = append(args, "--env", v)
	}
	args = append(args, r.Image)
	if e.mode == "sshbind" {
		var data string
		for _, m := range r.Mounts {
			if m.Target == dataTarget {
				data = m.Source
			}
		}
		payload, _ := json.Marshal(r.Provenance)
		script := strings.ReplaceAll(remoteProvenanceScript, "root,p,mode,payload=sys.argv[1:]", "root,p,mode,payload=sys.argv[1:5]")
		script = strings.ReplaceAll(script, "os.close(df);os.close(rf);print(json.dumps(result))", "os.close(df);os.close(rf);os.execvp(sys.argv[5],sys.argv[5:])")
		remoteArgs := []string{"python3", "-c", script, root, data, "verify", string(payload), "docker"}
		remoteArgs = append(remoteArgs, args...)
		if _, _, err := e.remote(ctx, remoteArgs...); err != nil {
			return errors.New("远端目录身份复核或容器启动失败；数据与已有容器已保留。")
		}
		return nil
	}
	for _, m := range r.Mounts {
		if m.Target == dataTarget {
			if err := e.VerifyDirectory(ctx, root, m.Source, r.Provenance); err != nil {
				return err
			}
		}
	}
	if _, _, err := e.docker(ctx, args...); err != nil {
		return errors.New("容器创建或启动失败；已有容器和数据不会被删除或重建。")
	}
	return nil
}

const remoteHealthScript = `import urllib.request,sys
try:
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 with opener.open(sys.argv[1],timeout=3) as r:
  if r.status<200 or r.status>=400: sys.exit(3)
except Exception: sys.exit(3)
`

func (e *commandEngine) Health(ctx context.Context, name string, port int, path string) (string, error) {
	healthCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	if path != "/" && path != "/ping" {
		return "unknown", errors.New("健康检查路径不受控。")
	}
	client := &http.Client{Timeout: 4 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	client.Transport = transport
	for {
		c, err := e.Inspect(healthCtx, name)
		targetHost := ""
		for _, binding := range c.Ports {
			if binding.HostPort == port && binding.Protocol == "tcp" {
				ip := net.ParseIP(binding.HostIP)
				if ip == nil {
					continue
				}
				if ip.IsUnspecified() {
					if ip.To4() != nil {
						targetHost = "127.0.0.1"
					} else {
						targetHost = "::1"
					}
				} else {
					targetHost = ip.String()
				}
				break
			}
		}
		if err == nil && c.State == "running" && targetHost != "" {
			uri := "http://" + net.JoinHostPort(targetHost, strconv.Itoa(port)) + path
			if e.mode == "sshbind" {
				_, _, err = e.remote(healthCtx, "python3", "-c", remoteHealthScript, uri)
			} else {
				req, _ := http.NewRequestWithContext(healthCtx, "GET", uri, nil)
				res, e2 := client.Do(req)
				err = e2
				if err == nil {
					io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
					res.Body.Close()
					if res.StatusCode < 200 || res.StatusCode >= 400 {
						err = errors.New("unhealthy status")
					}
				}
			}
			if err == nil {
				return "healthy", nil
			}
		}
		select {
		case <-healthCtx.Done():
			return "unhealthy", errors.New("应用健康检查未通过；容器和数据已保留。")
		case <-time.After(2 * time.Second):
		}
	}
}
func (e *commandEngine) Start(ctx context.Context, id string) error {
	if _, _, err := e.docker(ctx, "container", "start", id); err != nil {
		return errors.New("容器启动失败；数据已保留。")
	}
	return nil
}
func (e *commandEngine) Stop(ctx context.Context, id string) error {
	if _, _, err := e.docker(ctx, "container", "stop", "--time", "30", id); err != nil {
		return errors.New("容器停止失败；数据已保留。")
	}
	return nil
}

// validateResumeBoundary performs fresh engine-side checks after the service
// preflight. Exact container identity is checked before final storage/media inspection;
// the caller must then verify the pinned data immediately at the mutation boundary.
func validateResumeBoundary(ctx context.Context, engine Engine, r ResumeSpec) error {
	p, i := r.Plan, r.Instance
	if r.StoreID == "" || i.ContainerID == "" || !sameRetryMaterial(p, i) || i.Provenance.Marker != r.StoreID+":"+i.ID {
		return errors.New("保留容器启动范围或所有权记录无效。")
	}
	c, err := engine.Inspect(ctx, i.ContainerName)
	if err != nil || !(&Service{storeID: r.StoreID}).owns(c, i) {
		return errors.New("启动前保留容器身份、镜像、标签、挂载或端口已改变。")
	}
	storage, ok := engine.(storageInspector)
	if !ok {
		return errors.New("启动边界缺少存储身份校验能力。")
	}
	volume, err := storage.InspectStorage(ctx, p.RootPath)
	if err != nil || !safeDataStorage(volume) || volume.Identity != p.StorageIdentity || p.StorageIdentity == "" || volume.FreeBytes < 1<<30 {
		return errors.New("启动前数据卷身份或可用空间已改变。")
	}
	docker, err := storage.DockerStorage(ctx)
	if err != nil || !safeDockerStorage(docker) || docker.Identity != p.DockerStorageIdentity || p.DockerStorageIdentity == "" || docker.FreeBytes < 2<<30 {
		return errors.New("启动前Docker缓存身份或可用空间已改变。")
	}
	if p.MediaPath != "" {
		media, err := storage.InspectStorage(ctx, p.MediaRootPath)
		if err != nil || !safeMediaStorage(media) || p.MediaStorageIdentity == "" || media.Identity != p.MediaStorageIdentity {
			return errors.New("启动前媒体卷身份已改变。")
		}
		if err = engine.ValidatePath(ctx, p.MediaRootPath, p.MediaPath, false); err != nil {
			return err
		}
	}
	return nil
}

func (e *commandEngine) Resume(ctx context.Context, r ResumeSpec) error {
	if e.mode == "disabled" {
		return errors.New("执行引擎未配置。")
	}
	if r.StoreID == "" || r.Instance.ContainerID == "" || !sameRetryMaterial(r.Plan, r.Instance) || r.Instance.Provenance.Marker != r.StoreID+":"+r.Instance.ID {
		return errors.New("保留容器启动范围无效。")
	}
	if e.mode == "sshbind" {
		body, err := json.Marshal(r)
		if err != nil {
			return err
		}
		if _, _, err = e.remote(ctx, "python3", "-c", remoteResumeScript, string(body), storageScript, remoteProvenanceScript, remoteProbeScript); err != nil {
			return errors.New("远端启动边界身份复核或启动失败；数据与保留容器已保留。")
		}
		return nil
	}
	if err := e.Probe(ctx); err != nil {
		return err
	}
	if err := validateResumeBoundary(ctx, e, r); err != nil {
		return err
	}
	// No engine inspection may intervene after this last local proof.
	if err := localVerify(r.Plan.RootPath, r.Plan.DataPath, r.Instance.Provenance); err != nil {
		return err
	}
	if _, _, err := e.docker(ctx, "container", "start", r.Instance.ContainerID); err != nil {
		return errors.New("保留容器启动失败；数据与容器已保留。")
	}
	return nil
}

// All remote proofs and docker start execute within one SSH command. The final
// provenance walk occurs after Docker/storage inspections, immediately before exec.
const remoteResumeScript = `import os,sys,json,subprocess,io,contextlib,ipaddress
request=json.loads(sys.argv[1]);storage_code,provenance_code,probe_code=sys.argv[2:5]
p=request["plan"];i=request["instance"];store=request["storeId"]
def execute(code,args):
 old=sys.argv;sys.argv=["resume-check"]+args;scope={}
 try:
  with contextlib.redirect_stdout(io.StringIO()): exec(code,scope)
  return scope
 finally: sys.argv=old
def storage(mode,path): return execute(storage_code,[mode,path])["result"]
def volume_safe(c):
 return c.get("identity","")!="" and not c.get("systemDisk",True) and (c.get("volumeType") in ("ssd","hdd") or (c.get("volumeType")=="virtual" and c.get("verifiedDataPool",False)))
def media_safe(c): return volume_safe(c) and c.get("mediaReadAllowed",False)
def data_safe(c): return volume_safe(c) and c.get("installAllowed",False)
try:
 execute(probe_code,[])
 raw=json.loads(subprocess.check_output(["docker","container","inspect",i["containerId"]],text=True))
 if len(raw)!=1: sys.exit(3)
 c=raw[0];config=c.get("Config",{});labels=config.get("Labels") or {}
 if c.get("Id")!=i["containerId"] or c.get("Name")!="/"+p["containerName"] or config.get("Image")!=p["image"] or labels.get("io.spacedesktop.store")!=store or labels.get("io.spacedesktop.instance")!=i["id"]: sys.exit(3)
 mounts=c.get("Mounts",[]);expected=p["mounts"]
 if len(mounts)!=len(expected): sys.exit(3)
 for m in expected:
  if not any(h.get("Type")=="bind" and h.get("Source")==m["source"] and h.get("Destination")==m["target"] and h.get("RW")== (not m["readOnly"]) for h in mounts): sys.exit(3)
 bindings=c.get("HostConfig",{}).get("PortBindings") or {};key=str(p["containerPort"])+"/tcp"
 if list(bindings.keys())!=[key] or len(bindings[key])!=1: sys.exit(3)
 port=bindings[key][0]
 if int(port.get("HostPort",0))!=p["hostPort"] or str(ipaddress.ip_address(port.get("HostIp") or "0.0.0.0"))!=p["publishHost"]: sys.exit(3)
 data=storage("inspect",p["rootPath"]);cache=storage("docker","")
 if not data_safe(data) or data["identity"]!=p["storageIdentity"] or data.get("freeBytes",0)<2**30: sys.exit(3)
 if not data_safe(cache) or cache.get("volumeType") not in ("ssd","hdd") or cache["identity"]!=p["dockerStorageIdentity"] or cache.get("freeBytes",0)<2**31: sys.exit(3)
 if p.get("mediaPath"):
  media=storage("inspect",p["mediaRootPath"])
  if not media_safe(media) or media["identity"]!=p["mediaStorageIdentity"]: sys.exit(3)
  root=p["mediaRootPath"];path=p["mediaPath"]
  if os.path.normpath(path)!=path or (path!=root and not path.startswith(root+"/")): sys.exit(3)
  fd=os.open("/",os.O_RDONLY|os.O_DIRECTORY)
  try:
   for part in path.split("/")[1:]:
    new=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=new
  finally: os.close(fd)
 pin=i["provenance"]
 if not store or pin["marker"]!=store+":"+i["id"]: sys.exit(3)
 execute(provenance_code,[p["rootPath"],p["dataPath"],"verify",json.dumps(pin)])
 os.execvp("docker",["docker","container","start",i["containerId"]])
except Exception: sys.exit(3)
`
