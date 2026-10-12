package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

// All Docker endpoints require the client's normal NAS identity. No borrowed
// official-client session, no client-selected upstream and no credential logging.
func newDockerHandler(nas *url.URL) http.Handler {
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		write := r.URL.Path == "/api/docker/control" || r.URL.Path == "/api/docker/create" || r.URL.Path == "/api/docker/compose-create"
		method := http.MethodGet
		if write {
			method = http.MethodPost
		}
		if r.Method != method {
			w.Header().Set("Allow", method)
			writeJSON(w, 405, map[string]any{"error": "method-not-allowed", "hint": "此操作不支持当前请求方式"})
			return
		}
		if write {
			origin := r.Header.Get("Origin")
			// Native requests carry this explicit marker; browser cross-site requests
			// require preflight, which this server never authorizes.
			if r.Header.Get("X-Space-Request") != "1" || (origin != "" && origin != "http://"+r.Host && origin != "https://"+r.Host) {
				writeJSON(w, 403, map[string]any{"error": "cross-site-denied", "hint": "跨站操作已拒绝"})
				return
			}
		}
		token, err := r.Cookie("token")
		if err != nil || token.Value == "" || len(token.Value) > 8192 {
			writeJSON(w, 401, map[string]any{"error": "nas-login-required", "hint": "请先登录 NAS"})
			return
		}
		decoded, err := url.PathUnescape(token.Value)
		if err != nil {
			writeJSON(w, 401, map[string]any{"error": "nas-login-required"})
			return
		}
		form := url.Values{"token": {decoded}, "plat": {"web"}, "device": {"SpaceDesktop"}, "version": {"2.3.2026092801"}, "webagent": {"v2"}, "_l": {"zh-CN"}}
		if c, e := r.Cookie("device_id"); e == nil {
			form.Set("device_id", c.Value)
		}
		target := *nas
		target.Path = "/auth/token"
		target.RawQuery = ""
		req, err := http.NewRequestWithContext(r.Context(), "POST", target.String(), strings.NewReader(form.Encode()))
		if err != nil {
			writeJSON(w, 401, map[string]any{"error": "nas-login-required"})
			return
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Cookie", r.Header.Get("Cookie"))
		response, err := client.Do(req)
		if err != nil {
			writeJSON(w, 503, map[string]any{"error": "nas-auth-unavailable", "hint": "暂时无法校验 NAS 身份"})
			return
		}
		defer response.Body.Close()
		body, err := io.ReadAll(io.LimitReader(response.Body, 65537))
		var identity struct {
			Code    json.RawMessage `json:"code"`
			Success *bool           `json:"success"`
			Data    struct {
				Username string          `json:"username"`
				Master   json.RawMessage `json:"is_master"`
			} `json:"data"`
		}
		if err != nil || len(body) > 65536 || response.StatusCode != 200 || json.Unmarshal(body, &identity) != nil || (!strings.EqualFold(string(identity.Code), "200") && string(identity.Code) != `"200"` && string(identity.Code) != `"S000200"`) || identity.Data.Username == "" || (identity.Success != nil && !*identity.Success) {
			writeJSON(w, 401, map[string]any{"error": "nas-login-required", "hint": "NAS 登录已失效，请重新登录"})
			return
		}
		admin := string(identity.Data.Master) == "1" || string(identity.Data.Master) == "true"
		if write && !admin {
			writeJSON(w, 403, map[string]any{"error": "admin-required", "hint": "只有 NAS 管理员可以管理容器"})
			return
		}
		switch r.URL.Path {
		case "/api/docker/capabilities":
			writeJSON(w, 200, map[string]any{"manage": admin, "available": dockerAvailable()})
		case "/api/docker/containers":
			dockerContainers(w, r)
		case "/api/docker/images":
			dockerImages(w, r)
		case "/api/docker/compose":
			dockerCompose(w, DockerComposeNASRequest(r, nas, identity.Data.Username))
		case "/api/docker/info":
			dockerInfo(w, r)
		case "/api/docker/control":
			dockerControl(w, r)
		case "/api/docker/compose-create":
			dockerComposeCreate(w, DockerComposeNASRequest(r, nas, identity.Data.Username))
		case "/api/docker/create":
			dockerCreate(w, r)
		default:
			if strings.HasPrefix(r.URL.Path, "/api/docker/logs/") {
				if !admin {
					writeJSON(w, 403, map[string]any{"error": "admin-required", "hint": "只有管理员可以查看容器日志"})
					return
				}
				dockerLogs(w, r)
			} else if strings.HasPrefix(r.URL.Path, "/api/docker/details/") {
				dockerDetails(w, r)
			} else {
				writeJSON(w, 404, map[string]any{"error": "not-found"})
			}
		}
	})
}

var fullContainerID = regexp.MustCompile(`^[a-f0-9]{64}$`)

type containerInspection struct {
	ID     string `json:"Id"`
	Name   string `json:"Name"`
	Config struct {
		Image  string            `json:"Image"`
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
	State struct {
		Status     string `json:"Status"`
		ExitCode   int    `json:"ExitCode"`
		StartedAt  string `json:"StartedAt"`
		FinishedAt string `json:"FinishedAt"`
	} `json:"State"`
	HostConfig struct {
		RestartPolicy struct {
			Name string `json:"Name"`
		} `json:"RestartPolicy"`
		NetworkMode string `json:"NetworkMode"`
	} `json:"HostConfig"`
	Mounts []struct {
		Type        string `json:"Type"`
		Name        string `json:"Name"`
		Destination string `json:"Destination"`
		RW          bool   `json:"RW"`
	} `json:"Mounts"`
}

func inspectContainer(id string) (containerInspection, error) {
	var out containerInspection
	if !fullContainerID.MatchString(id) {
		return out, errors.New("invalid container")
	}
	body, status, err := dockerGet("/containers/" + id + "/json")
	if err != nil || status != 200 || json.Unmarshal(body, &out) != nil || out.ID != id {
		return out, errors.New("container unavailable")
	}
	return out, nil
}
func protectedContainer(c containerInspection) bool {
	hostname, _ := os.Hostname()
	return c.Config.Labels["io.space-store.service"] == "space-store" || strings.TrimPrefix(c.Name, "/") == "space-desktop" || c.Config.Labels["com.docker.compose.project"] == "space-desktop" || (len(hostname) >= 12 && strings.HasPrefix(c.ID, hostname))
}
func dockerDetails(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/docker/details/")
	c, err := inspectContainer(id)
	if err != nil {
		writeJSON(w, 404, map[string]any{"error": "container-unavailable", "hint": "容器已不存在或详情无法读取"})
		return
	}
	mounts := make([]map[string]any, 0, len(c.Mounts))
	for _, m := range c.Mounts {
		mounts = append(mounts, map[string]any{"type": m.Type, "name": m.Name, "target": m.Destination, "writable": m.RW})
	}
	writeJSON(w, 200, map[string]any{"id": c.ID, "name": strings.TrimPrefix(c.Name, "/"), "image": c.Config.Image, "state": c.State.Status, "exitCode": c.State.ExitCode, "startedAt": c.State.StartedAt, "restartPolicy": c.HostConfig.RestartPolicy.Name, "network": c.HostConfig.NetworkMode, "mounts": mounts, "protected": protectedContainer(c)})
}
func dockerControl(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ID     string `json:"id"`
		Action string `json:"action"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF || !fullContainerID.MatchString(input.ID) {
		writeJSON(w, 400, map[string]any{"error": "invalid-input", "hint": "容器操作参数无效"})
		return
	}
	expected := map[string]string{"start": "running", "restart": "running", "stop": "exited", "pause": "paused", "unpause": "running"}[input.Action]
	if expected == "" {
		writeJSON(w, 400, map[string]any{"error": "invalid-action", "hint": "不支持此容器操作"})
		return
	}
	before, err := inspectContainer(input.ID)
	if err != nil {
		writeJSON(w, 404, map[string]any{"error": "container-unavailable", "hint": "无法确认容器身份，请刷新"})
		return
	}
	if protectedContainer(before) {
		writeJSON(w, 403, map[string]any{"error": "protected-container", "hint": "此容器承载客户端服务，不能在这里停止或重启"})
		return
	}
	allowed := map[string][]string{"start": {"exited", "created"}, "stop": {"running", "restarting"}, "restart": {"running", "exited"}, "pause": {"running"}, "unpause": {"paused"}}
	valid := false
	for _, state := range allowed[input.Action] {
		if state == before.State.Status {
			valid = true
		}
	}
	if !valid {
		writeJSON(w, 409, map[string]any{"error": "state-changed", "hint": "容器状态已变化，请刷新后重试"})
		return
	}
	path := "/containers/" + input.ID + "/" + input.Action
	if input.Action == "stop" || input.Action == "restart" {
		path += "?t=10"
	}
	req, _ := http.NewRequestWithContext(r.Context(), "POST", "http://docker"+path, nil)
	response, err := dockerClient().Do(req)
	if err != nil {
		writeJSON(w, 502, map[string]any{"error": "control-unconfirmed", "hint": "操作结果暂时无法确认，请刷新容器状态"})
		return
	}
	io.Copy(io.Discard, io.LimitReader(response.Body, 65536))
	response.Body.Close()
	if response.StatusCode != 204 && response.StatusCode != 304 {
		writeJSON(w, 409, map[string]any{"error": "docker-control-failed", "hint": "Docker 拒绝了操作，请检查当前状态"})
		return
	}
	after, err := inspectContainer(input.ID)
	if err != nil || after.State.Status != expected {
		writeJSON(w, 409, map[string]any{"error": "state-pending", "hint": "操作已提交，状态尚未确认，请刷新查看"})
		return
	}
	writeJSON(w, 200, map[string]any{"id": after.ID, "state": after.State.Status})
}
