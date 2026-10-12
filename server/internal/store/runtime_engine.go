package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"
)

//go:embed runtime_host.py
var runtimeHostBody string

//go:embed runtime_owner_image.py
var runtimeOwnerImageScript string

var runtimeHostScript = runtimeOwnerImageScript + "\n" + runtimeHostBody

//go:embed runtime_registry_host.py
var runtimeRegistryHostScript string
var runtimeDigestRE = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var runtimeFailure = errors.New("runtime_guard_failed: ownership, storage, image or runtime verification failed; all resources retained")

func (e *commandEngine) runtimeHost(ctx context.Context, action string, payload any, result any) error {
	if e.mode != "local" && e.mode != "sshbind" {
		return runtimeFailure
	}
	var secretValues map[string]string
	if request, ok := payload.(map[string]any); ok {
		if generation, ok := request["generation"].(RuntimeGeneration); ok && runtimeRecipeHasSecrets(generation.Recipe) {
			if e.mode != "local" || e.secrets == nil {
				return runtimeFailure
			}
			path, cleanup, values, err := e.secrets.configFile(ctx, generation)
			if err != nil {
				return runtimeFailure
			}
			defer cleanup()
			request["secretFile"] = path
			secretValues = values
		}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return runtimeFailure
	}
	args := []string{"python3", "-c", runtimeHostScript, action, string(body), remoteProbeScript, remoteProvenanceScript, storageScript}
	var out string
	if e.mode == "sshbind" {
		out, err = e.runtimeRemote(ctx, runtimeActionTimeout(action), args...)
	} else {
		out, _, err = e.runner(ctx, args[0], args[1:]...)
	}
	if err != nil {
		if result != nil && len(out) <= 2<<20 {
			var retained struct {
				Generation json.RawMessage `json:"generation"`
			}
			if json.Unmarshal([]byte(out), &retained) == nil && len(retained.Generation) > 0 {
				_ = json.Unmarshal(retained.Generation, result)
			}
		}
		return runtimeFailure
	}
	if len(secretValues) > 0 && action == "logs" {
		var logs struct {
			Logs string `json:"logs"`
		}
		if json.Unmarshal([]byte(out), &logs) != nil {
			return runtimeFailure
		}
		logs.Logs = string(runtimeSecretRedact([]byte(logs.Logs), secretValues))
		redacted, err := json.Marshal(logs)
		if err != nil {
			return runtimeFailure
		}
		out = string(redacted)
	}
	if len(out) > 2<<20 {
		return runtimeFailure
	}
	if result != nil && json.Unmarshal([]byte(out), result) != nil {
		return runtimeFailure
	}
	return nil
}
func runtimeActionTimeout(action string) time.Duration {
	switch action {
	case "launch", "snapshot", "restore":
		return 30 * time.Minute
	case "control", "quiesce":
		return 20 * time.Minute
	case "resolve":
		return 5 * time.Minute
	case "logs", "directories", "initialization", "facts":
		return 30 * time.Second
	default:
		return 2 * time.Minute
	}
}

// Only this runtime transport adjusts sshbind's bounded timeout. Legacy commands
// remain untouched. Every option is before the registered alias.
func (e *commandEngine) runtimeRemote(ctx context.Context, timeout time.Duration, args ...string) (string, error) {
	if e.mode != "sshbind" || !segmentRE.MatchString(e.alias) || timeout <= 0 || timeout > 30*time.Minute {
		return "", runtimeFailure
	}
	bounded, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	deadline, _ := bounded.Deadline()
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return "", runtimeFailure
	}
	seconds := int((remaining + time.Second - 1) / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	parts := make([]string, len(args))
	for i, a := range args {
		parts[i] = shellQuote(a)
	}
	out, _, err := e.runner(bounded, "sshbind", "exec", "--json", "--timeout", strconv.Itoa(seconds), e.alias, strings.Join(parts, " "))
	if len(out) > 2<<20 {
		return "", runtimeFailure
	}
	var result struct {
		ExitCode *int   `json:"exit_code"`
		Stdout   string `json:"stdout"`
	}
	if json.Unmarshal([]byte(out), &result) != nil {
		return "", runtimeFailure
	}
	if err != nil || bounded.Err() != nil || result.ExitCode == nil || *result.ExitCode != 0 {
		return result.Stdout, runtimeFailure
	}
	return result.Stdout, nil
}

func validateRuntimeRecipe(r RuntimeRecipe) error {
	if runtimeCloudRecipeApproved(r) {
		return nil
	}
	approved, ok := RuntimeRecipeFor(r.AppID, r.Version)
	if !ok || !reflect.DeepEqual(approved, r) {
		return runtimeFailure
	}
	return nil
}
func validateRuntimeImages(r RuntimeRecipe, images []RuntimeImage) error {
	if r.AppID == "nasreader" {
		if validateRuntimeRecipe(r) != nil || !reflect.DeepEqual(images, []RuntimeImage{nasReaderImage()}) {
			return runtimeFailure
		}
		return nil
	}
	if len(images) != len(r.Services) {
		return runtimeFailure
	}
	seen := map[string]bool{}
	for _, s := range r.Services {
		found := false
		for _, im := range images {
			if im.ServiceID == s.ID {
				if im.ConfigID != "" || im.ArchiveSHA256 != "" || im.ArchiveSizeBytes != 0 || len(im.DiffIDs) != 0 || seen[s.ID] || im.TagReference != s.Image || im.Platform != "linux/amd64" || !runtimeDigestRE.MatchString(im.Digest) || im.Publisher == "" || im.DeliverySource == "" {
					return runtimeFailure
				}
				repo := strings.Split(s.Image, "@")[0]
				if i := strings.LastIndex(repo, ":"); i > strings.LastIndex(repo, "/") {
					repo = repo[:i]
				}
				registry := strings.Split(repo, "/")[0]
				if registry == "docker.io" {
					registry = "registry-1.docker.io"
				}
				if im.Reference != repo+"@"+im.Digest || im.Publisher != repo || im.DeliverySource != registry {
					return runtimeFailure
				}
				seen[s.ID] = true
				found = true
			}
		}
		if !found {
			return runtimeFailure
		}
	}
	return nil
}
func validateRuntimePlan(p RuntimePlan) error {
	if runtimeRecipeHasSecrets(p.Recipe) && !cloudTokenRE.MatchString(p.SecretSetID) || !runtimeRecipeHasSecrets(p.Recipe) && p.SecretSetID != "" {
		return runtimeFailure
	}
	if validateRuntimeRecipe(p.Recipe) != nil || p.AppID != p.Recipe.AppID || p.TargetVersion != p.Recipe.Version || !segmentRE.MatchString(p.StoreID) || !segmentRE.MatchString(p.GenerationID) || !segmentRE.MatchString(p.ID) || !segmentRE.MatchString(p.InstanceID) || p.RootPath == "/" || !filepath.IsAbs(p.RootPath) || filepath.Clean(p.RootPath) != p.RootPath || filepath.Dir(p.DataPath) != p.RootPath || filepath.Clean(p.DataPath) != p.DataPath || strings.ContainsAny(p.DataPath, ",\x00\r\n") || p.StorageIdentity == "" || p.DockerStorageIdentity == "" || p.HostPort < 1024 || p.HostPort > 65535 || p.HostPort == 5055 {
		return runtimeFailure
	}
	if p.AppID == "syncthing" {
		if p.PeerPort < 1024 || p.PeerPort > 65535 || p.DiscoveryPort < 1024 || p.DiscoveryPort > 65535 || p.PeerPort == p.HostPort || p.DiscoveryPort == p.HostPort || p.DiscoveryPort == p.PeerPort || p.PeerPort == 5055 || p.DiscoveryPort == 5055 {
			return runtimeFailure
		}
	} else if p.PeerPort != 0 || p.DiscoveryPort != 0 {
		return runtimeFailure
	}
	if p.MediaPath != "" {
		if !filepath.IsAbs(p.MediaRootPath) || filepath.Clean(p.MediaRootPath) != p.MediaRootPath || !filepath.IsAbs(p.MediaPath) || filepath.Clean(p.MediaPath) != p.MediaPath || (p.MediaPath != p.MediaRootPath && !strings.HasPrefix(p.MediaPath, p.MediaRootPath+"/")) || strings.ContainsAny(p.MediaPath, ",\x00\r\n") || p.MediaStorageIdentity == "" {
			return runtimeFailure
		}
	} else if p.Recipe.RequiresMedia {
		return runtimeFailure
	}
	return validateRuntimeImages(p.Recipe, p.Images)
}
func validateRuntimeGeneration(g RuntimeGeneration) error {
	p := RuntimePlan{SecretSetID: g.SecretSetID, ID: g.ID, StoreID: g.StoreID, GenerationID: g.ID, InstanceID: g.InstanceID, AppID: g.AppID, TargetVersion: g.Version, RootPath: g.RootPath, DataPath: g.DataPath, StorageIdentity: g.StorageIdentity, DockerStorageIdentity: g.DockerStorageIdentity, HostPort: g.HostPort, PeerPort: g.PeerPort, DiscoveryPort: g.DiscoveryPort, Recipe: g.Recipe, Images: g.Images, MediaPath: g.MediaPath, MediaRootPath: g.MediaRootPath, MediaStorageIdentity: g.MediaStorageIdentity}
	if validateRuntimePlan(p) != nil || net.ParseIP(g.PublishHost) == nil {
		return runtimeFailure
	}
	if validateRuntimeRecipe(g.Recipe) != nil || validateRuntimeImages(g.Recipe, g.Images) != nil || !segmentRE.MatchString(g.StoreID) || g.StorageIdentity == "" || g.DockerStorageIdentity == "" || !segmentRE.MatchString(g.ID) || !segmentRE.MatchString(g.InstanceID) || g.AppID != g.Recipe.AppID || g.Version != g.Recipe.Version || g.RecipeRevision != g.Recipe.Revision || filepath.Dir(g.DataPath) != g.RootPath || g.Provenance.Marker != g.StoreID+":"+g.InstanceID+":"+g.ID || g.Provenance.DirectoryIdentity == "" || g.Provenance.RootIdentity == "" {
		return runtimeFailure
	}
	return nil
}
func (e *commandEngine) RuntimeFacts(ctx context.Context) (RuntimeFacts, error) {
	var f RuntimeFacts
	err := e.runtimeHost(ctx, "facts", map[string]any{}, &f)
	return f, err
}
func (e *commandEngine) ResolveRuntimeImages(ctx context.Context, r RuntimeRecipe, platform string) ([]RuntimeImage, error) {
	if (e.mode != "local" && e.mode != "sshbind") || validateRuntimeRecipe(r) != nil || platform != "linux/amd64" {
		return nil, runtimeFailure
	}
	if strings.HasPrefix(r.AppID, "cloud-") {
		if e.mode != "local" {
			return nil, runtimeCloudFailure
		}
		return resolveRuntimeCloudImages(ctx, r, platform)
	}
	if r.AppID == "nasreader" {
		var images []RuntimeImage
		if err := e.runtimeHost(ctx, "resolve-owner", map[string]any{"recipe": r, "images": []RuntimeImage{nasReaderImage()}}, &images); err != nil || validateRuntimeImages(r, images) != nil {
			return nil, runtimeOwnerUnavailable
		}
		return images, nil
	}
	if e.mode == "sshbind" {
		refs := make([]string, len(r.Services))
		for i, s := range r.Services {
			refs[i] = s.Image
		}
		payload, err := json.Marshal(refs)
		if err != nil {
			return nil, runtimeRegistryError
		}
		out, err := e.runtimeRemote(ctx, runtimeActionTimeout("resolve"), "python3", "-c", runtimeRegistryHostScript, string(payload))
		if err != nil || len(out) > 1536<<10 {
			return nil, runtimeRegistryError
		}
		var corpus runtimeRegistryCorpus
		if json.Unmarshal([]byte(out), &corpus) != nil {
			return nil, runtimeRegistryError
		}
		return replayRuntimeRegistryCorpus(ctx, r, platform, corpus)
	}
	return ResolveOfficialRuntimeImages(ctx, r, platform)
}
func (e *commandEngine) PrepareGeneration(ctx context.Context, p RuntimePlan) (RuntimeGeneration, error) {
	if validateRuntimePlan(p) != nil {
		return RuntimeGeneration{}, runtimeFailure
	}
	bind, err := publishHost(p.PublishHost, e.mode)
	if err != nil {
		return RuntimeGeneration{}, runtimeFailure
	}
	p.PublishHost = bind
	g := RuntimeGeneration{SecretSetID: p.SecretSetID, ID: p.GenerationID, StoreID: p.StoreID, StorageIdentity: p.StorageIdentity, DockerStorageIdentity: p.DockerStorageIdentity, InstanceID: p.InstanceID, AppID: p.AppID, Version: p.TargetVersion, RecipeRevision: p.Recipe.Revision, RootPath: p.RootPath, DataPath: p.DataPath, HostPort: p.HostPort, PeerPort: p.PeerPort, DiscoveryPort: p.DiscoveryPort, Images: p.Images, Recipe: p.Recipe, MediaPath: p.MediaPath, MediaRootPath: p.MediaRootPath, MediaStorageIdentity: p.MediaStorageIdentity, PublishHost: bind, AccessURL: p.AccessURL, State: "prepared"}
	err = e.runtimeHost(ctx, "prepare", map[string]any{"plan": p, "generation": g}, &g)
	return g, err
}
func (e *commandEngine) LaunchGeneration(ctx context.Context, p RuntimePlan, g RuntimeGeneration) (RuntimeGeneration, error) {
	if validateRuntimePlan(p) != nil || validateRuntimeGeneration(g) != nil || p.SecretSetID != g.SecretSetID || p.GenerationID != g.ID || p.StoreID != g.StoreID || p.StorageIdentity != g.StorageIdentity || p.DockerStorageIdentity != g.DockerStorageIdentity || p.InstanceID != g.InstanceID || p.DataPath != g.DataPath || p.RootPath != g.RootPath || !reflect.DeepEqual(p.Recipe, g.Recipe) || !reflect.DeepEqual(p.Images, g.Images) || p.HostPort != g.HostPort || p.PeerPort != g.PeerPort || p.DiscoveryPort != g.DiscoveryPort || p.MediaPath != g.MediaPath || p.MediaRootPath != g.MediaRootPath || p.MediaStorageIdentity != g.MediaStorageIdentity {
		return g, runtimeFailure
	}
	bind, err := publishHost(p.PublishHost, e.mode)
	if err != nil || bind != g.PublishHost {
		return g, runtimeFailure
	}
	payload := map[string]any{"plan": p, "generation": g}
	if p.Kind == "install" && p.RetryOfJobID != "" {
		proof, ok := ctx.Value(runtimeRetryLaunchKey{}).(runtimeRetryBinding)
		if !ok || proof.Job.ID != p.RetryOfJobID || proof.Plan.ID != p.RetryOfPlanID || proof.Plan.Kind != "install" || validateRuntimePlan(proof.Plan) != nil {
			return g, runtimeFailure
		}
		ancestors := proof.members()
		if len(ancestors) > runtimeMaxRetryAncestors {
			return g, runtimeFailure
		}
		sources := make([]map[string]any, 0, len(ancestors))
		seen := map[string]bool{p.ID: true}
		child := p
		for _, ancestor := range ancestors {
			old := ancestor.Plan
			if seen[old.ID] || child.RetryOfJobID != ancestor.Job.ID || child.RetryOfPlanID != old.ID || old.Kind != "install" || old.StoreID != p.StoreID || old.AppID != p.AppID || ancestor.Job.Status != "failed" || ancestor.Job.PlanID != old.ID || ancestor.Job.InstanceID != old.InstanceID || validateRuntimePlan(old) != nil {
				return g, runtimeFailure
			}
			if ancestor.Generation != nil && (validateRuntimeGeneration(*ancestor.Generation) != nil || !runtimeGenerationMatchesPlan(*ancestor.Generation, old) || (ancestor.Generation.State != "stopped" && ancestor.Generation.State != "prepared")) {
				return g, runtimeFailure
			}
			sources = append(sources, map[string]any{"plan": old, "generation": ancestor.Generation})
			seen[old.ID] = true
			child = old
		}
		if child.RetryOfJobID != "" || child.RetryOfPlanID != "" {
			return g, runtimeFailure
		}
		payload["retry"] = sources
	}
	err = e.runtimeHost(ctx, "launch", payload, &g)
	if err != nil {
		g.State = "needs_attention"
	}
	return g, err
}
func (e *commandEngine) InspectGeneration(ctx context.Context, g RuntimeGeneration) (RuntimeGeneration, error) {
	if validateRuntimeGeneration(g) != nil {
		return g, runtimeFailure
	}
	err := e.runtimeHost(ctx, "inspect", map[string]any{"generation": g}, &g)
	return g, err
}
func (e *commandEngine) ControlGeneration(ctx context.Context, g RuntimeGeneration, action string) error {
	if validateRuntimeGeneration(g) != nil || (action != "start" && action != "stop" && action != "restart") {
		return runtimeFailure
	}
	return e.runtimeHost(ctx, "control", map[string]any{"generation": g, "action": action}, nil)
}
func (e *commandEngine) SnapshotGeneration(ctx context.Context, g RuntimeGeneration, root, id string) (RuntimeSnapshot, error) {
	var s RuntimeSnapshot
	if validateRuntimeGeneration(g) != nil || !segmentRE.MatchString(id) || root == "/" || !filepath.IsAbs(root) || filepath.Clean(root) != root {
		return s, runtimeFailure
	}
	err := e.runtimeHost(ctx, "snapshot", map[string]any{"generation": g, "root": root, "id": id}, &s)
	return s, err
}

// VerifyFailedInstall reads marker/layout, creation intents and receipts,
// exact Docker identities, and live stopped states without changing resources.
func (e *commandEngine) VerifyFailedInstall(ctx context.Context, p RuntimePlan, g *RuntimeGeneration) error {
	if p.Kind != "install" || validateRuntimePlan(p) != nil {
		return runtimeFailure
	}
	if g != nil && (validateRuntimeGeneration(*g) != nil || !runtimeGenerationMatchesPlan(*g, p)) {
		return runtimeFailure
	}
	return e.runtimeHost(ctx, "verify-failed-install", map[string]any{"plan": p, "generation": g}, nil)
}
func (e *commandEngine) VerifyRuntimeSnapshot(ctx context.Context, s RuntimeSnapshot) error {
	if validateRuntimeGeneration(s.Source) != nil || !segmentRE.MatchString(s.ID) || s.RootPath == "/" || !filepath.IsAbs(s.RootPath) || filepath.Clean(s.RootPath) != s.RootPath || s.Path != filepath.Join(s.RootPath, s.ID, "data.tar") || s.GenerationID != s.Source.ID || s.InstanceID != s.Source.InstanceID || s.AppID != s.Source.AppID || s.Version != s.Source.Version || s.RecipeRevision != s.Source.RecipeRevision || !runtimeDigestRE.MatchString("sha256:"+s.SHA256) || s.SizeBytes <= 0 {
		return runtimeFailure
	}
	return e.runtimeHost(ctx, "verify-snapshot", map[string]any{"snapshot": s}, nil)
}

func (e *commandEngine) RestoreGeneration(ctx context.Context, s RuntimeSnapshot, p RuntimePlan) (RuntimeGeneration, error) {
	if validateRuntimePlan(p) != nil || validateRuntimeGeneration(s.Source) != nil || !segmentRE.MatchString(s.ID) || s.RootPath == "/" || !filepath.IsAbs(s.RootPath) || filepath.Clean(s.RootPath) != s.RootPath || s.Source.StoreID != p.StoreID || s.InstanceID != p.InstanceID || s.ID != p.SourceSnapshotID || s.GenerationID != s.Source.ID || s.InstanceID != s.Source.InstanceID || s.AppID != s.Source.AppID || s.Version != s.Source.Version || s.RecipeRevision != s.Source.RecipeRevision || s.AppID != p.AppID || !runtimeDigestRE.MatchString("sha256:"+s.SHA256) || s.SizeBytes <= 0 {
		return RuntimeGeneration{}, runtimeFailure
	}
	g, err := e.PrepareGeneration(ctx, p)
	if err != nil {
		return g, err
	}
	err = e.runtimeHost(ctx, "restore", map[string]any{"snapshot": s, "generation": g}, &g)
	if err != nil {
		g.State = "needs_attention"
	}
	return g, err
}
func (e *commandEngine) RuntimeLogs(ctx context.Context, g RuntimeGeneration, service string, lines int) (string, error) {
	if validateRuntimeGeneration(g) != nil || lines < 1 || lines > 1000 {
		return "", runtimeFailure
	}
	found := false
	for _, s := range g.Recipe.Services {
		if s.ID == service {
			found = true
		}
	}
	if !found {
		return "", runtimeFailure
	}
	var r struct {
		Logs string `json:"logs"`
	}
	err := e.runtimeHost(ctx, "logs", map[string]any{"generation": g, "service": service, "lines": lines}, &r)
	return r.Logs, err
}
func (e *commandEngine) RuntimeDirectories(ctx context.Context, root, path string) ([]string, error) {
	if root == "/" || !filepath.IsAbs(root) || filepath.Clean(root) != root || !filepath.IsAbs(path) || filepath.Clean(path) != path || (path != root && !strings.HasPrefix(path, root+"/")) {
		return nil, runtimeFailure
	}
	var dirs []string
	err := e.runtimeHost(ctx, "directories", map[string]string{"root": root, "path": path}, &dirs)
	return dirs, err
}

var _ RuntimeEngine = (*commandEngine)(nil)

// NAS proof documents contain only official OCI bytes. Anonymous authorization
// responses and CDN signed URLs stay inside the host helper process.
type runtimeRegistryDocument struct {
	Host string `json:"host"`
	Path string `json:"path"`
	Body string `json:"body"`
}
type runtimeRegistryCorpus struct {
	Documents []runtimeRegistryDocument `json:"documents"`
}
type runtimeProofTransport struct {
	documents map[string][]byte
	used      map[string]bool
}

func (t *runtimeProofTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Method != "GET" || req.URL.Scheme != "https" || req.URL.Host != "ghcr.io" || req.URL.User != nil || req.URL.RawQuery != "" || req.URL.Fragment != "" || req.Header.Get("Authorization") != "" {
		return nil, runtimeRegistryError
	}
	body, ok := t.documents[req.URL.Path]
	if !ok {
		return nil, runtimeRegistryError
	}
	t.used[req.URL.Path] = true
	headers := http.Header{"Docker-Content-Digest": {fmt.Sprintf("sha256:%x", sha256.Sum256(body))}}
	return &http.Response{StatusCode: 200, Header: headers, Body: io.NopCloser(bytes.NewReader(body)), ContentLength: int64(len(body)), Request: req}, nil
}
func replayRuntimeRegistryCorpus(ctx context.Context, r RuntimeRecipe, platform string, corpus runtimeRegistryCorpus) ([]RuntimeImage, error) {
	if validateRuntimeRecipe(r) != nil || platform != "linux/amd64" || len(corpus.Documents) == 0 || len(corpus.Documents) > 12 {
		return nil, runtimeRegistryError
	}
	prefixes := map[string]string{}
	for _, s := range r.Services {
		parts := strings.SplitN(s.Image, "/", 2)
		if len(parts) != 2 || parts[0] != "ghcr.io" {
			return nil, runtimeRegistryError
		}
		plain := strings.Split(parts[1], "@")[0]
		at := strings.LastIndex(plain, ":")
		if at < 1 {
			return nil, runtimeRegistryError
		}
		prefixes["/v2/"+plain[:at]+"/"] = plain[at+1:]
	}
	transport := &runtimeProofTransport{documents: map[string][]byte{}, used: map[string]bool{}}
	total := 0
	for _, doc := range corpus.Documents {
		if doc.Host != "ghcr.io" || len(doc.Body) > 1048576 || strings.ContainsAny(doc.Path, "?\\\r\n\x00") || filepath.Clean(doc.Path) != doc.Path {
			return nil, runtimeRegistryError
		}
		allowed := false
		for prefix, tag := range prefixes {
			if strings.HasPrefix(doc.Path, prefix) {
				tail := strings.TrimPrefix(doc.Path, prefix)
				parts := strings.Split(tail, "/")
				if len(parts) == 2 && ((parts[0] == "manifests" && (parts[1] == tag || runtimeDigestRE.MatchString(parts[1]))) || (parts[0] == "blobs" && runtimeDigestRE.MatchString(parts[1]))) {
					allowed = true
				}
			}
		}
		if !allowed {
			return nil, runtimeRegistryError
		}
		if _, exists := transport.documents[doc.Path]; exists {
			return nil, runtimeRegistryError
		}
		body, err := base64.StdEncoding.Strict().DecodeString(doc.Body)
		if err != nil {
			return nil, runtimeRegistryError
		}
		total += len(body)
		if total > 768<<10 {
			return nil, runtimeRegistryError
		}
		transport.documents[doc.Path] = body
	}
	images, err := (RuntimeRegistryResolver{Client: &http.Client{Transport: transport}}).Resolve(ctx, r, platform)
	if err != nil || len(transport.used) != len(transport.documents) {
		return nil, runtimeRegistryError
	}
	return images, nil
}

// Optional controller reconciliation capability, deliberately conservative.
func (e *commandEngine) RuntimeInitialization(ctx context.Context, g RuntimeGeneration) (string, error) {
	if validateRuntimeGeneration(g) != nil {
		return "unknown", runtimeFailure
	}
	var result struct {
		Initialization string `json:"initialization"`
	}
	if err := e.runtimeHost(ctx, "initialization", map[string]any{"generation": g}, &result); err != nil {
		return "unknown", err
	}
	if result.Initialization != "pending" && result.Initialization != "complete" && result.Initialization != "unknown" {
		return "unknown", runtimeFailure
	}
	return result.Initialization, nil
}

// Optional recovery capability: fully guarded partial resources may be stopped,
// while uncertain creation gaps are retained for attention without adoption.
func (e *commandEngine) RuntimeQuiesceGeneration(ctx context.Context, g RuntimeGeneration) (RuntimeGeneration, error) {
	if validateRuntimeGeneration(g) != nil {
		return g, runtimeFailure
	}
	err := e.runtimeHost(ctx, "quiesce", map[string]any{"generation": g}, &g)
	if err != nil {
		g.State = "needs_attention"
	}
	return g, err
}
