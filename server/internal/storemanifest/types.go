// Package storemanifest validates untrusted published application manifests.
// It performs no network, filesystem, Docker or runtime operations.
package storemanifest

import "encoding/json"

type Issue struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Message string `json:"message"`
}
type Document struct {
	Manifest     Manifest
	Raw          []byte
	SHA256       string
	StartupOrder []string
}
type Manifest struct {
	SchemaVersion        string               `json:"schemaVersion"`
	MinStoreProtocol     int                  `json:"minStoreProtocol"`
	RequiredCapabilities []string             `json:"requiredCapabilities"`
	AppID                string               `json:"appId"`
	ReleaseID            string               `json:"releaseId"`
	ReleaseNumber        int64                `json:"releaseNumber"`
	Metadata             Metadata             `json:"metadata"`
	Runtime              Runtime              `json:"runtime"`
	Parameters           map[string]Parameter `json:"parameters"`
	Upgrade              Upgrade              `json:"upgrade"`
	Backup               Backup               `json:"backup"`
	Initialization       Initialization       `json:"initialization"`
	NativeLicense        NativeLicense        `json:"nativeLicense"`
}
type Metadata struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Description string `json:"description"`
	Category    string `json:"category"`
	Author      string `json:"author"`
	SourceURL   string `json:"sourceUrl"`
	License     string `json:"license"`
	Icon        Icon   `json:"icon"`
}
type Icon struct {
	Kind       string  `json:"kind"`
	Text       *string `json:"text,omitempty"`
	Background *string `json:"background,omitempty"`
	Path       *string `json:"path,omitempty"`
	SHA256     *string `json:"sha256,omitempty"`
	SizeBytes  *int64  `json:"sizeBytes,omitempty"`
	MediaType  *string `json:"mediaType,omitempty"`
}
type Runtime struct {
	Platforms          []string  `json:"platforms"`
	PermissionProfile  string    `json:"permissionProfile"`
	Services           []Service `json:"services"`
	Volumes            []Volume  `json:"volumes"`
	Entry              Entry     `json:"entry"`
	MinimumMemoryBytes int64     `json:"minimumMemoryBytes"`
}
type Entry struct {
	ServiceID string `json:"serviceId"`
	PortID    string `json:"portId"`
	Path      string `json:"path"`
}
type Image struct {
	Type           string   `json:"type"`
	Repository     *string  `json:"repository,omitempty"`
	Tag            *string  `json:"tag,omitempty"`
	ManifestDigest *string  `json:"manifestDigest,omitempty"`
	ConfigID       *string  `json:"configId,omitempty"`
	Platform       string   `json:"platform"`
	Path           *string  `json:"path,omitempty"`
	ArchiveSHA256  *string  `json:"archiveSha256,omitempty"`
	SizeBytes      *int64   `json:"sizeBytes,omitempty"`
	DiffIDs        []string `json:"diffIds,omitempty"`
}
type EnvironmentValue struct {
	Literal      *string `json:"literal,omitempty"`
	ParameterRef *string `json:"parameterRef,omitempty"`
	SecretRef    *string `json:"secretRef,omitempty"`
	PortRef      *string `json:"portRef,omitempty"`
	ServiceRef   *string `json:"serviceRef,omitempty"`
	RuntimeRef   *string `json:"runtimeRef,omitempty"`
}
type Port struct {
	ID              string  `json:"id"`
	Mode            string  `json:"mode"`
	Protocol        string  `json:"protocol"`
	ContainerPort   *int    `json:"containerPort,omitempty"`
	Publish         bool    `json:"publish"`
	DefaultHostPort *int    `json:"defaultHostPort,omitempty"`
	Bind            *string `json:"bind,omitempty"`
}
type Health struct {
	Type               string   `json:"type"`
	PortID             *string  `json:"portId,omitempty"`
	Path               *string  `json:"path,omitempty"`
	ExpectedStatuses   []int    `json:"expectedStatuses,omitempty"`
	Command            []string `json:"command,omitempty"`
	IntervalSeconds    *int     `json:"intervalSeconds,omitempty"`
	TimeoutSeconds     *int     `json:"timeoutSeconds,omitempty"`
	Retries            *int     `json:"retries,omitempty"`
	StartPeriodSeconds *int     `json:"startPeriodSeconds,omitempty"`
}
type Mount struct {
	VolumeID string `json:"volumeId"`
	Target   string `json:"target"`
	ReadOnly bool   `json:"readOnly"`
}
type Service struct {
	ID                 string                      `json:"id"`
	Image              Image                       `json:"image"`
	UserMode           string                      `json:"userMode"`
	UIDEnvironmentKey  *string                     `json:"uidEnvironmentKey,omitempty"`
	GIDEnvironmentKey  *string                     `json:"gidEnvironmentKey,omitempty"`
	Environment        map[string]EnvironmentValue `json:"environment"`
	Ports              []Port                      `json:"ports"`
	Mounts             []Mount                     `json:"mounts"`
	DependsOn          []string                    `json:"dependsOn"`
	Health             Health                      `json:"health"`
	Command            []string                    `json:"command,omitempty"`
	Entrypoint         []string                    `json:"entrypoint,omitempty"`
	SharedMemoryBytes  *int64                      `json:"sharedMemoryBytes,omitempty"`
	StopTimeoutSeconds int                         `json:"stopTimeoutSeconds"`
}

// MarshalJSON preserves configuration presence: nil inherits image defaults,
// while a non-nil command or entrypoint, including [], is explicitly provided.
func (s Service) MarshalJSON() ([]byte, error) {
	type serviceJSON Service
	var command, entrypoint *[]string
	if s.Command != nil {
		command = &s.Command
	}
	if s.Entrypoint != nil {
		entrypoint = &s.Entrypoint
	}
	return json.Marshal(struct {
		serviceJSON
		Command    *[]string `json:"command,omitempty"`
		Entrypoint *[]string `json:"entrypoint,omitempty"`
	}{serviceJSON(s), command, entrypoint})
}

type Volume struct {
	ID   string  `json:"id"`
	Kind string  `json:"kind"`
	Role *string `json:"role,omitempty"`
}

// Default preserves both presence and the JSON scalar type, including false and zero.
type Parameter struct {
	Type      string          `json:"type"`
	Label     string          `json:"label"`
	Required  bool            `json:"required"`
	Default   json.RawMessage `json:"default,omitempty"`
	Minimum   *json.Number    `json:"minimum,omitempty"`
	Maximum   *json.Number    `json:"maximum,omitempty"`
	MinLength *int            `json:"minLength,omitempty"`
	MaxLength *int            `json:"maxLength,omitempty"`
	Pattern   *string         `json:"pattern,omitempty"`
	Choices   []string        `json:"choices,omitempty"`
}
type Upgrade struct {
	Strategy       string   `json:"strategy"`
	FromReleaseIDs []string `json:"fromReleaseIds"`
}
type Backup struct {
	Strategy string   `json:"strategy"`
	Volumes  []string `json:"volumes"`
}
type Initialization struct {
	Mode          string  `json:"mode"`
	ServiceID     *string `json:"serviceId,omitempty"`
	PortID        *string `json:"portId,omitempty"`
	Path          *string `json:"path,omitempty"`
	Pointer       *string `json:"pointer,omitempty"`
	RequiredValue *bool   `json:"requiredValue,omitempty"`
}
type NativeLicense struct {
	Requirement string `json:"requirement"`
	Message     string `json:"message"`
}
type PermissionProfile struct {
	ID              string   `json:"id"`
	Network         string   `json:"network"`
	PID             string   `json:"pid"`
	Privileged      bool     `json:"privileged"`
	DockerSocket    bool     `json:"dockerSocket"`
	CapDrop         []string `json:"capDrop"`
	NoNewPrivileges bool     `json:"noNewPrivileges"`
}
type Grant struct {
	SourceID string `json:"sourceId"`
	AppID    string `json:"appId"`
	Profile  string `json:"profile"`
}
type AppGrant struct {
	SourceID string `json:"sourceId"`
	AppID    string `json:"appId"`
}
type Policy struct {
	Protocol                      int
	Platforms                     []string
	Capabilities                  []string
	Registries                    []string
	Grants                        []Grant
	NativeEnvironmentSecretGrants []AppGrant
}
