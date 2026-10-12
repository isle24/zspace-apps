package storemanifest

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func example(t *testing.T, name string) []byte {
	t.Helper()
	b, e := os.ReadFile("../../../docs/contracts/store-source-v1/examples/" + name + ".json")
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func validManifestBytes(t *testing.T) []byte { return example(t, "nasreader") }
func object(t *testing.T) map[string]any {
	t.Helper()
	var m map[string]any
	if e := json.Unmarshal(validManifestBytes(t), &m); e != nil {
		t.Fatal(e)
	}
	m["appId"] = "unfamiliar-tool"
	return m
}
func runtime(m map[string]any) map[string]any { return m["runtime"].(map[string]any) }
func service(m map[string]any) map[string]any {
	return runtime(m)["services"].([]any)[0].(map[string]any)
}
func port(m map[string]any) map[string]any { return service(m)["ports"].([]any)[0].(map[string]any) }
func encode(t *testing.T, m any) []byte {
	t.Helper()
	b, e := json.Marshal(m)
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func reject(t *testing.T, b []byte) []Issue {
	t.Helper()
	d, is := Parse(b)
	if d != nil || len(is) == 0 {
		t.Fatal("unsafe manifest accepted")
	}
	return is
}
func TestExamplesAndUnfamiliarApp(t *testing.T) {
	for _, n := range []string{"nasreader", "datatotal"} {
		t.Run(n, func(t *testing.T) {
			d, is := Parse(example(t, n))
			if d == nil || len(is) > 0 {
				t.Fatalf("public example rejected: %v", is)
			}
		})
	}
	d, is := Parse(encode(t, object(t)))
	if d == nil || len(is) > 0 {
		t.Fatalf("new app rejected: %v", is)
	}
}
func TestRawIdentityIsNotCanonicalized(t *testing.T) {
	raw := append([]byte(" \n"), validManifestBytes(t)...)
	d, is := Parse(raw)
	if d == nil || len(is) > 0 {
		t.Fatalf("valid bytes rejected: %v", is)
	}
	sum := sha256.Sum256(raw)
	if d.SHA256 != hex.EncodeToString(sum[:]) || !bytes.Equal(d.Raw, raw) {
		t.Fatal("raw identity changed")
	}
	raw[0] = '\t'
	if d.Raw[0] != ' ' {
		t.Fatal("caller changed frozen bytes")
	}
}
func TestDuplicateKeys(t *testing.T) {
	for _, b := range [][]byte{bytes.Replace(validManifestBytes(t), []byte(`"appId": "nasreader"`), []byte(`"appId":"a","app\u0049d":"nasreader"`), 1), bytes.Replace(validManifestBytes(t), []byte(`"environment": {}`), []byte(`"environment":{"KEY":{"literal":"a","literal":"b"}}`), 1), []byte(`{"x":{"credential":"a","credential":"b"}}`)} {
		reject(t, b)
	}
}
func TestStrictInput(t *testing.T) {
	for _, b := range [][]byte{append(validManifestBytes(t), []byte(` {}`)...), append(validManifestBytes(t), 'x'), bytes.Repeat([]byte(" "), (1<<20)+1), []byte(strings.Repeat("[", 65) + strings.Repeat("]", 65)), []byte{'{', '"', 'x', '"', ':', '"', 0xff, '"', '}'}, []byte(`{"x":"\ud800"}`)} {
		reject(t, b)
	}
}
func TestSemanticRejection(t *testing.T) {
	cases := map[string]func(map[string]any){
		"secret-default": func(m map[string]any) {
			m["parameters"] = map[string]any{"password": map[string]any{"type": "secret", "label": "Password", "required": true, "default": "synthetic-secret"}}
		},
		"cycle":              func(m map[string]any) { service(m)["dependsOn"] = []any{"app"} },
		"missing-dependency": func(m map[string]any) { service(m)["dependsOn"] = []any{"missing"} },
		"duplicate-service":  func(m map[string]any) { runtime(m)["services"] = []any{service(m), service(m)} },
		"duplicate-volume": func(m map[string]any) {
			runtime(m)["volumes"] = append(runtime(m)["volumes"].([]any), runtime(m)["volumes"].([]any)[0])
		},
		"duplicate-port": func(m map[string]any) { service(m)["ports"] = append(service(m)["ports"].([]any), port(m)) },
		"entry-udp": func(m map[string]any) {
			port(m)["protocol"] = "udp"
			m["requiredCapabilities"] = append(m["requiredCapabilities"].([]any), "ports.udp")
		},
		"entry-private": func(m map[string]any) {
			port(m)["publish"] = false
			delete(port(m), "bind")
			delete(port(m), "defaultHostPort")
		},
		"entry-ref":       func(m map[string]any) { runtime(m)["entry"].(map[string]any)["portId"] = "missing" },
		"unsafe-http":     func(m map[string]any) { runtime(m)["entry"].(map[string]any)["path"] = "//evil.invalid" },
		"encoded-http":    func(m map[string]any) { runtime(m)["entry"].(map[string]any)["path"] = "/%2e%2e" },
		"dot-http":        func(m map[string]any) { runtime(m)["entry"].(map[string]any)["path"] = "/a/../b" },
		"redirect-health": func(m map[string]any) { service(m)["health"].(map[string]any)["expectedStatuses"] = []any{302} },
		"bad-pointer":     func(m map[string]any) { m["initialization"].(map[string]any)["pointer"] = "/x~2" },
		"unsafe-archive":  func(m map[string]any) { service(m)["image"].(map[string]any)["path"] = "artifacts/./x.tar" },
		"tag-repository": func(m map[string]any) {
			service(m)["image"] = map[string]any{"type": "registry", "repository": "docker.io/acme/app:latest", "platform": "linux/amd64", "manifestDigest": "sha256:" + strings.Repeat("a", 64)}
			m["requiredCapabilities"] = append(m["requiredCapabilities"].([]any), "image.registry")
		},
		"implicit-registry": func(m map[string]any) {
			service(m)["image"] = map[string]any{"type": "registry", "repository": "acme/app", "platform": "linux/amd64", "manifestDigest": "sha256:" + strings.Repeat("a", 64)}
			m["requiredCapabilities"] = append(m["requiredCapabilities"].([]any), "image.registry")
		},
		"wrong-profile": func(m map[string]any) {
			runtime(m)["permissionProfile"] = "host-monitor-v1"
			m["requiredCapabilities"] = append(m["requiredCapabilities"].([]any), "profile.host-monitor-v1")
		},
		"backup-omitted":     func(m map[string]any) { m["backup"].(map[string]any)["volumes"] = []any{} },
		"backup-media":       func(m map[string]any) { m["backup"].(map[string]any)["volumes"] = []any{"data", "inbox", "library"} },
		"missing-capability": func(m map[string]any) { m["requiredCapabilities"] = []any{"ports.tcp"} },
		"raw-permission":     func(m map[string]any) { service(m)["privileged"] = true },
		"wrong-mount":        func(m map[string]any) { service(m)["mounts"].([]any)[0].(map[string]any)["target"] = "/" },
		"same-mount":         func(m map[string]any) { service(m)["mounts"].([]any)[1].(map[string]any)["target"] = "/data" },
		"rw-media":           func(m map[string]any) { service(m)["mounts"].([]any)[2].(map[string]any)["readOnly"] = false },
		"bad-port-ref": func(m map[string]any) {
			service(m)["environment"] = map[string]any{"PORT": map[string]any{"portRef": "missing"}}
		},
		"undeclared-service-ref": func(m map[string]any) {
			service(m)["environment"] = map[string]any{"DB": map[string]any{"serviceRef": "app"}}
		},
		"wrong-default": func(m map[string]any) {
			m["parameters"] = map[string]any{"count": map[string]any{"type": "integer", "label": "Count", "required": true, "default": false}}
		},
		"out-of-range-default": func(m map[string]any) {
			m["parameters"] = map[string]any{"count": map[string]any{"type": "integer", "label": "Count", "required": true, "default": 3, "minimum": 4}}
		},
		"non-enum-choices": func(m map[string]any) {
			m["parameters"] = map[string]any{"name": map[string]any{"type": "string", "label": "Name", "required": true, "choices": []any{"a"}}}
		},
		"unsupported-pattern": func(m map[string]any) {
			m["parameters"] = map[string]any{"name": map[string]any{"type": "string", "label": "Name", "required": true, "pattern": "(?=a)a"}}
		},
		"wrong-restrictions": func(m map[string]any) {
			m["parameters"] = map[string]any{"flag": map[string]any{"type": "boolean", "label": "Flag", "required": true, "minimum": 0}}
		},
		"self-upgrade":       func(m map[string]any) { m["upgrade"].(map[string]any)["fromReleaseIds"] = []any{m["releaseId"]} },
		"invalid-source-uri": func(m map[string]any) { m["metadata"].(map[string]any)["sourceUrl"] = "not a uri" },
	}
	for n, f := range cases {
		t.Run(n, func(t *testing.T) { m := object(t); f(m); reject(t, encode(t, m)) })
	}
}
func TestBundleOrderAndNestedMounts(t *testing.T) {
	m := object(t)
	a := service(m)
	b := map[string]any{}
	json.Unmarshal(encode(t, a), &b)
	b["id"] = "db"
	b["ports"] = []any{}
	b["health"] = map[string]any{"type": "none"}
	a["dependsOn"] = []any{"db"}
	a["environment"] = map[string]any{"DB": map[string]any{"serviceRef": "db"}}
	a["mounts"].([]any)[1].(map[string]any)["target"] = "/data/inbox"
	runtime(m)["services"] = []any{a, b}
	m["requiredCapabilities"] = append(m["requiredCapabilities"].([]any), "services.bundle")
	d, is := Parse(encode(t, m))
	if d == nil || len(is) > 0 {
		t.Fatalf("bundle rejected %v", is)
	}
	if fmt.Sprint(d.StartupOrder) != "[db app]" {
		t.Fatalf("order %v", d.StartupOrder)
	}
}
func TestDiagnosticsAreBoundedAndRedacted(t *testing.T) {
	m := object(t)
	for i := 0; i < 180; i++ {
		m[fmt.Sprintf("synthetic-private-token-%d", i)] = "synthetic-secret"
	}
	is := reject(t, encode(t, m))
	if len(is) > 128 {
		t.Fatal("unbounded errors")
	}
	b := string(encode(t, is))
	if strings.Contains(b, "synthetic") {
		t.Fatal("input leaked into diagnostics")
	}
	for i := 1; i < len(is); i++ {
		if is[i-1].Path > is[i].Path {
			t.Fatal("unsorted diagnostics")
		}
	}
}
func TestSchemaMatchesContract(t *testing.T) {
	a, e := os.ReadFile("schemas/app-manifest.schema.json")
	if e != nil {
		t.Fatal(e)
	}
	b, e := os.ReadFile("../../../docs/contracts/store-source-v1/app-manifest.schema.json")
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(a, b) {
		t.Fatal("schema differs from approved contract")
	}
}
func TestConcurrentParse(t *testing.T) {
	raw := validManifestBytes(t)
	var w sync.WaitGroup
	for i := 0; i < 20; i++ {
		w.Add(1)
		go func() {
			defer w.Done()
			for j := 0; j < 10; j++ {
				d, is := Parse(raw)
				if d == nil || len(is) > 0 {
					t.Errorf("concurrent parse rejected %v", is)
				}
			}
		}()
	}
	w.Wait()
}

func TestNumericIdentityAndLimits(t *testing.T) {
	m := object(t)
	m["parameters"] = map[string]any{"large": map[string]any{"type": "integer", "label": "Large", "required": false, "minimum": json.Number("1000000000000000000000000000000"), "maximum": json.Number("1e32"), "default": json.Number("1e31")}, "flag": map[string]any{"type": "boolean", "label": "Flag", "required": false, "default": false}, "zero": map[string]any{"type": "integer", "label": "Zero", "required": false, "default": 0, "minimum": 0}}
	raw := encode(t, m)
	raw = bytes.Replace(raw, []byte(`"releaseNumber":1`), []byte(`"releaseNumber":1e0`), 1)
	d, is := Parse(raw)
	if d == nil || len(is) > 0 {
		t.Fatalf("exact integers rejected: %v", is)
	}
	if string(d.Manifest.Parameters["flag"].Default) != "false" || string(d.Manifest.Parameters["zero"].Default) != "0" || d.Manifest.Parameters["zero"].Minimum == nil {
		t.Fatal("optional scalar presence lost")
	}
	sum := sha256.Sum256(raw)
	if d.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatal("exponent bytes identity changed")
	}
	for _, n := range []string{"1e999999999", "1e-999999999", strings.Repeat("9", MaxNumberBytes+1)} {
		m := object(t)
		m["parameters"] = map[string]any{"value": map[string]any{"type": "integer", "label": "Value", "required": false, "default": json.Number(n)}}
		is := reject(t, encode(t, m))
		if len(is) != 1 || is[0].Code != "JSON_LIMIT" {
			t.Fatalf("numeric bound wrong diagnostic %v", is)
		}
	}
}
func TestSemanticParameterConstraints(t *testing.T) {
	cases := map[string]map[string]any{
		"inverted-range":   {"type": "integer", "minimum": 10, "maximum": 9},
		"inverted-length":  {"type": "string", "minLength": 8, "maxLength": 7},
		"enum-default":     {"type": "enum", "choices": []any{"a", "b"}, "default": "c"},
		"short-default":    {"type": "string", "minLength": 2, "default": "a"},
		"long-default":     {"type": "string", "maxLength": 1, "default": "ab"},
		"pattern-default":  {"type": "string", "pattern": "^[a-z]+$", "default": "123"},
		"backref-pattern":  {"type": "string", "pattern": `(a)\1`},
		"boolean-length":   {"type": "boolean", "maxLength": 2},
		"string-range":     {"type": "string", "maximum": 2},
		"fraction-default": {"type": "integer", "default": 1.2},
		"integer-length":   {"type": "integer", "minLength": 0},
	}
	for n, p := range cases {
		t.Run(n, func(t *testing.T) {
			p["label"] = "Value"
			p["required"] = false
			m := object(t)
			m["parameters"] = map[string]any{"value": p}
			reject(t, encode(t, m))
		})
	}
	for _, p := range []map[string]any{{"type": "string", "default": "猫", "minLength": 1, "maxLength": 1, "pattern": "^猫$"}, {"type": "enum", "choices": []any{"a", "b"}, "default": "a"}, {"type": "integer", "default": json.Number("1e2"), "minimum": 100, "maximum": 100}, {"type": "boolean", "default": false}} {
		m := object(t)
		p["label"] = "Value"
		p["required"] = false
		m["parameters"] = map[string]any{"value": p}
		d, is := Parse(encode(t, m))
		if d == nil || len(is) > 0 {
			t.Fatalf("valid default rejected %v", is)
		}
	}
}
func TestSemanticEnvironmentReferences(t *testing.T) {
	for _, e := range []map[string]any{{"parameterRef": "password"}, {"secretRef": "name"}, {"parameterRef": "missing"}, {"secretRef": "missing"}, {"runtimeRef": "password"}, {"literal": "value", "secretRef": "password"}} {
		m := object(t)
		m["parameters"] = map[string]any{"password": map[string]any{"type": "secret", "label": "Password", "required": false}, "name": map[string]any{"type": "string", "label": "Name", "required": false}}
		m["requiredCapabilities"] = append(m["requiredCapabilities"].([]any), "parameters.secret")
		service(m)["environment"] = map[string]any{"VALUE": e}
		reject(t, encode(t, m))
	}
	m := object(t)
	service(m)["environment"] = map[string]any{"LITERAL": map[string]any{"literal": "${literal} {{not-executable}}"}, "UID": map[string]any{"runtimeRef": "uid"}}
	d, is := Parse(encode(t, m))
	if d == nil || len(is) > 0 {
		t.Fatalf("literal/runtimeRef rejected %v", is)
	}
	if *d.Manifest.Runtime.Services[0].Environment["LITERAL"].Literal != "${literal} {{not-executable}}" {
		t.Fatal("literal transformed")
	}
}
func TestPublishedPortConflicts(t *testing.T) {
	for _, bind := range []string{"lan", "loopback"} {
		t.Run(bind, func(t *testing.T) {
			m := object(t)
			a := port(m)
			b := map[string]any{}
			json.Unmarshal(encode(t, a), &b)
			b["id"] = "other"
			b["bind"] = bind
			service(m)["ports"] = []any{a, b}
			is := reject(t, encode(t, m))
			found := false
			for _, v := range is {
				found = found || v.Code == "port_default_conflict"
			}
			if !found {
				t.Fatalf("missing overlap issue %v", is)
			}
		})
	}
	m := object(t)
	a := port(m)
	b := map[string]any{}
	json.Unmarshal(encode(t, a), &b)
	b["id"] = "udp"
	b["protocol"] = "udp"
	service(m)["ports"] = []any{a, b}
	m["requiredCapabilities"] = append(m["requiredCapabilities"].([]any), "ports.udp")
	if d, is := Parse(encode(t, m)); d == nil || len(is) > 0 {
		t.Fatalf("tcp/udp share rejected %v", is)
	}
}
func TestCanonicalPathsAndRepositories(t *testing.T) {
	for _, s := range []string{"/x", "../x", "a/../x", "./x", "a/./x", "a//x", "a/", "a\\x", "a%2fx", "a?x", "a#x", "https://example.invalid/x"} {
		m := object(t)
		service(m)["image"].(map[string]any)["path"] = s
		reject(t, encode(t, m))
	}
	for _, s := range []string{"/", "/a/..", "/a/./b", "//data", "/data/", "/a\\b", "/a%2fb", "/data\n"} {
		m := object(t)
		service(m)["mounts"].([]any)[0].(map[string]any)["target"] = s
		reject(t, encode(t, m))
	}
	for _, s := range []string{"alpine", "acme/app", "docker.io/acme/app:tag", "docker.io/acme/app@sha256:abc", "docker.io//app", "docker.io/acme/../app", "docker.io./acme/app", "docker.io:080/acme/app"} {
		if _, ok := registryOf(s); ok {
			t.Errorf("unsafe repository accepted %q", s)
		}
	}
	for _, s := range []string{"docker.io/library/alpine", "ghcr.io/acme/tool", "registry.example:5000/acme/tool", "localhost:5000/tool"} {
		if _, ok := registryOf(s); !ok {
			t.Errorf("canonical repository rejected %q", s)
		}
	}
}
func TestInitializationAndHealthBounds(t *testing.T) {
	for _, f := range []func(map[string]any){func(m map[string]any) { m["initialization"].(map[string]any)["portId"] = "missing" }, func(m map[string]any) { service(m)["health"].(map[string]any)["portId"] = "missing" }, func(m map[string]any) { service(m)["health"] = map[string]any{"type": "unknown"} }, func(m map[string]any) { m["initialization"].(map[string]any)["path"] = "http://evil.invalid" }, func(m map[string]any) { m["initialization"].(map[string]any)["pointer"] = "/secret~" }} {
		m := object(t)
		f(m)
		reject(t, encode(t, m))
	}
	for _, s := range []string{"", "/a~0b/~1c", "/中文"} {
		m := object(t)
		m["initialization"].(map[string]any)["pointer"] = s
		if d, is := Parse(encode(t, m)); d == nil || len(is) > 0 {
			t.Fatalf("valid pointer rejected %v", is)
		}
	}
}
func TestCapabilityUses(t *testing.T) {
	for _, f := range []func(map[string]any){func(m map[string]any) { service(m)["command"] = []any{"app"} }, func(m map[string]any) { service(m)["entrypoint"] = []any{"app"} }, func(m map[string]any) {
		service(m)["health"] = map[string]any{"type": "exec", "command": []any{"check"}, "intervalSeconds": 10, "timeoutSeconds": 1, "retries": 2, "startPeriodSeconds": 0}
	}} {
		m := object(t)
		f(m)
		is := reject(t, encode(t, m))
		found := false
		for _, v := range is {
			found = found || v.Code == "CAPABILITY_MISSING"
		}
		if !found {
			t.Fatalf("wrong issue %v", is)
		}
	}
}
func TestExplicitConfigRoundTrip(t *testing.T) {
	states := []struct {
		name  string
		value []string
	}{{"omitted", nil}, {"empty", []string{}}, {"nonempty", []string{"app", "--serve"}}}
	for _, command := range states {
		for _, entrypoint := range states {
			t.Run(command.name+"-command/"+entrypoint.name+"-entrypoint", func(t *testing.T) {
				m := object(t)
				delete(service(m), "command")
				delete(service(m), "entrypoint")
				want := map[string][]string{"command": command.value, "entrypoint": entrypoint.value}
				for field, value := range want {
					if value != nil {
						service(m)[field] = value
					}
				}
				if command.value != nil || entrypoint.value != nil {
					m["requiredCapabilities"] = append(m["requiredCapabilities"].([]any), "command.override")
				}
				d, is := Parse(encode(t, m))
				if d == nil || len(is) != 0 {
					t.Fatalf("provided config rejected: %v", is)
				}
				check := func(s Service) {
					t.Helper()
					for field, got := range map[string][]string{"command": s.Command, "entrypoint": s.Entrypoint} {
						if !bytes.Equal(encode(t, got), encode(t, want[field])) {
							t.Errorf("%s declaration changed: got %s, want %s", field, encode(t, got), encode(t, want[field]))
						}
					}
				}
				check(d.Manifest.Runtime.Services[0])
				normalized := encode(t, d.Manifest)
				var serialized map[string]any
				if e := json.Unmarshal(normalized, &serialized); e != nil {
					t.Fatal(e)
				}
				for field, value := range want {
					got, present := service(serialized)[field]
					if present != (value != nil) || (present && !bytes.Equal(encode(t, got), encode(t, value))) {
						t.Errorf("%s JSON presence/value changed: present %v, got %s, want %s", field, present, encode(t, got), encode(t, value))
					}
				}
				roundTrip, is := Parse(normalized)
				if roundTrip == nil || len(is) != 0 {
					t.Fatalf("normalized config rejected: %v", is)
				}
				check(roundTrip.Manifest.Runtime.Services[0])
			})
		}
	}
}
func TestCommandOverrideProvidedFields(t *testing.T) {
	for _, field := range []string{"command", "entrypoint"} {
		for _, value := range []struct {
			name  string
			array []string
		}{{"empty", []string{}}, {"nonempty", []string{"app"}}} {
			t.Run(field+"/"+value.name, func(t *testing.T) {
				m := object(t)
				service(m)[field] = value.array
				t.Run("missing-capability", func(t *testing.T) {
					is := reject(t, encode(t, m))
					if len(is) != 1 || is[0].Code != "CAPABILITY_MISSING" || is[0].Path != "/requiredCapabilities" {
						t.Fatalf("wrong override diagnostic: %v", is)
					}
				})
				m["requiredCapabilities"] = append(m["requiredCapabilities"].([]any), "command.override")
				d, is := Parse(encode(t, m))
				if d == nil || len(is) != 0 {
					t.Fatalf("declared override rejected: %v", is)
				}
				p := Policy{Protocol: 1, Platforms: []string{"linux/amd64"}, Capabilities: SupportedCapabilities()}
				if is := CheckPolicy(d.Manifest, "source", p); len(is) != 0 {
					t.Fatalf("allowed override rejected: %v", is)
				}
				p.Capabilities = nil
				for _, capability := range SupportedCapabilities() {
					if capability != "command.override" {
						p.Capabilities = append(p.Capabilities, capability)
					}
				}
				is = CheckPolicy(d.Manifest, "source", p)
				if len(is) != 1 || is[0].Code != "POLICY_CAPABILITY" || is[0].Path != fmt.Sprintf("/requiredCapabilities/%d", len(d.Manifest.RequiredCapabilities)-1) {
					t.Fatalf("override policy bypassed: %v", is)
				}
			})
		}
	}
}
func TestExplicitConfigHealthCommandIsSeparate(t *testing.T) {
	m := object(t)
	m["requiredCapabilities"] = append(m["requiredCapabilities"].([]any), "health.exec")
	health := map[string]any{"type": "exec", "command": []string{"check"}, "intervalSeconds": 10, "timeoutSeconds": 1, "retries": 2, "startPeriodSeconds": 0}
	service(m)["health"] = health
	if d, is := Parse(encode(t, m)); d == nil || len(is) != 0 {
		t.Fatalf("health command requires service override: %v", is)
	}
	health["command"] = []string{}
	is := reject(t, encode(t, m))
	for _, v := range is {
		if v.Code != "SCHEMA_INVALID" {
			t.Fatalf("wrong empty health command diagnostic: %v", is)
		}
	}
}
func TestDependencyLayersDeterministic(t *testing.T) {
	services := []Service{{ID: "z", DependsOn: []string{"b"}}, {ID: "b"}, {ID: "c"}, {ID: "a", DependsOn: []string{"b", "c"}}}
	for i := 0; i < 100; i++ {
		order, cycle := startupOrder(services)
		if cycle || fmt.Sprint(order) != "[b c a z]" {
			t.Fatalf("order %v cycle %v", order, cycle)
		}
	}
	services[1].DependsOn = []string{"z"}
	if _, cycle := startupOrder(services); !cycle {
		t.Fatal("multi-service cycle accepted")
	}
}
func TestPublicSchemaCannotBeReplaced(t *testing.T) {
	if _, e := (embeddedOnlyLoader{}).Load("https://example.invalid/attacker-schema.json"); e == nil {
		t.Fatal("remote loader accepted")
	}
	if _, e := (embeddedOnlyLoader{}).Load("file:///tmp/attacker-schema.json"); e == nil {
		t.Fatal("filesystem loader accepted")
	}
	re, e := compileSchemaRegexp(`^(a+)+$`)
	if e != nil {
		t.Fatal(e)
	}
	if re.(schemaRegexp).re.MatchTimeout != 50*time.Millisecond {
		t.Fatal("timeout changed")
	}
	if re.MatchString(strings.Repeat("a", 20000) + "!") {
		t.Fatal("timed-out pattern accepted")
	}
}
func TestHugeExponentResourceBound(t *testing.T) {
	m := object(t)
	m["parameters"] = map[string]any{"value": map[string]any{"type": "integer", "label": "Value", "required": false, "default": json.Number("1e999999999")}}
	is := reject(t, encode(t, m))
	if len(is) != 1 || is[0].Code != "JSON_LIMIT" {
		t.Fatalf("unbounded exponent diagnostic %v", is)
	}
}
func TestSemanticHostEnvironmentKeys(t *testing.T) {
	for _, n := range []string{"equal", "literal", "parameter", "wrong-runtime"} {
		t.Run(n, func(t *testing.T) {
			m := object(t)
			s := service(m)
			s["userMode"] = "host-env"
			s["uidEnvironmentKey"] = "UID"
			s["gidEnvironmentKey"] = "GID"
			switch n {
			case "equal":
				s["gidEnvironmentKey"] = "UID"
			case "literal":
				s["environment"] = map[string]any{"UID": map[string]any{"literal": "0"}}
			case "parameter":
				m["parameters"] = map[string]any{"id": map[string]any{"type": "integer", "label": "ID", "required": false, "default": 0}}
				s["environment"] = map[string]any{"GID": map[string]any{"parameterRef": "id"}}
			case "wrong-runtime":
				s["environment"] = map[string]any{"UID": map[string]any{"runtimeRef": "gid"}}
			}
			reject(t, encode(t, m))
		})
	}
	for _, environment := range []map[string]any{{}, {"UID": map[string]any{"runtimeRef": "uid"}, "GID": map[string]any{"runtimeRef": "gid"}}} {
		m := object(t)
		s := service(m)
		s["userMode"] = "host-env"
		s["uidEnvironmentKey"] = "UID"
		s["gidEnvironmentKey"] = "GID"
		s["environment"] = environment
		d, is := Parse(encode(t, m))
		if d == nil || len(is) > 0 {
			t.Fatalf("valid host-env rejected %v", is)
		}
	}
}
func TestTotalPortAndIssueLimits(t *testing.T) {
	m := object(t)
	a := service(m)
	b := map[string]any{}
	json.Unmarshal(encode(t, a), &b)
	b["id"] = "db"
	a["health"] = map[string]any{"type": "none"}
	b["health"] = map[string]any{"type": "none"}
	for _, s := range []map[string]any{a, b} {
		ports := []any{}
		for i := 0; i < 33; i++ {
			ports = append(ports, map[string]any{"id": fmt.Sprintf("port-%d", i), "mode": "container", "protocol": "tcp", "containerPort": 8000 + i, "publish": false})
		}
		s["ports"] = ports
	}
	a["ports"].([]any)[0].(map[string]any)["publish"] = true
	a["ports"].([]any)[0].(map[string]any)["defaultHostPort"] = 28090
	a["ports"].([]any)[0].(map[string]any)["bind"] = "lan"
	runtime(m)["entry"].(map[string]any)["portId"] = "port-0"
	m["initialization"] = map[string]any{"mode": "not-required"}
	runtime(m)["services"] = []any{a, b}
	m["requiredCapabilities"] = append(m["requiredCapabilities"].([]any), "services.bundle")
	is := reject(t, encode(t, m))
	if len(is) != 1 || is[0].Code != "JSON_LIMIT" {
		t.Fatalf("total port budget not enforced %v", is)
	}
	m = object(t)
	services := []any{}
	for i := 0; i < 180; i++ {
		s := map[string]any{}
		json.Unmarshal(encode(t, service(m)), &s)
		s["stopTimeoutSeconds"] = 0
		services = append(services, s)
	}
	runtime(m)["services"] = services
	is = reject(t, encode(t, m))
	if len(is) != 128 {
		t.Fatalf("expected capped diagnostics, got %d", len(is))
	}
	for i := 1; i < len(is); i++ {
		if is[i-1].Path > is[i].Path {
			t.Fatal("capped issues not sorted")
		}
	}
}
func TestSchemaBoundaryAndEscapes(t *testing.T) {
	raw := validManifestBytes(t)
	padded := append(bytes.Repeat([]byte(" "), MaxDocumentBytes-len(raw)), raw...)
	if d, is := Parse(padded); d == nil || len(is) > 0 {
		t.Fatalf("byte boundary rejected %v", is)
	}
	reject(t, append(padded, ' '))
	for _, s := range []string{`"\ud800"`, `"\udc00"`, `"\ud800\u0041"`} {
		m := object(t)
		b := encode(t, m)
		b = bytes.Replace(b, []byte(`"unfamiliar-tool"`), []byte(s), 1)
		reject(t, b)
	}
	for _, s := range []string{`"\ud83d\ude00"`, `"a\\uD800"`, `"replacement�"`} {
		m := object(t)
		b := encode(t, m)
		b = bytes.Replace(b, []byte(`"unfamiliar-tool"`), []byte(`"unfamiliar-tool"`), 1)
		b = bytes.Replace(b, []byte(`"nasReader"`), []byte(s), 1)
		if d, is := Parse(b); d == nil || len(is) > 0 {
			t.Fatalf("valid Unicode rejected %v", is)
		}
	}
}
func TestShapeAndIdentityRefusals(t *testing.T) {
	for _, f := range []func(map[string]any){func(m map[string]any) {
		service(m)["image"].(map[string]any)["manifestDigest"] = "sha256:" + strings.Repeat("a", 64)
	}, func(m map[string]any) { service(m)["image"].(map[string]any)["configId"] = "" }, func(m map[string]any) { service(m)["image"].(map[string]any)["platform"] = "linux/arm64" }, func(m map[string]any) {
		runtime(m)["volumes"].([]any)[0].(map[string]any)["hostPath"] = "/synthetic-private/path"
	}, func(m map[string]any) { service(m)["mounts"].([]any)[0].(map[string]any)["volumeId"] = "missing" }, func(m map[string]any) {
		m["parameters"] = map[string]any{"value": map[string]any{"type": "string", "label": "Value", "required": false, "default": nil}}
	}, func(m map[string]any) { service(m)["health"].(map[string]any)["path"] = "/health?token=synthetic" }, func(m map[string]any) {
		m["requiredCapabilities"] = append(m["requiredCapabilities"].([]any), "unknown.capability")
	}, func(m map[string]any) { runtime(m)["network"] = "host" }} {
		m := object(t)
		f(m)
		reject(t, encode(t, m))
	}
}
func TestSocketTargetAndCacheBackup(t *testing.T) {
	for _, f := range []func(map[string]any){func(m map[string]any) {
		service(m)["mounts"].([]any)[2].(map[string]any)["target"] = "/tmp/docker.sock"
	}, func(m map[string]any) {
		runtime(m)["permissionProfile"] = "standard-v1"
		for _, p := range service(m)["ports"].([]any) {
			port := p.(map[string]any)
			port["mode"] = "container"
			port["containerPort"] = 8080
		}
		m["requiredCapabilities"] = append(m["requiredCapabilities"].([]any), "profile.standard-v1")
	}} {
		var m map[string]any
		json.Unmarshal(example(t, "datatotal"), &m)
		f(m)
		is := reject(t, encode(t, m))
		found := false
		for _, v := range is {
			found = found || v.Code == "MOUNT_INVALID"
		}
		if !found {
			t.Fatalf("wrong socket issue %v", is)
		}
	}
	m := object(t)
	runtime(m)["volumes"].([]any)[0].(map[string]any)["role"] = "cache"
	m["backup"].(map[string]any)["volumes"] = []any{"inbox"}
	if d, is := Parse(encode(t, m)); d == nil || len(is) > 0 {
		t.Fatalf("cache may be omitted %v", is)
	}
}
func TestPublishedRepositoryCanonicalNames(t *testing.T) {
	for _, s := range []string{"docker.io/alpine", "index.docker.io/library/alpine", "registry-1.docker.io/library/alpine"} {
		t.Run(s, func(t *testing.T) {
			if _, ok := registryOf(s); ok {
				t.Fatal("noncanonical registry repository accepted")
			}
		})
	}
	for _, s := range []string{"registry:5000/tool", "localhost/tool", "localhost:5000/tool", "docker.io/library/alpine"} {
		t.Run(s, func(t *testing.T) {
			if _, ok := registryOf(s); !ok {
				t.Fatal("explicit canonical registry repository rejected")
			}
		})
	}
}
func TestNumericResourceBoundaries(t *testing.T) {
	for _, n := range []string{strings.Repeat("9", MaxNumberBytes), "1e4096", "1e-4096"} {
		m := object(t)
		p := map[string]any{"type": "integer", "label": "Value", "required": false}
		if n == "1e-4096" {
			p["minimum"] = json.Number("0e-4096")
		} else {
			p["default"] = json.Number(n)
		}
		m["parameters"] = map[string]any{"value": p}
		if d, is := Parse(encode(t, m)); d == nil || len(is) > 0 {
			t.Fatalf("numeric resource boundary rejected %v", is)
		}
	}
}
func TestSupportedCapabilitiesMatchSchema(t *testing.T) {
	var schema map[string]any
	if e := json.Unmarshal(schemaBytes, &schema); e != nil {
		t.Fatal(e)
	}
	values := schema["$defs"].(map[string]any)["capability"].(map[string]any)["enum"].([]any)
	supported := SupportedCapabilities()
	if len(values) != len(supported) {
		t.Fatal("capability set drift")
	}
	for _, v := range values {
		if !has(supported, v.(string)) {
			t.Fatal("capability missing")
		}
	}
}
func TestDTOOptionalZerosSurviveRoundTrip(t *testing.T) {
	m := object(t)
	service(m)["sharedMemoryBytes"] = 0
	service(m)["health"].(map[string]any)["startPeriodSeconds"] = 0
	m["initialization"].(map[string]any)["requiredValue"] = false
	d, is := Parse(encode(t, m))
	if d == nil || len(is) > 0 {
		t.Fatal(is)
	}
	if d.Manifest.Runtime.Services[0].SharedMemoryBytes == nil || *d.Manifest.Runtime.Services[0].SharedMemoryBytes != 0 || d.Manifest.Initialization.RequiredValue == nil || *d.Manifest.Initialization.RequiredValue {
		t.Fatal("zero/false lost")
	}
	round, is := Parse(encode(t, d.Manifest))
	if round == nil || len(is) > 0 {
		t.Fatalf("DTO round trip rejected %v", is)
	}
}
