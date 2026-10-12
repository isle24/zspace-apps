package storemanifest

import "fmt"

func SupportedCapabilities() []string {
	return []string{"services.bundle", "ports.tcp", "ports.udp", "image.registry", "image.author-archive", "profile.standard-v1", "profile.restricted-v1", "profile.host-monitor-v1", "volumes.media-readonly", "parameters.secret", "probe.http-json", "health.exec", "command.override"}
}
func PermissionProfiles() []PermissionProfile {
	return []PermissionProfile{
		{ID: "standard-v1", Network: "managed-bridge", PID: "private", CapDrop: []string{"NET_RAW"}, NoNewPrivileges: true},
		{ID: "restricted-v1", Network: "managed-bridge", PID: "private", CapDrop: []string{"ALL"}, NoNewPrivileges: true},
		{ID: "host-monitor-v1", Network: "host", PID: "host", Privileged: true, DockerSocket: true, CapDrop: []string{}},
	}
}

// CheckPolicy is data-only and fail-closed. It must be called after Parse: it
// checks local execution permission, not structural validity or runtime facts.
func CheckPolicy(m Manifest, sourceID string, p Policy) []Issue {
	var issues []Issue
	add := func(path, code string) { issues = append(issues, issue(path, code)) }
	if p.Protocol < 1 || m.MinStoreProtocol < 1 || p.Protocol < m.MinStoreProtocol {
		add("/minStoreProtocol", "POLICY_PROTOCOL")
	}
	if len(m.Runtime.Platforms) == 0 {
		add("/runtime/platforms", "POLICY_PLATFORM")
	}
	for i, platform := range m.Runtime.Platforms {
		if !has(p.Platforms, platform) {
			add(fmt.Sprintf("/runtime/platforms/%d", i), "POLICY_PLATFORM")
		}
	}
	for i, cap := range m.RequiredCapabilities {
		if !has(SupportedCapabilities(), cap) || !has(p.Capabilities, cap) {
			add(fmt.Sprintf("/requiredCapabilities/%d", i), "POLICY_CAPABILITY")
		}
	}
	profile := m.Runtime.PermissionProfile
	switch profile {
	case "standard-v1", "restricted-v1":
	case "host-monitor-v1":
		granted := false
		for _, g := range p.Grants {
			if sourceID != "" && g.SourceID == sourceID && g.AppID == m.AppID && g.Profile == profile {
				granted = true
			}
		}
		if !granted {
			add("/runtime/permissionProfile", "POLICY_PROFILE")
		}
	default:
		add("/runtime/permissionProfile", "POLICY_PROFILE")
	}
	nativeSecrets := false
	for i, s := range m.Runtime.Services {
		if s.Image.Type == "registry" {
			registry, ok := "", false
			if s.Image.Repository != nil {
				registry, ok = registryOf(*s.Image.Repository)
			}
			if !ok || !has(p.Registries, registry) {
				add(fmt.Sprintf("/runtime/services/%d/image/repository", i), "POLICY_REGISTRY")
			}
		}
		for _, e := range s.Environment {
			if e.SecretRef != nil {
				nativeSecrets = true
			}
		}
	}
	if nativeSecrets {
		granted := false
		for _, g := range p.NativeEnvironmentSecretGrants {
			if sourceID != "" && g.SourceID == sourceID && g.AppID == m.AppID {
				granted = true
			}
		}
		if !granted {
			add("/runtime/services", "POLICY_SECRET")
		}
	}
	return finishIssues(issues)
}
