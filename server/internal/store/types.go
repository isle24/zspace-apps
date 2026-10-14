package store

import (
	"context"
	"errors"
	"time"
)

var ErrNotFound = errors.New("container not found")

type Options struct {
	SetupMode                                  string
	CloudDatabaseURL                           string
	NASAdminOnly                               bool
	CatalogOnly                                bool
	NASOrigin                                  string
	DataDir, StorageRoot, EngineMode, SSHAlias string
	PublishHost, AccessHost                    string
	Engine                                     Engine
}
type Mount struct {
	Source   string `json:"source"`
	Target   string `json:"target"`
	ReadOnly bool   `json:"readOnly"`
}
type Container struct {
	ID, Name, State, Image string
	Labels                 map[string]string
	Mounts                 []Mount
	Ports                  []PortBinding
}
type PortBinding struct {
	HostIP        string `json:"hostIp"`
	HostPort      int    `json:"hostPort"`
	ContainerPort int    `json:"containerPort"`
	Protocol      string `json:"protocol"`
}
type RunSpec struct {
	Name, Image             string
	PublishHost             string
	HostPort, ContainerPort int
	Labels                  map[string]string
	Mounts                  []Mount
	Env                     []string
	Root                    string
	MediaRootPath           string
	MediaStorageIdentity    string
	Provenance              PathProvenance
}
type Engine interface {
	Probe(context.Context) error
	ValidatePath(context.Context, string, string, bool) error
	Prepare(context.Context, string, string) error
	PortAvailable(context.Context, int) error
	Pull(context.Context, string) error
	Inspect(context.Context, string) (Container, error)
	Run(context.Context, RunSpec) error
	Health(context.Context, string, int, string) (string, error)
	Start(context.Context, string) error
	Stop(context.Context, string) error
}

// A retained container must be started at the same engine boundary that proves
// its immutable scope and directory ownership. Raw Start is not sufficient.
type ResumeSpec struct {
	Plan     Plan     `json:"plan"`
	Instance Instance `json:"instance"`
	StoreID  string   `json:"storeId"`
}
type guardedStarter interface {
	Resume(context.Context, ResumeSpec) error
}
type App struct {
	ID                   string `json:"id"`
	Name                 string `json:"name"`
	Category             string `json:"category"`
	Description          string `json:"description"`
	Version              string `json:"version"`
	Image                string `json:"image"`
	SourceURL            string `json:"sourceUrl"`
	Icon                 string `json:"icon"`
	Installable          bool   `json:"installable"`
	DefaultPort          int    `json:"defaultPort"`
	RequiresMedia        bool   `json:"requiresMedia"`
	RecipeStatus         string `json:"recipeStatus"`
	ManifestVerification string `json:"manifestVerification"`
	ContainerPort        int    `json:"-"`
	DataTarget           string `json:"-"`
	HealthPath           string `json:"-"`
}
type NativeIntegration struct {
	Status    string `json:"status"`
	ConfigURL string `json:"configUrl"`
	AppURL    string `json:"appUrl"`
	Reason    string `json:"reason"`
}
type Plan struct {
	PreviousImage         string            `json:"previousImage,omitempty"`
	ID                    string            `json:"id"`
	RetryOfPlanID         string            `json:"retryOfPlanId,omitempty"`
	RetryOfJobID          string            `json:"retryOfJobId,omitempty"`
	AppID                 string            `json:"appId"`
	RootID                string            `json:"rootId"`
	RootPath              string            `json:"rootPath"`
	StorageIdentity       string            `json:"storageIdentity"`
	DockerStorageIdentity string            `json:"dockerStorageIdentity"`
	DataPath              string            `json:"dataPath"`
	MediaPath             string            `json:"mediaPath,omitempty"`
	MediaRootID           string            `json:"mediaRootId,omitempty"`
	MediaRootPath         string            `json:"mediaRootPath,omitempty"`
	MediaStorageIdentity  string            `json:"mediaStorageIdentity,omitempty"`
	HostPort              int               `json:"hostPort"`
	PublishHost           string            `json:"publishHost"`
	ContainerName         string            `json:"containerName"`
	Image                 string            `json:"image"`
	AccessURL             string            `json:"accessUrl"`
	Mounts                []Mount           `json:"mounts"`
	ExpiresAt             time.Time         `json:"expiresAt"`
	NativeIntegration     NativeIntegration `json:"nativeIntegration"`
	InstanceID            string            `json:"instanceId"`
	ContainerPort         int               `json:"containerPort"`
	HealthPath            string            `json:"healthPath"`
}
type Instance struct {
	ID                   string            `json:"id"`
	AppID                string            `json:"appId"`
	ContainerName        string            `json:"containerName"`
	ContainerID          string            `json:"containerId,omitempty"`
	Image                string            `json:"image"`
	DataPath             string            `json:"dataPath"`
	RootPath             string            `json:"rootPath"`
	MediaRootPath        string            `json:"mediaRootPath,omitempty"`
	MediaStorageIdentity string            `json:"mediaStorageIdentity,omitempty"`
	HostPort             int               `json:"hostPort"`
	PublishHost          string            `json:"publishHost"`
	ContainerPort        int               `json:"containerPort"`
	AccessURL            string            `json:"accessUrl"`
	State                string            `json:"state"`
	Health               string            `json:"health"`
	Initialization       string            `json:"initialization"`
	NativeIntegration    NativeIntegration `json:"nativeIntegration"`
	Mounts               []Mount           `json:"mounts"`
	CreatedAt            time.Time         `json:"createdAt"`
	Provenance           PathProvenance    `json:"provenance"`
}
type StorageCandidate struct {
	Path             string `json:"path"`
	MountPoint       string `json:"mountPoint"`
	Source           string `json:"source"`
	Filesystem       string `json:"filesystem"`
	Identity         string `json:"identity"`
	VolumeType       string `json:"volumeType"`
	FreeBytes        uint64 `json:"freeBytes"`
	TotalBytes       uint64 `json:"totalBytes"`
	SystemDisk       bool   `json:"systemDisk"`
	VerifiedDataPool bool   `json:"verifiedDataPool"`
	InstallAllowed   bool   `json:"installAllowed"`
	MediaReadAllowed bool   `json:"mediaReadAllowed"`
	Reason           string `json:"reason"`
}
type StorageRoot struct {
	ID      string           `json:"id"`
	Name    string           `json:"name"`
	Path    string           `json:"path"`
	Roles   []string         `json:"roles"`
	Storage StorageCandidate `json:"storage"`
}
type storageInspector interface {
	DiscoverStorage(context.Context) ([]StorageCandidate, error)
	InspectStorage(context.Context, string) (StorageCandidate, error)
	DockerStorage(context.Context) (StorageCandidate, error)
}
type Stage struct {
	Name    string    `json:"name"`
	Status  string    `json:"status"`
	At      time.Time `json:"at"`
	Message string    `json:"message,omitempty"`
}
type Job struct {
	ID         string    `json:"id"`
	PlanID     string    `json:"planId"`
	RequestID  string    `json:"requestId"`
	InstanceID string    `json:"instanceId"`
	Status     string    `json:"status"`
	Stage      string    `json:"stage"`
	Stages     []Stage   `json:"stages"`
	Error      string    `json:"error,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}
