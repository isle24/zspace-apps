package storemanifest

import (
	"bytes"
	"testing"
)

func TestPolicy(t *testing.T) {
	d, is := Parse(example(t, "datatotal"))
	if d == nil || len(is) > 0 {
		t.Fatalf("fixture invalid: %v", is)
	}
	m := d.Manifest
	m.AppID = "unfamiliar-tool"
	p := Policy{Protocol: 1, Platforms: []string{"linux/amd64"}, Capabilities: SupportedCapabilities(), Registries: []string{"docker.io"}, Grants: []Grant{{"source", "unfamiliar-tool", "host-monitor-v1"}}, NativeEnvironmentSecretGrants: []AppGrant{{"source", "unfamiliar-tool"}}}
	if is := CheckPolicy(m, "source", p); len(is) > 0 {
		t.Fatalf("exact policy rejected %v", is)
	}
	for n, f := range map[string]func(*Policy){"zero": func(p *Policy) { *p = Policy{} }, "protocol": func(p *Policy) { p.Protocol = 0 }, "platform": func(p *Policy) { p.Platforms = nil }, "capability": func(p *Policy) { p.Capabilities = nil }, "registry": func(p *Policy) { p.Registries = []string{"docker.io.evil"} }, "profile-grant": func(p *Policy) { p.Grants = []Grant{{"other", "unfamiliar-tool", "host-monitor-v1"}} }, "secret-grant": func(p *Policy) { p.NativeEnvironmentSecretGrants = nil }} {
		t.Run(n, func(t *testing.T) {
			q := p
			f(&q)
			if is := CheckPolicy(m, "source", q); len(is) == 0 {
				t.Fatal("missing policy accepted")
			}
		})
	}
	if len(CheckPolicy(m, "other", p)) == 0 {
		t.Fatal("wrong source accepted")
	}
}
func TestPolicyStandardNeedsNoGrant(t *testing.T) {
	d, is := Parse(validManifestBytes(t))
	if d == nil || len(is) > 0 {
		t.Fatalf("fixture %v", is)
	}
	p := Policy{Protocol: 1, Platforms: []string{"linux/amd64"}, Capabilities: SupportedCapabilities()}
	for _, profile := range []string{"standard-v1", "restricted-v1"} {
		m := d.Manifest
		m.Runtime.PermissionProfile = profile
		m.RequiredCapabilities = append([]string(nil), m.RequiredCapabilities...)
		for i, cap := range m.RequiredCapabilities {
			if cap == "profile.restricted-v1" {
				m.RequiredCapabilities[i] = "profile." + profile
			}
		}
		doc, issues := Parse(encode(t, m))
		if doc == nil || len(issues) > 0 {
			t.Fatalf("valid profile rejected %v", issues)
		}
		if issues := CheckPolicy(doc.Manifest, "source", p); len(issues) > 0 {
			t.Fatalf("ordinary profile requires grant %v", issues)
		}
	}
}
func TestPolicyFreshProfilesAndCapabilities(t *testing.T) {
	p := PermissionProfiles()
	if len(p) != 3 || p[0].Network != "managed-bridge" || p[0].CapDrop[0] != "NET_RAW" || !p[0].NoNewPrivileges || p[1].CapDrop[0] != "ALL" || p[2].Network != "host" || !p[2].Privileged || !p[2].DockerSocket {
		t.Fatalf("incorrect profiles %v", p)
	}
	p[0].CapDrop[0] = "changed"
	p[0].ID = "changed"
	c := SupportedCapabilities()
	c[0] = "changed"
	if PermissionProfiles()[0].CapDrop[0] != "NET_RAW" || PermissionProfiles()[0].ID != "standard-v1" || SupportedCapabilities()[0] == "changed" {
		t.Fatal("global state mutable")
	}
}
func TestPolicyDoesNotMutateInputs(t *testing.T) {
	d, is := Parse(example(t, "datatotal"))
	if d == nil || len(is) > 0 {
		t.Fatal(is)
	}
	p := Policy{Protocol: 1, Platforms: []string{"linux/amd64"}, Capabilities: SupportedCapabilities(), Registries: []string{"docker.io"}, Grants: []Grant{{"source", d.Manifest.AppID, "host-monitor-v1"}}, NativeEnvironmentSecretGrants: []AppGrant{{"source", d.Manifest.AppID}}}
	before := encode(t, []any{d.Manifest, p})
	CheckPolicy(d.Manifest, "source", p)
	if !bytes.Equal(before, encode(t, []any{d.Manifest, p})) {
		t.Fatal("policy mutated its arguments")
	}
}
func TestPolicyExactAppGrantsAndAdditionalCapabilities(t *testing.T) {
	d, is := Parse(example(t, "datatotal"))
	if d == nil || len(is) > 0 {
		t.Fatal(is)
	}
	m := d.Manifest
	m.AppID = "new-bundle"
	p := Policy{Protocol: 1, Platforms: []string{"linux/amd64"}, Capabilities: SupportedCapabilities(), Registries: []string{"docker.io"}, Grants: []Grant{{"source", m.AppID, "host-monitor-v1"}}, NativeEnvironmentSecretGrants: []AppGrant{{"source", m.AppID}}}
	for _, f := range []func(*Policy){func(p *Policy) { p.Grants[0].AppID = "other" }, func(p *Policy) { p.Grants[0].Profile = "standard-v1" }, func(p *Policy) { p.NativeEnvironmentSecretGrants[0].AppID = "other" }, func(p *Policy) { p.NativeEnvironmentSecretGrants[0].SourceID = "other" }} {
		q := p
		q.Grants = append([]Grant(nil), p.Grants...)
		q.NativeEnvironmentSecretGrants = append([]AppGrant(nil), p.NativeEnvironmentSecretGrants...)
		f(&q)
		if len(CheckPolicy(m, "source", q)) == 0 {
			t.Fatal("inexact grant accepted")
		}
	}
	m.RequiredCapabilities = append(m.RequiredCapabilities, "health.exec")
	p.Capabilities = []string{"image.registry", "ports.tcp", "profile.host-monitor-v1", "parameters.secret", "probe.http-json"}
	if len(CheckPolicy(m, "source", p)) == 0 {
		t.Fatal("extra declared capability bypassed policy")
	}
}
