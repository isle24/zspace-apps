package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"gopkg.in/yaml.v3"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
)

type composeDocument struct {
	Version  string `yaml:"version"`
	Name     string `yaml:"name"`
	Services map[string]struct {
		Image         string   `yaml:"image"`
		ContainerName string   `yaml:"container_name"`
		Ports         []string `yaml:"ports"`
		Volumes       []string `yaml:"volumes"`
		Environment   any      `yaml:"environment"`
		DependsOn     []string `yaml:"depends_on"`
		Restart       string   `yaml:"restart"`
		Command       []string `yaml:"command"`
		Entrypoint    []string `yaml:"entrypoint"`
	} `yaml:"services"`
	Volumes map[string]struct{} `yaml:"volumes"`
}
type composeService struct {
	Name       string      `json:"name"`
	Image      string      `json:"image"`
	Input      createInput `json:"-"`
	Depends    []string    `json:"-"`
	Restart    string      `json:"-"`
	Command    []string    `json:"-"`
	Entrypoint []string    `json:"-"`
}
type composePlan struct {
	Name      string           `json:"name"`
	Services  []composeService `json:"services"`
	Source    string           `json:"-"`
	Directory string           `json:"directory,omitempty"`
}
type composeContext struct {
	Project, Service, Network, Restart string
	Command, Entrypoint                []string
}
type composeKey struct{}

func parseCompose(name, source string, envSource ...string) (composePlan, error) {
	p := composePlan{Name: name}
	bad := func() (composePlan, error) {
		return p, errors.New("YAML 配置无效或包含暂不支持的字段。支持 image、端口、命名卷、环境变量、depends_on、restart 及数组格式的 command/entrypoint")
	}
	if !containerName.MatchString(name) || strings.ToLower(name) != name || name == "space-desktop" || len(source) > 100000 {
		return bad()
	}
	var envValues map[string]string
	var err error
	envText := ""
	if len(envSource) > 0 {
		envText = envSource[0]
	}
	source, envValues, err = interpolateCompose(source, envText)
	if err != nil {
		return bad()
	}
	p.Source = source
	var d composeDocument
	dec := yaml.NewDecoder(strings.NewReader(source))
	dec.KnownFields(true)
	if dec.Decode(&d) != nil || dec.Decode(&struct{}{}) != io.EOF || len(d.Services) < 1 || len(d.Services) > 8 || d.Name != "" && d.Name != name {
		return bad()
	}
	keys := []string{}
	for k := range d.Services {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		s := d.Services[k]
		if !containerName.MatchString(k) || len(k) > 32 || s.Image == "" || len(s.Image) > 256 || strings.ContainsAny(s.Image, " \r\n\t") || s.ContainerName != "" {
			return bad()
		}
		v := composeService{Name: k, Image: s.Image, Depends: s.DependsOn, Restart: s.Restart, Command: s.Command, Entrypoint: s.Entrypoint}
		v.Input.Name = name + "-" + k + "-1"
		if !containerName.MatchString(v.Input.Name) {
			return bad()
		}
		if v.Restart == "" {
			v.Restart = "unless-stopped"
		}
		if v.Restart != "no" && v.Restart != "always" && v.Restart != "unless-stopped" && v.Restart != "on-failure" {
			return bad()
		}
		for _, port := range s.Ports {
			protocol := "tcp"
			pieces := strings.Split(port, "/")
			if len(pieces) > 2 {
				return bad()
			}
			if len(pieces) == 2 {
				protocol = pieces[1]
			}
			parts := strings.Split(pieces[0], ":")
			if len(parts) != 2 {
				return bad()
			}
			h, e := strconv.Atoi(parts[0])
			c, e2 := strconv.Atoi(parts[1])
			if e != nil || e2 != nil || h < 1 || h > 65535 || c < 1 || c > 65535 || protocol != "tcp" && protocol != "udp" {
				return bad()
			}
			v.Input.Ports = append(v.Input.Ports, struct {
				Host      int    `json:"host"`
				Container int    `json:"container"`
				Protocol  string `json:"protocol"`
			}{h, c, protocol})
		}
		for _, volume := range s.Volumes {
			parts := strings.Split(volume, ":")
			if len(parts) != 2 || !containerName.MatchString(parts[0]) {
				return bad()
			}
			if _, ok := d.Volumes[parts[0]]; !ok {
				return bad()
			}
			target := parts[1]
			if target == "/" || !strings.HasPrefix(target, "/") || path.Clean(target) != target || strings.ContainsAny(target, "\x00\r\n") || !containerName.MatchString("space-client-"+name+"-"+parts[0]) {
				return bad()
			}
			for _, prefix := range []string{"/proc", "/sys", "/dev", "/run", "/var/run"} {
				if target == prefix || strings.HasPrefix(target, prefix+"/") {
					return bad()
				}
			}
			v.Input.Volumes = append(v.Input.Volumes, struct {
				Name   string `json:"name"`
				Target string `json:"target"`
			}{"space-client-" + name + "-" + parts[0], parts[1]})
		}
		env := map[string]string{}
		switch e := s.Environment.(type) {
		case nil:
		case map[string]any:
			for k, v := range e {
				if v == nil {
					if value, ok := envValues[k]; ok {
						env[k] = value
					}
					continue
				}
				env[k] = fmt.Sprint(v)
			}
		case []any:
			for _, value := range e {
				entry, ok := value.(string)
				if !ok {
					return bad()
				}
				pair := strings.SplitN(entry, "=", 2)
				if len(pair) != 2 {
					if !envName.MatchString(entry) {
						return bad()
					}
					if value, ok := envValues[entry]; ok {
						env[entry] = value
					}
					continue
				}
				if _, exists := env[pair[0]]; exists {
					return bad()
				}
				env[pair[0]] = pair[1]
			}
		default:
			return bad()
		}
		if len(s.Ports) > 16 || len(s.Volumes) > 16 || len(env) > 64 {
			return bad()
		}
		portsSeen := map[string]bool{}
		targetsSeen := map[string]bool{}
		for _, port := range v.Input.Ports {
			key := strconv.Itoa(port.Host) + "/" + port.Protocol
			if portsSeen[key] {
				return bad()
			}
			portsSeen[key] = true
		}
		for _, volume := range v.Input.Volumes {
			if targetsSeen[volume.Target] {
				return bad()
			}
			targetsSeen[volume.Target] = true
		}
		for _, list := range [][]string{v.Command, v.Entrypoint} {
			if len(list) > 128 {
				return bad()
			}
			for _, entry := range list {
				if len(entry) > 4096 || strings.ContainsAny(entry, "\x00\r\n") {
					return bad()
				}
			}
		}
		for k, value := range env {
			if !envName.MatchString(k) || len(value) > 4096 || strings.ContainsAny(value, "\x00\r\n") {
				return bad()
			}
			v.Input.Environment = append(v.Input.Environment, struct {
				Name  string `json:"name"`
				Value string `json:"value"`
			}{k, value})
		}
		p.Services = append(p.Services, v)
	}
	ordered := []composeService{}
	visited := map[string]int{}
	var visit func(string) bool
	visit = func(k string) bool {
		if visited[k] == 1 {
			return false
		}
		if visited[k] == 2 {
			return true
		}
		if _, ok := d.Services[k]; !ok {
			return false
		}
		visited[k] = 1
		for _, dep := range d.Services[k].DependsOn {
			if !visit(dep) {
				return false
			}
		}
		visited[k] = 2
		for _, s := range p.Services {
			if s.Name == k {
				ordered = append(ordered, s)
			}
		}
		return true
	}
	for _, k := range keys {
		if !visit(k) {
			return bad()
		}
	}
	p.Services = ordered
	return p, nil
}

var composeLock sync.Mutex

func enginePost(ctx context.Context, path string, payload any) ([]byte, int, error) {
	raw, _ := json.Marshal(payload)
	req, _ := http.NewRequestWithContext(ctx, "POST", "http://docker"+path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	res, e := dockerClient().Do(req)
	if e != nil {
		return nil, 0, e
	}
	defer res.Body.Close()
	b, e := io.ReadAll(io.LimitReader(res.Body, 65536))
	return b, res.StatusCode, e
}
func dockerComposeCreate(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name      string  `json:"name"`
		YAML      string  `json:"yaml"`
		Env       *string `json:"env"`
		Directory string  `json:"directory"`
		Start     *bool   `json:"start"`
		Preview   bool    `json:"preview"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 220000))
	dec.DisallowUnknownFields()
	if dec.Decode(&input) != nil || dec.Decode(&struct{}{}) != io.EOF {
		writeJSON(w, 400, map[string]any{"hint": "项目请求格式无效"})
		return
	}
	envText := ""
	if input.Env != nil {
		envText = *input.Env
	}
	p, err := parseCompose(input.Name, input.YAML, envText)
	if err != nil {
		writeJSON(w, 400, map[string]any{"hint": err.Error()})
		return
	}
	if input.Directory != "" {
		if !validComposeDirectory(input.Directory) {
			writeJSON(w, 400, map[string]any{"hint": "请选择 NAS 个人文件空间内的普通文件夹"})
			return
		}
		composeLock.Lock()
		defer composeLock.Unlock()
		p.Directory = input.Directory
		real, e := resolveComposeDirectory(r, input.Directory, p.Name)
		if e != nil {
			writeJSON(w, 409, map[string]any{"hint": e.Error()})
			return
		}
		if e = prepareOfficialCompose(r, &p); e != nil {
			writeJSON(w, 409, map[string]any{"hint": e.Error()})
			return
		}
		if input.Preview {
			writeJSON(w, 200, map[string]any{"plan": p})
			return
		}
		start := true
		if input.Start != nil {
			start = *input.Start
		}
		createOfficialCompose(w, r, p, real, input.Env, start)
		return
	}
	if input.Preview {
		writeJSON(w, 200, map[string]any{"plan": p})
		return
	}
	composeLock.Lock()
	defer composeLock.Unlock()
	ids := []string{}
	fail := func(hint string) {
		writeJSON(w, 409, map[string]any{"error": "compose-incomplete", "hint": hint, "created": ids})
	}
	for i := range p.Services {
		body, status, e := dockerGet("/images/" + url.PathEscape(p.Services[i].Image) + "/json")
		var image struct {
			ID string `json:"Id"`
		}
		if e != nil || status != 200 || json.Unmarshal(body, &image) != nil || !imageID.MatchString(image.ID) {
			fail("缺少本地镜像 " + p.Services[i].Image + "，请先在 NAS 下载该镜像，再部署项目")
			return
		}
		p.Services[i].Input.ImageID = image.ID
	}
	body, status, e := enginePost(r.Context(), "/networks/create", map[string]any{"Name": "space-client-" + p.Name + "-default", "CheckDuplicate": true, "Driver": "bridge", "Labels": map[string]string{"space.client.managed": "true", "com.docker.compose.project": p.Name}})
	var network struct {
		ID string `json:"Id"`
	}
	if e != nil || status != 201 || json.Unmarshal(body, &network) != nil || !fullContainerID.MatchString(network.ID) {
		fail("项目网络名称已占用或创建失败，请检查现有项目后重试")
		return
	}
	for _, s := range p.Services {
		payload, _ := json.Marshal(s.Input)
		req := r.Clone(context.WithValue(r.Context(), composeKey{}, composeContext{p.Name, s.Name, network.ID, s.Restart, s.Command, s.Entrypoint}))
		req.Body = io.NopCloser(bytes.NewReader(payload))
		rr := httptest.NewRecorder()
		dockerCreate(rr, req)
		if rr.Code != 201 {
			fail("服务 " + s.Name + " 创建失败。已创建的容器和数据卷保留，请在项目列表检查")
			return
		}
		var created struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(rr.Body.Bytes(), &created) != nil || !fullContainerID.MatchString(created.ID) {
			fail("创建结果尚未确认，请刷新项目列表")
			return
		}
		ids = append(ids, created.ID)
		_, status, e = enginePost(r.Context(), "/containers/"+created.ID+"/start", nil)
		if e != nil || status != 204 {
			fail("服务 " + s.Name + " 启动失败，请查看容器日志")
			return
		}
		actual, e := inspectContainer(created.ID)
		if e != nil || actual.State.Status != "running" {
			fail("服务 " + s.Name + " 没有保持运行，请查看日志")
			return
		}
	}
	writeJSON(w, 201, map[string]any{"name": p.Name, "created": ids, "state": "running"})
}
