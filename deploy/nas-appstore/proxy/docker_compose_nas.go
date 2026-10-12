package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type composeNASKey struct{}
type composeNASContext struct {
	Target   *url.URL
	Username string
}

// The upstream and username come from the handler's verified NAS identity,
// never from project JSON. The path mapping matches official Compose picker
// 21761.fd69f36f.js, restricted here to mounted personal file roots.
func DockerComposeNASRequest(r *http.Request, nas *url.URL, username string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), composeNASKey{}, composeNASContext{nas, username}))
}

var composeIdentity = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
var composeNumericUser = regexp.MustCompile(`^[0-9].+`)
var composeConfirmationWindow = 8 * time.Second

func composeNASForm(r *http.Request, extra url.Values) (url.Values, error) {
	token, err := r.Cookie("token")
	if err != nil {
		return nil, errors.New("missing NAS identity")
	}
	value, err := url.PathUnescape(token.Value)
	if err != nil || value == "" {
		return nil, errors.New("invalid NAS identity")
	}
	form := url.Values{"token": {value}, "plat": {"web"}, "version": {"2.3.2026092801"}, "device": {"SpaceDesktop"}, "webagent": {"v2"}, "_l": {"zh-CN"}}
	for _, key := range []string{"device_id", "nasid"} {
		if c, e := r.Cookie(key); e == nil {
			form.Set(key, c.Value)
		}
	}
	for key, values := range extra {
		form[key] = values
	}
	return form, nil
}
func composeNASResponse(r *http.Request, method, endpoint string, extra url.Values, raw bool) ([]byte, error) {
	nas, ok := r.Context().Value(composeNASKey{}).(composeNASContext)
	if !ok || nas.Target == nil {
		return nil, errors.New("NAS compose writer unavailable")
	}
	form, err := composeNASForm(r, extra)
	if err != nil {
		return nil, err
	}
	target := *nas.Target
	target.Path = endpoint
	target.RawQuery = ""
	var body io.Reader
	jsonBody := method == http.MethodPost && endpoint == "/zdocker/v2/compose/list_projects"
	if method == http.MethodGet {
		target.RawQuery = form.Encode()
	} else if jsonBody {
		payload := map[string]string{}
		for key := range form {
			payload[key] = form.Get(key)
		}
		data, e := json.Marshal(payload)
		if e != nil {
			return nil, e
		}
		body = bytes.NewReader(data)
	} else {
		body = strings.NewReader(form.Encode())
	}
	request, err := http.NewRequestWithContext(r.Context(), method, target.String(), body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Cookie", r.Header.Get("Cookie"))
	if method == http.MethodPost {
		contentType := "application/x-www-form-urlencoded"
		if jsonBody {
			contentType = "application/json"
		}
		request.Header.Set("Content-Type", contentType)
	}
	client := &http.Client{Timeout: 4 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 220001))
	if err != nil || len(data) > 220000 || response.StatusCode != 200 {
		return nil, errors.New("NAS compose response unverified")
	}
	if raw {
		return data, nil
	}
	var result struct {
		Code    json.RawMessage `json:"code"`
		Success *bool           `json:"success"`
		Data    json.RawMessage `json:"data"`
	}
	if json.Unmarshal(data, &result) != nil || !((string(result.Code) == "200" || string(result.Code) == `"200"` || string(result.Code) == `"S000200"`) || (len(result.Code) == 0 && result.Success != nil && *result.Success)) || (result.Success != nil && !*result.Success) || len(result.Data) == 0 {
		return nil, errors.New("NAS compose operation rejected")
	}
	return result.Data, nil
}
func validComposeDirectory(directory string) bool {
	if len(directory) > 8192 || !strings.HasPrefix(directory, "/") || path.Clean(directory) != directory || strings.ContainsAny(directory, "\\\x00\r\n\t") || regexp.MustCompile(`[\x00-\x1f\x7f]`).MatchString(directory) || len(strings.Split(directory, "/")) > 35 {
		return false
	}
	parts := strings.Split(directory, "/")
	return len(parts) >= 4 && composeIdentity.MatchString(parts[1]) && parts[2] == "my" && parts[3] == "data"
}
func composeBool(value json.RawMessage, wanted bool) bool {
	if wanted {
		return string(value) == "true" || string(value) == "1" || string(value) == `"1"`
	}
	return string(value) == "false" || string(value) == "0" || string(value) == `"0"`
}
func resolveComposeDirectory(r *http.Request, directory, name string) (string, error) {
	if !validComposeDirectory(directory) {
		return "", errors.New("请选择 NAS 个人文件空间内的普通文件夹")
	}
	nas, ok := r.Context().Value(composeNASKey{}).(composeNASContext)
	if !ok || nas.Target == nil || !composeIdentity.MatchString(nas.Username) {
		return "", errors.New("NAS 保存目录身份尚未确认，请重新登录")
	}
	parts := strings.Split(directory, "/")
	data, err := composeNASResponse(r, "POST", "/system/polling2", nil, false)
	if err != nil {
		return "", errors.New("无法确认 NAS 文件存储空间，请重试")
	}
	var pools struct {
		Pools []struct {
			Key     string          `json:"key"`
			Mounted json.RawMessage `json:"mounted"`
		} `json:"pools"`
	}
	if json.Unmarshal(data, &pools) != nil {
		return "", errors.New("NAS 存储空间结构无法识别")
	}
	mounted := false
	for _, pool := range pools.Pools {
		if pool.Key == parts[1] && composeBool(pool.Mounted, true) {
			mounted = true
		}
	}
	if !mounted {
		return "", errors.New("此 NAS 存储空间未挂载，请重新选择目录")
	}
	// Check each directory in the selected chain through the normal file API.
	for i := 4; i <= len(parts); i++ {
		expected := strings.Join(parts[:i], "/")
		raw, e := composeNASResponse(r, "POST", "/v2/file/info", url.Values{"path": {expected}}, false)
		if e != nil {
			return "", errors.New("NAS 未确认保存文件夹，请重新选择")
		}
		var info map[string]json.RawMessage
		if json.Unmarshal(raw, &info) != nil {
			return "", errors.New("NAS 未确认保存文件夹")
		}
		if nested := info["info"]; len(nested) > 0 {
			if json.Unmarshal(nested, &info) != nil {
				return "", errors.New("NAS 未确认保存文件夹")
			}
		}
		var actual string
		_ = json.Unmarshal(info["path"], &actual)
		if actual != expected || !composeBool(info["is_dir"], true) {
			return "", errors.New("NAS 返回的保存目录不一致")
		}
		for _, key := range []string{"encrypted_path", "is_link", "is_symlink", "symlink"} {
			if value := strings.TrimSpace(string(info[key])); value != "" && value != "null" && value != `""` && !composeBool(info[key], false) {
				return "", errors.New("请选择未加密的普通文件夹")
			}
		}
	}
	user := nas.Username
	if !composeNumericUser.MatchString(user) {
		user = "_" + user
	}
	real := path.Join("/tmp/zfsv3", parts[1], user, strings.Join(parts[3:], "/"))
	for _, check := range []struct {
		endpoint, key, value string
		want                 bool
		hint                 string
	}{{"/zdocker/v2/compose/check_projectname", "project_name", name, true, "同名 Compose 项目已存在，请更换项目名称"}, {"/zdocker/v2/compose/check_projectpath", "project_path", real, false, "保存目录已有 Compose 配置或 .env，请选择新的专用文件夹"}} {
		raw, e := composeNASResponse(r, "GET", check.endpoint, url.Values{check.key: {check.value}}, false)
		var result struct {
			Result json.RawMessage `json:"result"`
		}
		if e != nil || json.Unmarshal(raw, &result) != nil || len(result.Result) == 0 {
			return "", errors.New("NAS 未确认项目名称或保存目录，请重试")
		}
		if !composeBool(result.Result, check.want) {
			return "", errors.New(check.hint)
		}
	}
	return real, nil
}

// Pin every reviewed image to its existing immutable Engine identity. The
// persisted YAML contains resolved scalar values and escaped literal dollars,
// so the official worker cannot re-interpolate them from its own environment.
func prepareOfficialCompose(r *http.Request, p *composePlan) error {
	for i := range p.Services {
		body, status, e := dockerGet("/images/" + url.PathEscape(p.Services[i].Image) + "/json")
		var image struct {
			ID string `json:"Id"`
		}
		if e != nil || status != 200 || json.Unmarshal(body, &image) != nil || !imageID.MatchString(image.ID) {
			return errors.New("缺少本地镜像 " + p.Services[i].Image + "，请先下载镜像再创建项目")
		}
		p.Services[i].Input.ImageID = image.ID
	}
	var document yaml.Node
	if yaml.Unmarshal([]byte(p.Source), &document) != nil {
		return errors.New("项目配置无法保存")
	}
	if len(document.Content) != 1 {
		return errors.New("项目配置无法保存")
	}
	root := document.Content[0]
	var services, volumes *yaml.Node
	for i := 0; i < len(root.Content); i += 2 {
		switch root.Content[i].Value {
		case "services":
			services = root.Content[i+1]
		case "volumes":
			volumes = root.Content[i+1]
		}
	}
	if services == nil {
		return errors.New("项目配置无法保存")
	}
	for i := 0; i < len(services.Content); i += 2 {
		for _, service := range p.Services {
			if services.Content[i].Value != service.Name {
				continue
			}
			node := services.Content[i+1]
			if node.Kind == yaml.AliasNode {
				node = node.Alias
			}
			environment := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
			sort.Slice(service.Input.Environment, func(i, j int) bool { return service.Input.Environment[i].Name < service.Input.Environment[j].Name })
			for _, value := range service.Input.Environment {
				environment.Content = append(environment.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value.Name}, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value.Value})
			}
			foundRestart := false
			for j := 0; j < len(node.Content); j += 2 {
				switch node.Content[j].Value {
				case "image":
					node.Content[j+1].Value = service.Input.ImageID
					node.Content[j+1].Tag = "!!str"
				case "environment":
					node.Content[j+1] = environment
				case "restart":
					node.Content[j+1] = &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: service.Restart}
					foundRestart = true
				}
			}
			if !foundRestart {
				node.Content = append(node.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "restart"}, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: service.Restart})
			}
		}
	}
	if volumes != nil {
		if volumes.Kind == yaml.AliasNode {
			volumes = volumes.Alias
		}
		for i := 0; i < len(volumes.Content); i += 2 {
			name := p.Name + "_" + volumes.Content[i].Value
			_, status, e := dockerGet("/volumes/" + url.PathEscape(name))
			if e != nil || status != 404 {
				return errors.New("项目命名数据卷已存在或归属无法确认，请更换项目名称")
			}
		}
	}
	filters, _ := json.Marshal(map[string][]string{"name": {p.Name + "_default"}})
	body, status, e := dockerGet("/networks?filters=" + url.QueryEscape(string(filters)))
	var networks []struct {
		Name string `json:"Name"`
	}
	if e != nil || status != 200 || json.Unmarshal(body, &networks) != nil {
		return errors.New("项目网络状态无法确认，请重试")
	}
	for _, network := range networks {
		if network.Name == p.Name+"_default" {
			return errors.New("同名项目网络已存在，请更换项目名称")
		}
	}
	filters, _ = json.Marshal(map[string][]string{"label": {"com.docker.compose.project=" + p.Name}})
	body, status, e = dockerGet("/containers/json?all=1&filters=" + url.QueryEscape(string(filters)))
	var containers []struct {
		ID string `json:"Id"`
	}
	if e != nil || status != 200 || json.Unmarshal(body, &containers) != nil || len(containers) > 0 {
		return errors.New("同名项目容器已存在或状态无法确认，请更换项目名称")
	}
	seen := map[*yaml.Node]bool{}
	var escape func(*yaml.Node)
	escape = func(node *yaml.Node) {
		if node == nil || seen[node] {
			return
		}
		seen[node] = true
		if node.Kind == yaml.AliasNode {
			escape(node.Alias)
			return
		}
		if node.Kind == yaml.ScalarNode && node.Tag == "!!str" {
			node.Value = strings.ReplaceAll(node.Value, "$", "$$")
		}
		for i, child := range node.Content {
			if node.Kind == yaml.MappingNode && i%2 == 0 {
				continue
			}
			escape(child)
		}
	}
	escape(&document)
	config, e := yaml.Marshal(&document)
	if e != nil || len(config) > 100000 {
		return errors.New("项目配置超过保存限制")
	}
	p.Source = string(config)
	return nil
}
func composeSavedFiles(r *http.Request, p composePlan, env *string) bool {
	data, e := composeNASResponse(r, "POST", "/zdocker/v2/compose/list_projects", nil, false)
	if e != nil {
		return false
	}
	var projects []struct {
		ID        string `json:"id"`
		Name      string `json:"projectName"`
		PathValid bool   `json:"pathValid"`
	}
	if json.Unmarshal(data, &projects) != nil {
		return false
	}
	id := ""
	for _, project := range projects {
		if project.Name == p.Name && project.PathValid && composeIdentity.MatchString(project.ID) {
			if id != "" {
				return false
			}
			id = project.ID
		}
	}
	if id == "" {
		return false
	}
	data, e = composeNASResponse(r, "GET", "/zdocker/v2/compose/get_project_file", url.Values{"project_id": {id}}, false)
	if e != nil {
		return false
	}
	var file struct {
		Exists  bool   `json:"exists"`
		Content string `json:"file_content"`
	}
	if json.Unmarshal(data, &file) != nil || !file.Exists || file.Content != p.Source {
		return false
	}
	data, e = composeNASResponse(r, "POST", "/v2/file/list", url.Values{"path": {p.Directory}, "start": {"0"}, "num": {"200"}, "show_hidden": {"1"}}, false)
	if e != nil {
		return false
	}
	var listing struct {
		List []struct {
			Name      string          `json:"name"`
			Path      string          `json:"path"`
			Directory json.RawMessage `json:"is_dir"`
		} `json:"list"`
	}
	if json.Unmarshal(data, &listing) != nil {
		return false
	}
	found := false
	for _, entry := range listing.List {
		if !composeBool(entry.Directory, false) || entry.Path != p.Directory+"/"+entry.Name {
			continue
		}
		if strings.HasSuffix(strings.ToLower(entry.Name), ".yml") || strings.HasSuffix(strings.ToLower(entry.Name), ".yaml") {
			raw, e := composeNASResponse(r, "GET", "/v2/file/download", url.Values{"path": {entry.Path}}, true)
			if e == nil && bytes.Equal(raw, []byte(p.Source)) {
				if found {
					return false
				}
				found = true
			}
		}
	}
	if !found {
		return false
	}
	if env != nil {
		data, e = composeNASResponse(r, "GET", "/v2/file/download", url.Values{"path": {p.Directory + "/.env"}}, true)
		if e != nil || string(data) != *env {
			return false
		}
	}
	return true
}
func composeServicesRunning(p composePlan) bool {
	filters, _ := json.Marshal(map[string][]string{"label": {"com.docker.compose.project=" + p.Name}})
	body, status, e := dockerGet("/containers/json?all=1&filters=" + url.QueryEscape(string(filters)))
	if e != nil || status != 200 {
		return false
	}
	var containers []struct {
		ID     string            `json:"Id"`
		Labels map[string]string `json:"Labels"`
	}
	if json.Unmarshal(body, &containers) != nil || len(containers) != len(p.Services) {
		return false
	}
	seen := map[string]bool{}
	for _, container := range containers {
		service := container.Labels["com.docker.compose.service"]
		if container.Labels["com.docker.compose.project"] != p.Name || seen[service] {
			return false
		}
		seen[service] = true
		expected := ""
		for _, s := range p.Services {
			if s.Name == service {
				expected = s.Input.ImageID
			}
		}
		actual, e := inspectContainer(container.ID)
		if e != nil || expected == "" || actual.Config.Image != expected || actual.State.Status != "running" {
			return false
		}
	}
	return true
}
func createOfficialCompose(w http.ResponseWriter, r *http.Request, p composePlan, real string, env *string, start bool) {
	form := url.Values{"project_name": {p.Name}, "path": {real}, "config": {p.Source}, "start": {strconv.FormatBool(start)}, "rw": {"false"}}
	if env != nil {
		form.Set("env", *env)
	}
	raw, e := composeNASResponse(r, "POST", "/zdocker/v2/compose/create_project", form, false)
	var created struct {
		TaskID json.RawMessage `json:"task_id"`
	}
	task := ""
	if e == nil && json.Unmarshal(raw, &created) == nil {
		if json.Unmarshal(created.TaskID, &task) != nil {
			var id int64
			if json.Unmarshal(created.TaskID, &id) == nil && id >= 0 {
				task = strconv.FormatInt(id, 10)
			}
		}
	}
	if !composeIdentity.MatchString(task) {
		writeJSON(w, 202, map[string]any{"name": p.Name, "state": "pending", "saved": false, "hint": "创建结果尚未确认，请在 NAS 项目列表检查，避免重复创建"})
		return
	}
	end := time.Now().Add(composeConfirmationWindow)
	saved := false
	for {
		saved = composeSavedFiles(r, p, env)
		if saved && (!start || composeServicesRunning(p)) {
			state := "saved"
			if start {
				state = "running"
			}
			writeJSON(w, 201, map[string]any{"name": p.Name, "state": state, "saved": true, "directory": p.Directory, "taskId": task})
			return
		}
		if time.Now().After(end) || r.Context().Err() != nil {
			break
		}
		select {
		case <-r.Context().Done():
		case <-time.After(500 * time.Millisecond):
		}
	}
	writeJSON(w, 202, map[string]any{"name": p.Name, "state": "pending", "saved": saved, "directory": p.Directory, "taskId": task})
}

type officialComposeProject struct {
	Name      string
	Directory string
	State     string
}

func officialComposeProjects(r *http.Request, existing map[string]bool) ([]officialComposeProject, error) {
	if _, ok := r.Context().Value(composeNASKey{}).(composeNASContext); !ok {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
	defer cancel()
	request := r.WithContext(ctx)
	data, e := composeNASResponse(request, "POST", "/zdocker/v2/compose/list_projects", nil, false)
	if e != nil {
		return nil, e
	}
	var rows []struct {
		ID          string `json:"id"`
		Name        string `json:"projectName"`
		PathValid   bool   `json:"pathValid"`
		Path        string `json:"path"`
		ProjectPath string `json:"projectPath"`
	}
	if json.Unmarshal(data, &rows) != nil {
		return nil, errors.New("invalid official compose projects")
	}
	mounted := map[string]bool{}
	if data, e = composeNASResponse(request, "POST", "/system/polling2", nil, false); e == nil {
		var pools struct {
			Pools []struct {
				Key     string          `json:"key"`
				Mounted json.RawMessage `json:"mounted"`
			} `json:"pools"`
		}
		if json.Unmarshal(data, &pools) == nil {
			for _, pool := range pools.Pools {
				if composeIdentity.MatchString(pool.Key) && composeBool(pool.Mounted, true) {
					mounted[pool.Key] = true
				}
			}
		}
	}
	nas := r.Context().Value(composeNASKey{}).(composeNASContext)
	user := nas.Username
	if !composeNumericUser.MatchString(user) {
		user = "_" + user
	}
	out := []officialComposeProject{}
	seen := map[string]bool{}
	for _, row := range rows {
		if !containerName.MatchString(row.Name) || !composeIdentity.MatchString(row.ID) || seen[row.Name] {
			continue
		}
		seen[row.Name] = true
		item := officialComposeProject{Name: row.Name, State: "unknown"}
		for _, candidate := range []string{row.Path, row.ProjectPath} {
			virtual := candidate
			if strings.HasPrefix(candidate, "/tmp/zfsv3/") && composeIdentity.MatchString(nas.Username) {
				for pool := range mounted {
					prefix := "/tmp/zfsv3/" + pool + "/" + user + "/data"
					if candidate == prefix || strings.HasPrefix(candidate, prefix+"/") {
						virtual = "/" + pool + "/my/data" + strings.TrimPrefix(candidate, prefix)
						break
					}
				}
			}
			if validComposeDirectory(virtual) && mounted[strings.Split(virtual, "/")[1]] {
				item.Directory = virtual
				break
			}
		}
		if !existing[row.Name] && row.PathValid && ctx.Err() == nil {
			file, e := composeNASResponse(request, "GET", "/zdocker/v2/compose/get_project_file", url.Values{"project_id": {row.ID}}, false)
			var result struct {
				Exists bool `json:"exists"`
			}
			if e == nil && json.Unmarshal(file, &result) == nil && result.Exists {
				item.State = "saved"
			}
		}
		out = append(out, item)
	}
	return out, nil
}
