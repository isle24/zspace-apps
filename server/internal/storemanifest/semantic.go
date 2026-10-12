package storemanifest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

func issue(p, code string) Issue { return Issue{p, code, issueMessages[code]} }

var issueMessages = map[string]string{
	"JSON_INVALID":          "Invalid JSON document.",
	"JSON_DUPLICATE_KEY":    "Duplicate JSON object key.",
	"JSON_LIMIT":            "JSON document exceeds validation limits.",
	"SCHEMA_INVALID":        "Manifest does not match the application schema.",
	"SCHEMA_UNAVAILABLE":    "Built-in schema validation is unavailable.",
	"ID_DUPLICATE":          "Identifier must be unique in its scope.",
	"REFERENCE_INVALID":     "Reference does not identify an allowed declaration.",
	"DEPENDENCY_CYCLE":      "Service dependencies must be acyclic.",
	"PATH_INVALID":          "Path must be normalized and within its declared scope.",
	"POINTER_INVALID":       "JSON pointer contains an invalid escape.",
	"IMAGE_INVALID":         "Image identity must be explicit and canonical.",
	"PLATFORM_INVALID":      "Image platform must match the runtime platforms.",
	"PORT_INVALID":          "Port declaration does not match its permission profile or purpose.",
	"port_default_conflict": "Published default listeners overlap.",
	"MOUNT_INVALID":         "Mount does not match the declared volume permissions.",
	"PARAMETER_INVALID":     "Parameter constraints or default do not match its declared type.",
	"BACKUP_INVALID":        "Backup must include the required managed logical volumes only.",
	"UPGRADE_INVALID":       "Upgrade source releases must be unique and exclude this release.",
	"CAPABILITY_MISSING":    "Manifest must declare every capability it uses.",
	"POLICY_PROTOCOL":       "Store protocol is not supported by policy.",
	"POLICY_PLATFORM":       "Runtime platform is not allowed by policy.",
	"POLICY_CAPABILITY":     "Required capability is not allowed by policy.",
	"POLICY_REGISTRY":       "Image registry is not allowed by policy.",
	"POLICY_PROFILE":        "Permission profile is not allowed by policy.",
	"POLICY_SECRET":         "Native environment secret persistence is not granted by policy.",
}

// finishIssues caps, deduplicates and sorts diagnostics without retaining input values.
func finishIssues(in []Issue) []Issue {
	sort.Slice(in, func(i, j int) bool {
		if in[i].Path != in[j].Path {
			return in[i].Path < in[j].Path
		}
		return in[i].Code < in[j].Code
	})
	out := make([]Issue, 0, min(128, len(in)))
	for _, v := range in {
		if len(out) > 0 && out[len(out)-1].Path == v.Path && out[len(out)-1].Code == v.Code {
			continue
		}
		out = append(out, v)
		if len(out) == 128 {
			break
		}
	}
	return out
}
func has(ss []string, s string) bool {
	for _, v := range ss {
		if s == v {
			return true
		}
	}
	return false
}
func control(s string) bool { return strings.IndexFunc(s, unicode.IsControl) >= 0 }
func relativeAsset(s string) bool {
	return s != "" && !strings.HasPrefix(s, "/") && !strings.ContainsAny(s, "\\%?#:") && !control(s) && path.Clean(s) == s && s != "." && s != ".." && !strings.HasPrefix(s, "../")
}
func absoluteTarget(s string) bool {
	return strings.HasPrefix(s, "/") && s != "/" && path.Clean(s) == s && !strings.ContainsAny(s, "\\%?#") && !control(s)
}
func httpPath(s string) bool {
	return strings.HasPrefix(s, "/") && !strings.HasPrefix(s, "//") && path.Clean(s) == s && !strings.ContainsAny(s, "\\%?#") && !control(s)
}
func jsonPointer(s string) bool {
	if s != "" && !strings.HasPrefix(s, "/") {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] == '~' {
			i++
			if i == len(s) || (s[i] != '0' && s[i] != '1') {
				return false
			}
		}
	}
	return !control(s)
}

var repositorySegment = regexp.MustCompile(`^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*$`)
var registryLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`)

// registryOf never normalizes implicit Docker Hub aliases or repository tags.
func registryOf(repository string) (string, bool) {
	parts := strings.Split(repository, "/")
	if len(parts) < 2 {
		return "", false
	}
	r := parts[0]
	hostname := r
	hasPort := strings.Contains(r, ":")
	if hasPort {
		h, p, e := net.SplitHostPort(r)
		if e != nil {
			return "", false
		}
		n, e := strconv.Atoi(p)
		if e != nil || n < 1 || n > 65535 || strconv.Itoa(n) != p {
			return "", false
		}
		hostname = h
	}
	if hostname == "index.docker.io" || hostname == "registry-1.docker.io" || (hostname == "docker.io" && len(parts) < 3) {
		return "", false
	}
	if hostname != "localhost" && !strings.Contains(hostname, ".") && !hasPort {
		return "", false
	}
	for _, label := range strings.Split(hostname, ".") {
		if !registryLabel.MatchString(label) {
			return "", false
		}
	}
	for _, s := range parts[1:] {
		if !repositorySegment.MatchString(s) {
			return "", false
		}
	}
	return r, true
}

func semantic(m Manifest) ([]string, []Issue) {
	var issues []Issue
	add := func(p, c string) { issues = append(issues, issue(p, c)) }
	used := map[string]bool{"profile." + m.Runtime.PermissionProfile: true}
	if len(m.Runtime.Services) > 1 {
		used["services.bundle"] = true
	}
	services := map[string]int{}
	volumes := map[string]Volume{}
	ports := map[string]map[string]Port{}
	for i, s := range m.Runtime.Services {
		p := fmt.Sprintf("/runtime/services/%d/id", i)
		if _, ok := services[s.ID]; ok {
			add(p, "ID_DUPLICATE")
		}
		services[s.ID] = i
	}
	for i, v := range m.Runtime.Volumes {
		if _, ok := volumes[v.ID]; ok {
			add(fmt.Sprintf("/runtime/volumes/%d/id", i), "ID_DUPLICATE")
		}
		volumes[v.ID] = v
		if v.Kind == "media-readonly" {
			used["volumes.media-readonly"] = true
		}
	}
	type listener struct {
		protocol, bind string
		port           int
	}
	var listeners []listener
	totalPorts := 0
	for i, s := range m.Runtime.Services {
		base := fmt.Sprintf("/runtime/services/%d", i)
		used["image."+s.Image.Type] = true
		if !has(m.Runtime.Platforms, s.Image.Platform) {
			add(base+"/image/platform", "PLATFORM_INVALID")
		}
		if s.Image.Type == "registry" {
			if s.Image.Repository == nil {
				add(base+"/image/repository", "IMAGE_INVALID")
			} else if _, ok := registryOf(*s.Image.Repository); !ok {
				add(base+"/image/repository", "IMAGE_INVALID")
			}
		}
		if s.Image.Type == "author-archive" && (s.Image.Path == nil || !relativeAsset(*s.Image.Path)) {
			add(base+"/image/path", "PATH_INVALID")
		}
		ownPorts := map[string]Port{}
		totalPorts += len(s.Ports)
		for j, p := range s.Ports {
			pp := fmt.Sprintf("%s/ports/%d", base, j)
			if _, ok := ownPorts[p.ID]; ok {
				add(pp+"/id", "ID_DUPLICATE")
			}
			ownPorts[p.ID] = p
			used["ports."+p.Protocol] = true
			if (m.Runtime.PermissionProfile == "host-monitor-v1" && p.Mode != "host") || (m.Runtime.PermissionProfile != "host-monitor-v1" && p.Mode != "container") {
				add(pp+"/mode", "PORT_INVALID")
			}
			if p.Publish && p.DefaultHostPort != nil && p.Bind != nil {
				l := listener{p.Protocol, *p.Bind, *p.DefaultHostPort}
				for _, other := range listeners {
					if l.port == other.port && l.protocol == other.protocol && (l.bind == other.bind || l.bind == "lan" || other.bind == "lan") {
						add(pp+"/defaultHostPort", "port_default_conflict")
					}
				}
				listeners = append(listeners, l)
			}
		}
		ports[s.ID] = ownPorts
		for j, dep := range s.DependsOn {
			if _, ok := services[dep]; !ok || dep == s.ID {
				add(fmt.Sprintf("%s/dependsOn/%d", base, j), "REFERENCE_INVALID")
			}
		}
		targets := map[string]bool{}
		for j, mt := range s.Mounts {
			p := fmt.Sprintf("%s/mounts/%d", base, j)
			if !absoluteTarget(mt.Target) || targets[mt.Target] {
				add(p+"/target", "PATH_INVALID")
			}
			targets[mt.Target] = true
			v, ok := volumes[mt.VolumeID]
			if !ok {
				add(p+"/volumeId", "REFERENCE_INVALID")
				continue
			}
			if v.Kind == "media-readonly" && !mt.ReadOnly {
				add(p+"/readOnly", "MOUNT_INVALID")
			}
			if v.Kind == "docker-socket" && (m.Runtime.PermissionProfile != "host-monitor-v1" || mt.Target != "/var/run/docker.sock") {
				add(p, "MOUNT_INVALID")
			}
		}
		if s.UserMode == "host-env" && s.UIDEnvironmentKey != nil && s.GIDEnvironmentKey != nil {
			if *s.UIDEnvironmentKey == *s.GIDEnvironmentKey {
				add(base+"/uidEnvironmentKey", "REFERENCE_INVALID")
			}
			for _, reserved := range []struct{ key, ref string }{{*s.UIDEnvironmentKey, "uid"}, {*s.GIDEnvironmentKey, "gid"}} {
				if value, present := s.Environment[reserved.key]; present && (value.RuntimeRef == nil || *value.RuntimeRef != reserved.ref) {
					add(base+"/environment", "REFERENCE_INVALID")
				}
			}
		}
		// Map keys are never copied into field paths: even syntactically valid keys can contain secrets.
		for _, e := range s.Environment {
			p := base + "/environment"
			if e.ParameterRef != nil {
				v, ok := m.Parameters[*e.ParameterRef]
				if !ok || v.Type == "secret" {
					add(p, "REFERENCE_INVALID")
				}
			}
			if e.SecretRef != nil {
				v, ok := m.Parameters[*e.SecretRef]
				if !ok || v.Type != "secret" {
					add(p, "REFERENCE_INVALID")
				}
			}
			if e.PortRef != nil {
				if _, ok := ownPorts[*e.PortRef]; !ok {
					add(p, "REFERENCE_INVALID")
				}
			}
			if e.ServiceRef != nil {
				if _, ok := services[*e.ServiceRef]; !ok || !has(s.DependsOn, *e.ServiceRef) || *e.ServiceRef == s.ID {
					add(p, "REFERENCE_INVALID")
				}
			}
		}
		if s.Health.Type == "http" {
			if s.Health.PortID == nil {
				add(base+"/health/portId", "REFERENCE_INVALID")
			} else if p, ok := ownPorts[*s.Health.PortID]; !ok || p.Protocol != "tcp" {
				add(base+"/health/portId", "PORT_INVALID")
			}
			if s.Health.Path == nil || !httpPath(*s.Health.Path) {
				add(base+"/health/path", "PATH_INVALID")
			}
			for _, status := range s.Health.ExpectedStatuses {
				if status >= 300 && status < 400 {
					add(base+"/health/expectedStatuses", "PORT_INVALID")
				}
			}
		}
		if s.Health.Type == "exec" {
			used["health.exec"] = true
		}
		if s.Command != nil || s.Entrypoint != nil {
			used["command.override"] = true
		}
	}
	if totalPorts > 64 {
		add("/runtime/services", "JSON_LIMIT")
	}
	if m.Metadata.Icon.Kind == "asset" && (m.Metadata.Icon.Path == nil || !relativeAsset(*m.Metadata.Icon.Path)) {
		add("/metadata/icon/path", "PATH_INVALID")
	}
	entry := m.Runtime.Entry
	if p, ok := ports[entry.ServiceID][entry.PortID]; !ok || p.Protocol != "tcp" || !p.Publish {
		add("/runtime/entry", "PORT_INVALID")
	}
	if !httpPath(entry.Path) {
		add("/runtime/entry/path", "PATH_INVALID")
	}
	init := m.Initialization
	if init.Mode == "http-json" {
		used["probe.http-json"] = true
		if init.ServiceID == nil || init.PortID == nil {
			add("/initialization", "REFERENCE_INVALID")
		} else if p, ok := ports[*init.ServiceID][*init.PortID]; !ok || p.Protocol != "tcp" {
			add("/initialization/portId", "PORT_INVALID")
		}
		if init.Path == nil || !httpPath(*init.Path) {
			add("/initialization/path", "PATH_INVALID")
		}
		if init.Pointer == nil || !jsonPointer(*init.Pointer) {
			add("/initialization/pointer", "POINTER_INVALID")
		}
	}
	for _, p := range m.Parameters {
		if p.Type == "secret" {
			used["parameters.secret"] = true
		}
		if !parameterValid(p) {
			add("/parameters", "PARAMETER_INVALID")
		}
	}
	backup := map[string]bool{}
	for i, id := range m.Backup.Volumes {
		v, ok := volumes[id]
		if !ok || v.Kind != "managed" || backup[id] {
			add(fmt.Sprintf("/backup/volumes/%d", i), "BACKUP_INVALID")
		}
		backup[id] = true
	}
	for _, v := range m.Runtime.Volumes {
		if v.Kind == "managed" && v.Role != nil && *v.Role != "cache" && !backup[v.ID] {
			add("/backup/volumes", "BACKUP_INVALID")
		}
	}
	releases := map[string]bool{}
	for i, id := range m.Upgrade.FromReleaseIDs {
		if id == m.ReleaseID || releases[id] {
			add(fmt.Sprintf("/upgrade/fromReleaseIds/%d", i), "UPGRADE_INVALID")
		}
		releases[id] = true
	}
	for cap := range used {
		if !has(m.RequiredCapabilities, cap) {
			add("/requiredCapabilities", "CAPABILITY_MISSING")
		}
	}
	order, cycle := startupOrder(m.Runtime.Services)
	if cycle {
		add("/runtime/services", "DEPENDENCY_CYCLE")
	}
	return order, finishIssues(issues)
}
func startupOrder(services []Service) ([]string, bool) {
	pending := map[string][]string{}
	for _, s := range services {
		pending[s.ID] = s.DependsOn
	}
	done := map[string]bool{}
	order := make([]string, 0, len(services))
	for len(pending) > 0 {
		var ready []string
		for id, deps := range pending {
			ok := true
			for _, dep := range deps {
				if !done[dep] {
					ok = false
					break
				}
			}
			if ok {
				ready = append(ready, id)
			}
		}
		if len(ready) == 0 {
			return nil, true
		}
		sort.Strings(ready)
		for _, id := range ready {
			order = append(order, id)
			done[id] = true
			delete(pending, id)
		}
	}
	return order, false
}
func parameterValid(p Parameter) bool {
	numeric := p.Type == "integer"
	text := p.Type == "string" || p.Type == "enum" || p.Type == "secret"
	if !numeric && (p.Minimum != nil || p.Maximum != nil) {
		return false
	}
	if !text && (p.MinLength != nil || p.MaxLength != nil || p.Pattern != nil) {
		return false
	}
	if p.Type != "enum" && p.Choices != nil {
		return false
	}
	if p.Minimum != nil && p.Maximum != nil && numberRat(*p.Minimum).Cmp(numberRat(*p.Maximum)) > 0 {
		return false
	}
	if p.MinLength != nil && p.MaxLength != nil && *p.MinLength > *p.MaxLength {
		return false
	}
	var pattern *regexp.Regexp
	if p.Pattern != nil {
		var e error
		pattern, e = regexp.Compile(*p.Pattern)
		if e != nil {
			return false
		}
	}
	if len(p.Default) == 0 {
		return true
	}
	if p.Type == "secret" {
		return false
	}
	d := json.NewDecoder(bytes.NewReader(p.Default))
	d.UseNumber()
	var value any
	if d.Decode(&value) != nil {
		return false
	}
	switch p.Type {
	case "integer":
		n, ok := value.(json.Number)
		if !ok {
			return false
		} // JSON Schema integers can use exponent notation; preserve exact comparisons.
		rat, ok := jsonInteger(n.String())
		if !ok {
			return false
		}
		if p.Minimum != nil && rat.Cmp(numberRat(*p.Minimum)) < 0 {
			return false
		}
		if p.Maximum != nil && rat.Cmp(numberRat(*p.Maximum)) > 0 {
			return false
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return false
		}
	case "string", "enum":
		s, ok := value.(string)
		if !ok {
			return false
		}
		n := utf8.RuneCountInString(s)
		if p.MinLength != nil && n < *p.MinLength {
			return false
		}
		if p.MaxLength != nil && n > *p.MaxLength {
			return false
		}
		if pattern != nil && !pattern.MatchString(s) {
			return false
		}
		if p.Type == "enum" && !has(p.Choices, s) {
			return false
		}
	default:
		return false
	}
	return true
}
