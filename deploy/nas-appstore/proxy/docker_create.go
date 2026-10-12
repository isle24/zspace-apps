package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
)

type createInput struct {
	Name    string `json:"name"`
	ImageID string `json:"imageId"`
	Ports   []struct {
		Host      int    `json:"host"`
		Container int    `json:"container"`
		Protocol  string `json:"protocol"`
	} `json:"ports"`
	Volumes []struct {
		Name   string `json:"name"`
		Target string `json:"target"`
	} `json:"volumes"`
	Environment []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	} `json:"environment"`
}

var containerName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$`)
var imageID = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

func dockerCreate(w http.ResponseWriter, r *http.Request) {
	var input createInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10))
	decoder.DisallowUnknownFields()
	invalid := func() {
		writeJSON(w, 400, map[string]any{"error": "invalid-create", "hint": "请检查名称、镜像、端口和数据卷参数"})
	}
	if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF || !containerName.MatchString(input.Name) || input.Name == "space-desktop" || !imageID.MatchString(input.ImageID) || len(input.Ports) > 16 || len(input.Volumes) > 16 || len(input.Environment) > 64 {
		invalid()
		return
	}
	mounts := []map[string]any{}
	targets := map[string]bool{}
	for _, v := range input.Volumes {
		if !containerName.MatchString(v.Name) || !strings.HasPrefix(v.Name, "space-client-") || v.Target == "/" || !strings.HasPrefix(v.Target, "/") || path.Clean(v.Target) != v.Target || strings.ContainsAny(v.Target, "\x00\r\n") || targets[v.Target] {
			invalid()
			return
		}
		for _, prefix := range []string{"/proc", "/sys", "/dev", "/var/run", "/run"} {
			if v.Target == prefix || strings.HasPrefix(v.Target, prefix+"/") {
				invalid()
				return
			}
		}
		targets[v.Target] = true
		mounts = append(mounts, map[string]any{"Type": "volume", "Source": v.Name, "Target": v.Target})
	}
	ports := map[string]any{}
	bindings := map[string]any{}
	hosts := map[int]bool{}
	for _, p := range input.Ports {
		if p.Host < 1 || p.Host > 65535 || p.Container < 1 || p.Container > 65535 || (p.Protocol != "tcp" && p.Protocol != "udp") || hosts[p.Host] {
			invalid()
			return
		}
		hosts[p.Host] = true
		key := strconv.Itoa(p.Container) + "/" + p.Protocol
		if _, exists := ports[key]; exists {
			invalid()
			return
		}
		ports[key] = map[string]any{}
		bindings[key] = []map[string]string{{"HostIp": "0.0.0.0", "HostPort": strconv.Itoa(p.Host)}}
	}
	env := []string{}
	names := map[string]bool{}
	for _, e := range input.Environment {
		if !envName.MatchString(e.Name) || len(e.Value) > 4096 || strings.ContainsAny(e.Value, "\x00\r\n") || names[e.Name] {
			invalid()
			return
		}
		names[e.Name] = true
		env = append(env, e.Name+"="+e.Value)
	}
	image, status, err := dockerGet("/images/" + input.ImageID + "/json")
	var identity struct {
		ID string `json:"Id"`
	}
	if err != nil || status != 200 || json.Unmarshal(image, &identity) != nil || identity.ID != input.ImageID {
		writeJSON(w, 409, map[string]any{"error": "image-changed", "hint": "本地镜像已不存在，请重新选择"})
		return
	}
	for _, volume := range input.Volumes {
		if !managedVolume(r, volume.Name) {
			writeJSON(w, 409, map[string]any{"error": "volume-not-owned", "hint": "同名数据卷已有其他归属或使用宿主路径，请换一个数据卷名称"})
			return
		}
	}
	payload := map[string]any{"Image": input.ImageID, "Env": env, "ExposedPorts": ports, "Labels": map[string]string{"space.client.managed": "true"}, "HostConfig": map[string]any{"Mounts": mounts, "PortBindings": bindings, "RestartPolicy": map[string]string{"Name": "unless-stopped"}, "SecurityOpt": []string{"no-new-privileges:true"}}}
	if compose, ok := r.Context().Value(composeKey{}).(composeContext); ok {
		labels := payload["Labels"].(map[string]string)
		labels["com.docker.compose.project"] = compose.Project
		labels["com.docker.compose.service"] = compose.Service
		labels["com.docker.compose.version"] = "space-client-1"
		host := payload["HostConfig"].(map[string]any)
		host["NetworkMode"] = compose.Network
		host["RestartPolicy"] = map[string]string{"Name": compose.Restart}
		payload["NetworkingConfig"] = map[string]any{"EndpointsConfig": map[string]any{compose.Network: map[string]any{"Aliases": []string{compose.Service}}}}
		if len(compose.Command) > 0 {
			payload["Cmd"] = compose.Command
		}
		if len(compose.Entrypoint) > 0 {
			payload["Entrypoint"] = compose.Entrypoint
		}
	}

	raw, _ := json.Marshal(payload)
	request, _ := http.NewRequestWithContext(r.Context(), "POST", "http://docker/containers/create?name="+url.QueryEscape(input.Name), strings.NewReader(string(raw)))
	request.Header.Set("Content-Type", "application/json")
	response, err := dockerClient().Do(request)
	if err != nil {
		writeJSON(w, 502, map[string]any{"error": "create-unconfirmed", "hint": "创建结果尚未确认，请先刷新容器列表，避免重复创建"})
		return
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 65536))
	if response.StatusCode != 201 || err != nil {
		writeJSON(w, 409, map[string]any{"error": "create-failed", "hint": "Docker 拒绝创建，名称可能已占用，请检查后重试"})
		return
	}
	var created struct {
		ID string `json:"Id"`
	}
	if json.Unmarshal(body, &created) != nil || !fullContainerID.MatchString(created.ID) {
		writeJSON(w, 502, map[string]any{"error": "create-unconfirmed", "hint": "容器已提交创建，请刷新查看结果"})
		return
	}
	result, err := inspectContainer(created.ID)
	if err != nil || strings.TrimPrefix(result.Name, "/") != input.Name {
		writeJSON(w, 409, map[string]any{"error": "create-unconfirmed", "hint": "创建结果尚未确认，请刷新容器列表"})
		return
	}
	writeJSON(w, 201, map[string]any{"id": result.ID, "state": result.State.Status})
}

// A name prefix alone is not ownership: a local volume can carry bind-driver
// options pointing at the host. Existing volumes must be ordinary volumes
// created by this adapter. New volume responses are checked for the same shape.
func managedVolume(r *http.Request, name string) bool {
	body, status, err := dockerGet("/volumes/" + url.PathEscape(name))
	if err != nil {
		return false
	}
	if status == 404 {
		raw, _ := json.Marshal(map[string]any{"Name": name, "Driver": "local", "Labels": map[string]string{"space.client.managed": "true"}})
		request, _ := http.NewRequestWithContext(r.Context(), "POST", "http://docker/volumes/create", strings.NewReader(string(raw)))
		request.Header.Set("Content-Type", "application/json")
		response, e := dockerClient().Do(request)
		if e != nil {
			return false
		}
		defer response.Body.Close()
		if response.StatusCode != 201 {
			return false
		}
		body, err = io.ReadAll(io.LimitReader(response.Body, 65536))
		if err != nil {
			return false
		}
	} else if status != 200 {
		return false
	}
	var volume struct {
		Name    string            `json:"Name"`
		Driver  string            `json:"Driver"`
		Options map[string]string `json:"Options"`
		Labels  map[string]string `json:"Labels"`
	}
	return json.Unmarshal(body, &volume) == nil && volume.Name == name && volume.Driver == "local" && len(volume.Options) == 0 && volume.Labels["space.client.managed"] == "true"
}
