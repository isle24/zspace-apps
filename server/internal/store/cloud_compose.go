package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

const cloudComposeLimit = 128 << 10

// Import supports the restricted single-container publishing model. Anything
// whose semantics that model cannot represent is rejected before making a draft.
func parseCloudCompose(input string) (CloudApp, []string, error) {
	invalid := errors.New("Compose 包含不支持的配置，请检查字段或手动添加应用。")
	if len(input) == 0 || len(input) > cloudComposeLimit {
		return CloudApp{}, nil, invalid
	}
	dec := yaml.NewDecoder(strings.NewReader(input))
	var document yaml.Node
	if dec.Decode(&document) != nil || len(document.Content) != 1 || dec.Decode(&yaml.Node{}) != io.EOF {
		return CloudApp{}, nil, invalid
	}
	count := 0
	if !cloudComposeNodesSafe(&document, 0, &count) {
		return CloudApp{}, nil, invalid
	}
	root, err := cloudComposeMap(document.Content[0], "name", "version", "services", "volumes")
	if err != nil {
		return CloudApp{}, nil, invalid
	}
	services, err := cloudComposeMap(root["services"])
	if err != nil || len(services) == 0 {
		return CloudApp{}, nil, invalid
	}
	if len(services) != 1 {
		return CloudApp{}, nil, errors.New("当前导入支持单服务 Compose；检测到多个服务，未导入任何服务。请保留完整配置并使用多服务清单方式。")
	}
	warnings := []string{"Compose 已转换为可编辑草稿，保存和发布前请核对简介、版本及安装参数。"}
	if root["version"] != nil {
		warnings = append(warnings, "Compose 格式版本不影响应用版本，应用版本按镜像标签填写。")
	}
	declaredVolumes := map[string]bool{}
	if root["volumes"] != nil {
		volumes, err := cloudComposeMap(root["volumes"])
		if err != nil {
			return CloudApp{}, nil, invalid
		}
		for name, node := range volumes {
			if node.Tag != "!!null" {
				v, err := cloudComposeMap(node)
				if err != nil || len(v) != 0 {
					return CloudApp{}, nil, errors.New("暂不支持 external、driver 或带选项的数据卷。")
				}
			}
			declaredVolumes[name] = true
		}
	}
	var serviceName string
	var serviceNode *yaml.Node
	for name, node := range services {
		serviceName = name
		serviceNode = node
	}
	svc, err := cloudComposeMap(serviceNode, "image", "ports", "expose", "volumes", "environment", "restart", "container_name")
	if err != nil {
		return CloudApp{}, nil, errors.New("Compose 服务包含无法保留的选项；不支持 build、command、entrypoint、privileged、host 网络/PID、设备或额外权限。")
	}
	imageRef, err := cloudComposeText(svc["image"])
	if err != nil {
		return CloudApp{}, nil, invalid
	}
	ref, err := cloudImageReference(imageRef)
	if err != nil {
		return CloudApp{}, nil, errors.New("镜像仅支持公开 Docker Hub 或 GHCR 引用，不支持变量或本地镜像。")
	}
	id := strings.ToLower(strings.ReplaceAll(serviceName, "_", "-"))
	if root["name"] != nil {
		id, err = cloudComposeText(root["name"])
		if err != nil {
			return CloudApp{}, nil, invalid
		}
	}
	if !cloudAppIDRE.MatchString(id) {
		return CloudApp{}, nil, errors.New("Compose 应用或服务名称需要使用小写字母、数字和短横线。")
	}
	version := ref.Identifier()
	if strings.HasPrefix(version, "sha256:") {
		version = "1.0.0"
		warnings = append(warnings, "镜像使用 digest 引用，请补充应用版本。")
	} else if version == "latest" {
		warnings = append(warnings, "镜像使用 latest 标签，请确认应用版本。")
	}
	app := CloudApp{ID: id, Name: serviceName, Description: fmt.Sprintf("通过 Docker Compose 导入的 %s 应用。请补充应用功能及使用说明。", serviceName), Category: "tools", Image: imageRef, Version: version, DataTargets: []string{}, Environment: []CloudEnvironment{}}
	ports := map[int]bool{}
	for _, key := range []string{"ports", "expose"} {
		if svc[key] == nil {
			continue
		}
		if svc[key].Kind != yaml.SequenceNode {
			return CloudApp{}, nil, invalid
		}
		for _, node := range svc[key].Content {
			target, err := cloudComposePort(node, key == "ports")
			if err != nil {
				return CloudApp{}, nil, err
			}
			ports[target] = true
		}
	}
	if len(ports) > 1 {
		return CloudApp{}, nil, errors.New("当前应用模板只支持一个 TCP 访问端口；检测到多个端口，未导入。")
	}
	for target := range ports {
		app.ContainerPort = target
	}
	if app.ContainerPort == 0 {
		app.ContainerPort = 8080
		warnings = append(warnings, "Compose 未声明端口，暂填 8080，请核对容器的访问端口。")
	} else if svc["ports"] != nil {
		warnings = append(warnings, "主机访问端口由 NAS 安装时分配，草稿仅保留容器内端口。")
	}
	if svc["container_name"] != nil {
		if _, err := cloudComposeText(svc["container_name"]); err != nil {
			return CloudApp{}, nil, invalid
		}
		warnings = append(warnings, "容器名称由 NAS 自动生成。")
	}
	if svc["restart"] != nil {
		restart, err := cloudComposeText(svc["restart"])
		if err != nil {
			return CloudApp{}, nil, invalid
		}
		if restart != "unless-stopped" && restart != "always" {
			return CloudApp{}, nil, errors.New("当前应用模板使用持续运行重启策略，不支持此 restart 配置。")
		}
		warnings = append(warnings, "容器使用商店的 unless-stopped 重启策略。")
	}
	if svc["volumes"] != nil {
		if svc["volumes"].Kind != yaml.SequenceNode {
			return CloudApp{}, nil, invalid
		}
		targets := map[string]bool{}
		for _, node := range svc["volumes"].Content {
			target, source, err := cloudComposeVolume(node)
			if err != nil {
				return CloudApp{}, nil, err
			}
			if source != "" && !strings.Contains(source, "/") && !strings.HasPrefix(source, ".") && !declaredVolumes[source] {
				return CloudApp{}, nil, errors.New("命名卷未在 Compose volumes 中声明。")
			}
			if targets[target] {
				return CloudApp{}, nil, errors.New("容器数据目录重复，未导入。")
			}
			targets[target] = true
			app.DataTargets = append(app.DataTargets, target)
		}
		if len(app.DataTargets) > 0 {
			warnings = append(warnings, "原主机路径和卷名称不会进入应用资料，数据由 NAS 安装时选择的目录保存。")
		}
	}
	if svc["environment"] != nil {
		envNode := svc["environment"]
		envs := map[string]*yaml.Node{}
		switch envNode.Kind {
		case yaml.MappingNode:
			envs, err = cloudComposeMap(envNode)
		case yaml.SequenceNode:
			for _, node := range envNode.Content {
				entry, e := cloudComposeText(node)
				if e != nil {
					return CloudApp{}, nil, invalid
				}
				name, value, hasValue := strings.Cut(entry, "=")
				if _, exists := envs[name]; exists {
					return CloudApp{}, nil, invalid
				}
				if hasValue {
					envs[name] = &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value}
				} else {
					envs[name] = &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!null"}
				}
			}
		default:
			err = invalid
		}
		if err != nil {
			return CloudApp{}, nil, invalid
		}
		names := make([]string, 0, len(envs))
		for name := range envs {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			node := envs[name]
			if node.Kind != yaml.ScalarNode {
				return CloudApp{}, nil, invalid
			}
			env := CloudEnvironment{Name: name, Label: name, Secret: cloudSensitiveEnvRE.MatchString(name)}
			if env.Secret {
				warnings = append(warnings, "秘密变量 "+name+" 已改为安装时填写，原始值不会保存。")
			} else if node.Tag == "!!null" || strings.Contains(node.Value, "$") {
				warnings = append(warnings, "变量 "+name+" 需要在安装时确认并填写。")
			} else {
				env.Default = cloudString(node.Value)
			}
			app.Environment = append(app.Environment, env)
		}
	}
	if !cloudValidateApp(app) {
		return CloudApp{}, nil, errors.New("应用资料、数据目录或环境变量未通过安全校验，未导入。")
	}
	return app, warnings, nil
}
func cloudComposeNodesSafe(n *yaml.Node, depth int, count *int) bool {
	*count++
	if depth > 16 || *count > 2048 || n.Kind == yaml.AliasNode || n.Anchor != "" {
		return false
	}
	for _, child := range n.Content {
		if !cloudComposeNodesSafe(child, depth+1, count) {
			return false
		}
	}
	return true
}
func cloudComposeMap(node *yaml.Node, allowed ...string) (map[string]*yaml.Node, error) {
	invalid := errors.New("unsupported Compose object")
	if node == nil || node.Kind != yaml.MappingNode {
		return nil, invalid
	}
	allow := map[string]bool{}
	for _, key := range allowed {
		allow[key] = true
	}
	out := map[string]*yaml.Node{}
	for i := 0; i < len(node.Content); i += 2 {
		key := node.Content[i]
		if key.Kind != yaml.ScalarNode || key.Tag != "!!str" || key.Value == "<<" {
			return nil, invalid
		}
		if _, exists := out[key.Value]; exists || len(allowed) > 0 && !allow[key.Value] {
			return nil, invalid
		}
		out[key.Value] = node.Content[i+1]
	}
	return out, nil
}
func cloudComposeText(n *yaml.Node) (string, error) {
	if n == nil || n.Kind != yaml.ScalarNode || n.Tag != "!!str" || len(n.Value) > 2048 {
		return "", errors.New("invalid Compose string")
	}
	return n.Value, nil
}
func cloudComposePort(n *yaml.Node, published bool) (int, error) {
	invalid := errors.New("暂不支持端口范围、UDP、主机 IP 绑定或带额外选项的端口映射。")
	var raw string
	if n.Kind == yaml.ScalarNode {
		raw = n.Value
		if published {
			parts := strings.Split(raw, ":")
			if len(parts) > 2 {
				return 0, invalid
			}
			if len(parts) == 2 {
				if _, err := cloudComposePortNumber(parts[0]); err != nil {
					return 0, invalid
				}
				raw = parts[1]
			}
		}
	} else if n.Kind == yaml.MappingNode && published {
		m, err := cloudComposeMap(n, "target", "published", "protocol", "host_ip", "mode")
		if err != nil || m["target"] == nil {
			return 0, invalid
		}
		for _, key := range []string{"host_ip", "mode"} {
			if m[key] != nil {
				return 0, invalid
			}
		}
		if m["protocol"] != nil && m["protocol"].Value != "tcp" {
			return 0, invalid
		}
		if m["published"] != nil {
			if _, err := cloudComposePortNumber(m["published"].Value); err != nil {
				return 0, invalid
			}
		}
		raw = m["target"].Value
	} else {
		return 0, invalid
	}
	value, protocol, hasProtocol := strings.Cut(raw, "/")
	if hasProtocol && protocol != "tcp" {
		return 0, invalid
	}
	port, err := cloudComposePortNumber(value)
	if err != nil {
		return 0, invalid
	}
	return port, nil
}
func cloudComposePortNumber(raw string) (int, error) {
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > 65535 {
		return 0, errors.New("invalid port")
	}
	return n, nil
}
func cloudComposeVolume(n *yaml.Node) (string, string, error) {
	invalid := errors.New("暂不支持只读卷、系统目录、Docker socket 或带额外选项的挂载。")
	var target, source string
	if n.Kind == yaml.ScalarNode {
		parts := strings.Split(n.Value, ":")
		switch len(parts) {
		case 1:
			target = parts[0]
		case 2:
			source, target = parts[0], parts[1]
		case 3:
			source, target = parts[0], parts[1]
			if parts[2] != "rw" {
				return "", "", invalid
			}
		default:
			return "", "", invalid
		}
	} else if n.Kind == yaml.MappingNode {
		m, err := cloudComposeMap(n, "type", "source", "target", "read_only")
		if err != nil || m["target"] == nil {
			return "", "", invalid
		}
		target, err = cloudComposeText(m["target"])
		if err != nil {
			return "", "", invalid
		}
		if m["source"] != nil {
			source, err = cloudComposeText(m["source"])
			if err != nil {
				return "", "", invalid
			}
		}
		if m["type"] != nil && m["type"].Value != "bind" && m["type"].Value != "volume" {
			return "", "", invalid
		}
		if m["read_only"] != nil && m["read_only"].Value != "false" {
			return "", "", invalid
		}
	} else {
		return "", "", invalid
	}
	if strings.ContainsAny(source, "$\\\x00\r\n") || strings.Contains(strings.ToLower(source), "docker.sock") {
		return "", "", invalid
	}
	if strings.HasPrefix(source, "/") {
		cleaned := path.Clean(source)
		for _, system := range []string{"/", "/proc", "/sys", "/dev", "/run", "/var/run", "/etc", "/bin", "/sbin", "/usr"} {
			if cleaned == system || system != "/" && strings.HasPrefix(cleaned, system+"/") {
				return "", "", invalid
			}
		}
	}
	return target, source, nil
}
func (c *cloudService) importCompose(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Compose string `json:"compose"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, cloudComposeLimit+4096)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if dec.Decode(&in) != nil || dec.Decode(&struct{}{}) != io.EOF {
		fail(w, 400, "invalid_compose", "Compose 请求格式无效或超过大小限制。")
		return
	}
	app, warnings, err := parseCloudCompose(in.Compose)
	in.Compose = ""
	if err != nil {
		fail(w, 422, "compose_unsupported", err.Error())
		return
	}
	icon, err := c.aiFallbackIcon(r.Context(), app)
	if err != nil {
		fail(w, 500, "compose_icon_failed", "无法生成应用图标。")
		return
	}
	app.Icon = icon
	respond(w, 200, map[string]any{"app": app, "warnings": warnings})
}
