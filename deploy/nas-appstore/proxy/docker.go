// Docker 只读接口。
//
// 背景：极空间官方的 Docker 前端调用 `/docker/api/*`，nginx 把它转到本机 9123；
// 但在这台 NAS 上 9123 没有监听（官方 Docker 应用没在跑），那条路 502。
// 于是这里直接用 Docker Engine API 读真实数据——**只读**：
// 只暴露列表、详情与日志，不提供任何 create/start/stop/exec，
// 避免把容器控制权（等于宿主 root）通过局域网页面交出去。
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var dockerSocket = "/var/run/docker.sock"

// dockerAvailable 报告容器里是否挂了 docker socket。
func dockerAvailable() bool {
	info, err := os.Stat(dockerSocket)
	return err == nil && info.Mode()&os.ModeSocket != 0
}

func dockerClient() *http.Client {
	return &http.Client{
		Timeout: 20 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var dialer net.Dialer
				return dialer.DialContext(ctx, "unix", dockerSocket)
			},
		},
	}
}

func dockerGet(path string) ([]byte, int, error) {
	resp, err := dockerClient().Get("http://docker" + path)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	return body, resp.StatusCode, err
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

// 只挑界面上真的会用的字段，容器环境变量等敏感内容不下发。
type containerView struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Image   string   `json:"image"`
	State   string   `json:"state"`
	Status  string   `json:"status"`
	Created int64    `json:"created"`
	Ports   []string `json:"ports"`
	// Compose 归属：Docker 会给 compose 起的容器打这两个标签。
	// 只读地用来分组，客户端不据此做任何写操作。
	Project   string `json:"project,omitempty"`
	Service   string `json:"service,omitempty"`
	Protected bool   `json:"protected"`
}

type imageView struct {
	DisplayName string   `json:"displayName,omitempty"`
	ID          string   `json:"id"`
	Tags        []string `json:"tags"`
	Size        int64    `json:"size"`
	Created     int64    `json:"created"`
}

func dockerContainers(w http.ResponseWriter, r *http.Request) {
	if !dockerAvailable() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": "container-socket-missing",
			"hint":  "容器没有挂载 /var/run/docker.sock，无法读取 Docker 数据",
		})
		return
	}
	body, status, err := dockerGet("/containers/json?all=1")
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "docker-unreachable", "hint": err.Error()})
		return
	}
	if status != http.StatusOK {
		writeJSON(w, status, map[string]any{"error": "docker-error", "status": status})
		return
	}
	var raw []struct {
		ID      string   `json:"Id"`
		Names   []string `json:"Names"`
		Image   string   `json:"Image"`
		State   string   `json:"State"`
		Status  string   `json:"Status"`
		Created int64    `json:"Created"`
		Ports   []struct {
			IP      string `json:"IP"`
			Private int    `json:"PrivatePort"`
			Public  int    `json:"PublicPort"`
			Type    string `json:"Type"`
		} `json:"Ports"`
		Labels map[string]string `json:"Labels"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "docker-invalid"})
		return
	}
	out := make([]containerView, 0, len(raw))
	for _, row := range raw {
		name := strings.TrimPrefix(strings.Join(row.Names, ","), "/")
		ports := make([]string, 0, len(row.Ports))
		for _, p := range row.Ports {
			if p.Public > 0 {
				ports = append(ports, fmt.Sprintf("%d→%d/%s", p.Public, p.Private, p.Type))
			} else if p.Private > 0 {
				ports = append(ports, fmt.Sprintf("%d/%s", p.Private, p.Type))
			}
		}
		sort.Strings(ports)
		inspection := containerInspection{ID: row.ID, Name: name}
		inspection.Config.Labels = row.Labels
		out = append(out, containerView{
			ID: row.ID, Name: name, Image: row.Image, State: row.State,
			Status: row.Status, Created: row.Created, Ports: ports,
			Project:   row.Labels["com.docker.compose.project"],
			Service:   row.Labels["com.docker.compose.service"],
			Protected: protectedContainer(inspection),
		})
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Name < out[b].Name })
	writeJSON(w, http.StatusOK, map[string]any{"containers": out})
}

func dockerImages(w http.ResponseWriter, r *http.Request) {
	if !dockerAvailable() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": "container-socket-missing",
			"hint":  "容器没有挂载 /var/run/docker.sock，无法读取 Docker 数据",
		})
		return
	}
	body, status, err := dockerGet("/images/json")
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "docker-unreachable", "hint": err.Error()})
		return
	}
	if status != http.StatusOK {
		writeJSON(w, status, map[string]any{"error": "docker-error", "status": status})
		return
	}
	var raw []struct {
		ID       string            `json:"Id"`
		RepoTags []string          `json:"RepoTags"`
		Labels   map[string]string `json:"Labels"`
		Size     int64             `json:"Size"`
		Created  int64             `json:"Created"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "docker-invalid"})
		return
	}
	used := map[string]string{}
	if body, status, err := dockerGet("/containers/json?all=1"); err == nil && status == 200 {
		var containers []struct {
			ImageID string   `json:"ImageID"`
			Names   []string `json:"Names"`
		}
		if json.Unmarshal(body, &containers) == nil {
			for _, c := range containers {
				if len(c.Names) > 0 {
					used[c.ImageID] = strings.TrimPrefix(c.Names[0], "/")
				}
			}
		}
	}
	out := make([]imageView, 0, len(raw))
	for _, row := range raw {
		tags := row.RepoTags
		if tags == nil {
			tags = []string{}
		}
		name := strings.TrimSpace(row.Labels["org.opencontainers.image.title"])
		if name == "" && used[row.ID] != "" {
			name = "容器 " + used[row.ID] + " 的镜像"
		}
		if len(name) > 128 || strings.ContainsAny(name, "\x00\r\n") {
			name = ""
		}
		out = append(out, imageView{DisplayName: name, ID: row.ID, Tags: tags, Size: row.Size, Created: row.Created})
	}
	sort.Slice(out, func(a, b int) bool {
		an, bn := "", ""
		if len(out[a].Tags) > 0 {
			an = out[a].Tags[0]
		}
		if len(out[b].Tags) > 0 {
			bn = out[b].Tags[0]
		}
		return an < bn
	})
	writeJSON(w, http.StatusOK, map[string]any{"images": out})
}

func dockerLogs(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/docker/logs/")
	// 容器 id 只允许十六进制，避免拼出别的 API 路径
	if id == "" || len(id) > 64 || strings.Trim(id, "0123456789abcdef") != "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid-container"})
		return
	}
	tail, _ := strconv.Atoi(r.URL.Query().Get("tail"))
	if tail <= 0 || tail > 2000 {
		tail = 300
	}
	if !dockerAvailable() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "container-socket-missing"})
		return
	}
	body, status, err := dockerGet(fmt.Sprintf("/containers/%s/logs?stdout=1&stderr=1&tail=%d&timestamps=1", id, tail))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "docker-unreachable"})
		return
	}
	if status != http.StatusOK {
		writeJSON(w, status, map[string]any{"error": "docker-error", "status": status})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"lines": dockerLogLines(body)})
}

// 终端着色转义（\x1b[32m 之类）在网页里只是乱码，去掉。
var ansiPattern = regexp.MustCompile("\\x1b\\[[0-9;]*[a-zA-Z]")

// Docker 的日志是 8 字节头 + 负载的复用流，这里还原成纯文本行。
func dockerLogLines(body []byte) []string {
	lines := []string{}
	for len(body) >= 8 {
		size := int(uint32(body[4])<<24 | uint32(body[5])<<16 | uint32(body[6])<<8 | uint32(body[7]))
		if size <= 0 || 8+size > len(body) {
			break
		}
		for _, line := range strings.Split(string(body[8:8+size]), "\n") {
			line = strings.TrimRight(ansiPattern.ReplaceAllString(line, ""), "\r")
			if strings.TrimSpace(line) != "" {
				lines = append(lines, line)
			}
		}
		body = body[8+size:]
	}
	if len(lines) == 0 && len(body) > 0 { // 非复用流（TTY）
		for _, line := range strings.Split(string(body), "\n") {
			line = strings.TrimRight(ansiPattern.ReplaceAllString(line, ""), "\r")
			if strings.TrimSpace(line) != "" {
				lines = append(lines, line)
			}
		}
	}
	return lines
}

/*
 * Compose 项目视图（只读）。
 *
 * 容器数量和运行状态按 Docker 自己的 project 标签分组；官方项目元数据补充
 * 已保存但尚无容器的项目。拿不到标签的容器归到「非 Compose」，不推测归属。
 */
func dockerCompose(w http.ResponseWriter, r *http.Request) {
	if !dockerAvailable() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": "container-socket-missing",
			"hint":  "容器没有挂载 /var/run/docker.sock，无法读取 Docker 数据",
		})
		return
	}
	body, status, err := dockerGet("/containers/json?all=1")
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "docker-unreachable", "hint": err.Error()})
		return
	}
	if status != http.StatusOK {
		writeJSON(w, status, map[string]any{"error": "docker-error", "status": status})
		return
	}
	var raw []struct {
		Names  []string          `json:"Names"`
		State  string            `json:"State"`
		Status string            `json:"Status"`
		Labels map[string]string `json:"Labels"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "docker-invalid"})
		return
	}
	type project struct {
		Name      string   `json:"name"`
		Running   int      `json:"running"`
		Total     int      `json:"total"`
		Services  []string `json:"services"`
		State     string   `json:"state,omitempty"`
		Directory string   `json:"directory,omitempty"`
		Official  bool     `json:"official,omitempty"`
	}
	byName := map[string]*project{}
	order := []string{}
	for _, row := range raw {
		name := row.Labels["com.docker.compose.project"]
		if name == "" {
			name = "（非 Compose 容器）"
		}
		item, ok := byName[name]
		if !ok {
			item = &project{Name: name}
			byName[name] = item
			order = append(order, name)
		}
		item.Total++
		if row.State == "running" {
			item.Running++
		}
		service := row.Labels["com.docker.compose.service"]
		if service == "" {
			service = strings.TrimPrefix(strings.Join(row.Names, ","), "/")
		}
		item.Services = append(item.Services, service)
	}
	existing := map[string]bool{}
	for name := range byName {
		existing[name] = true
	}
	official, officialError := officialComposeProjects(r, existing)
	for _, saved := range official {
		item, ok := byName[saved.Name]
		if !ok {
			item = &project{Name: saved.Name, Services: []string{}, State: saved.State}
			byName[saved.Name] = item
			order = append(order, saved.Name)
		}
		item.Official = true
		item.Directory = saved.Directory
	}
	out := make([]project, 0, len(order))
	for _, name := range order {
		item := byName[name]
		if item.Running > 0 {
			item.State = "running"
		} else if item.Total > 0 {
			item.State = "stopped"
		}
		sort.Strings(item.Services)
		out = append(out, *item)
	}
	sort.Slice(out, func(a, b int) bool {
		if (out[a].Running > 0) != (out[b].Running > 0) {
			return out[a].Running > 0
		}
		return out[a].Name < out[b].Name
	})
	result := map[string]any{"projects": out}
	if officialError != nil {
		result["hint"] = "NAS 项目配置列表暂时无法读取，当前显示容器识别的项目"
	}
	writeJSON(w, http.StatusOK, result)
}

/*
 * 引擎信息（只读）。
 *
 * 只读 /info 与 /version 里**客观**的字段。刻意不提供任何"改引擎设置"的能力：
 * 那要写宿主机 daemon 配置，属于设备管理员的活，客户端不该碰。
 */
func dockerInfo(w http.ResponseWriter, r *http.Request) {
	if !dockerAvailable() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": "container-socket-missing",
			"hint":  "容器没有挂载 /var/run/docker.sock，无法读取 Docker 数据",
		})
		return
	}
	infoBody, status, err := dockerGet("/info")
	if err != nil || status != http.StatusOK {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "docker-unreachable"})
		return
	}
	versionBody, _, _ := dockerGet("/version")
	var info struct {
		ServerVersion   string `json:"ServerVersion"`
		Driver          string `json:"Driver"`
		OperatingSystem string `json:"OperatingSystem"`
		Architecture    string `json:"Architecture"`
		CPUs            int    `json:"NCPU"`
		MemoryTotal     int64  `json:"MemTotal"`
		Containers      int    `json:"Containers"`
		ContainersRun   int    `json:"ContainersRunning"`
		ContainersStop  int    `json:"ContainersStopped"`
		Images          int    `json:"Images"`
		DockerRootDir   string `json:"DockerRootDir"`
	}
	if err := json.Unmarshal(infoBody, &info); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "docker-invalid"})
		return
	}
	var ver struct {
		Version       string `json:"Version"`
		APIVersion    string `json:"ApiVersion"`
		MinAPIVersion string `json:"MinAPIVersion"`
		GoVersion     string `json:"GoVersion"`
	}
	_ = json.Unmarshal(versionBody, &ver)
	writeJSON(w, http.StatusOK, map[string]any{
		"engine": map[string]any{
			"serverVersion": info.ServerVersion,
			"apiVersion":    ver.APIVersion,
			"minApiVersion": ver.MinAPIVersion,
			"goVersion":     ver.GoVersion,
			"driver":        info.Driver,
			"os":            info.OperatingSystem,
			"architecture":  info.Architecture,
			"cpus":          info.CPUs,
			"memoryTotal":   info.MemoryTotal,
			"rootDir":       info.DockerRootDir,
		},
		"counts": map[string]any{
			"containers":     info.Containers,
			"containersRun":  info.ContainersRun,
			"containersStop": info.ContainersStop,
			"images":         info.Images,
		},
		// 客户端只读；改引擎设置要在设备上做
		"readOnly": true,
		"hint":     "只读：修改 Docker 引擎设置需要在 NAS 上操作",
	})
}
