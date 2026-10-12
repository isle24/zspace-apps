package store

import (
	"context"
	"time"
)

type RuntimeVolume struct {
	Name   string `json:"name"`
	Target string `json:"target"`
	Role   string `json:"role"`
}
type RuntimeService struct {
	HealthStartPeriodSeconds   int               `json:"healthStartPeriodSeconds"`
	HealthStartIntervalSeconds int               `json:"healthStartIntervalSeconds"`
	SharedMemoryBytes          int64             `json:"sharedMemoryBytes"`
	ID                         string            `json:"id"`
	Image                      string            `json:"image"`
	HealthPath                 string            `json:"healthPath"`
	UserMode                   string            `json:"userMode"`
	Volumes                    []RuntimeVolume   `json:"volumes"`
	Environment                map[string]string `json:"environment"`
	DependsOn                  []string          `json:"dependsOn"`
	Entry                      bool              `json:"entry"`
	ContainerPort              int               `json:"containerPort"`
	HealthCommand              []string          `json:"healthCommand"`
	HealthIntervalSeconds      int               `json:"healthIntervalSeconds"`
	HealthTimeoutSeconds       int               `json:"healthTimeoutSeconds"`
	HealthRetries              int               `json:"healthRetries"`
}

type RuntimeRecipe struct {
	CatalogIconURL     string           `json:"catalogIconUrl,omitempty"`
	Documentation      string           `json:"documentation,omitempty"`
	DeliveryLabel      string           `json:"deliveryLabel,omitempty"`
	NativeLicense      string           `json:"nativeLicense,omitempty"`
	AppID              string           `json:"appId"`
	Name               string           `json:"name"`
	Version            string           `json:"version"`
	Revision           string           `json:"revision"`
	SourceURL          string           `json:"sourceUrl"`
	License            string           `json:"license"`
	Category           string           `json:"category"`
	Icon               string           `json:"icon"`
	MediaTarget        string           `json:"mediaTarget"`
	MigrationStrategy  string           `json:"migrationStrategy"`
	Initialization     string           `json:"initialization"`
	Description        string           `json:"description"`
	Services           []RuntimeService `json:"services"`
	DefaultPort        int              `json:"defaultPort"`
	RequiresMedia      bool             `json:"requiresMedia"`
	SupportedPlatforms []string         `json:"supportedPlatforms"`
	CompatibleFrom     []string         `json:"compatibleFrom"`
	MinimumMemoryBytes uint64           `json:"minimumMemoryBytes"`
}

type RuntimeImage struct {
	ConfigID         string   `json:"configId,omitempty"`
	ArchiveSHA256    string   `json:"archiveSha256,omitempty"`
	ArchiveSizeBytes int64    `json:"archiveSizeBytes,omitempty"`
	DiffIDs          []string `json:"diffIds,omitempty"`
	ServiceID        string   `json:"serviceId"`
	TagReference     string   `json:"tagReference"`
	Reference        string   `json:"reference"`
	Digest           string   `json:"digest"`
	Platform         string   `json:"platform"`
	Publisher        string   `json:"publisher"`
	DeliverySource   string   `json:"deliverySource"`
}

type RuntimeContainer struct {
	ServiceID string `json:"serviceId"`
	ID        string `json:"id"`
	Name      string `json:"name"`
	Image     string `json:"image"`
	State     string `json:"state"`
}

type RuntimeGeneration struct {
	SecretSetID           string             `json:"secretSetId,omitempty"`
	StoreID               string             `json:"storeId"`
	StorageIdentity       string             `json:"storageIdentity"`
	DockerStorageIdentity string             `json:"dockerStorageIdentity"`
	ID                    string             `json:"id"`
	InstanceID            string             `json:"instanceId"`
	AppID                 string             `json:"appId"`
	Version               string             `json:"version"`
	RecipeRevision        string             `json:"recipeRevision"`
	RootPath              string             `json:"rootPath"`
	DataPath              string             `json:"dataPath"`
	NetworkID             string             `json:"networkId"`
	MediaPath             string             `json:"mediaPath"`
	MediaRootPath         string             `json:"mediaRootPath"`
	MediaStorageIdentity  string             `json:"mediaStorageIdentity"`
	PublishHost           string             `json:"publishHost"`
	AccessURL             string             `json:"accessUrl"`
	State                 string             `json:"state"`
	HostPort              int                `json:"hostPort"`
	PeerPort              int                `json:"peerPort"`
	DiscoveryPort         int                `json:"discoveryPort"`
	Images                []RuntimeImage     `json:"images"`
	Containers            []RuntimeContainer `json:"containers"`
	Provenance            PathProvenance     `json:"provenance"`
	Recipe                RuntimeRecipe      `json:"recipe"`
}

type RuntimeSnapshot struct {
	ID             string            `json:"id"`
	InstanceID     string            `json:"instanceId"`
	GenerationID   string            `json:"generationId"`
	RootPath       string            `json:"rootPath"`
	Path           string            `json:"path"`
	SHA256         string            `json:"sha256"`
	AppID          string            `json:"appId"`
	Version        string            `json:"version"`
	RecipeRevision string            `json:"recipeRevision"`
	SizeBytes      int64             `json:"sizeBytes"`
	CreatedAt      time.Time         `json:"createdAt"`
	Source         RuntimeGeneration `json:"source"`
}

type RuntimePlan struct {
	SecretSetID           string         `json:"secretSetId,omitempty"`
	SecretParameterNames  []string       `json:"secretParameterNames,omitempty"`
	RetryOfJobID          string         `json:"retryOfJobId,omitempty"`
	RetryOfPlanID         string         `json:"retryOfPlanId,omitempty"`
	StoreID               string         `json:"storeId"`
	GenerationID          string         `json:"generationId"`
	SourceVersion         string         `json:"sourceVersion"`
	StopServices          []string       `json:"stopServices"`
	SnapshotRequired      bool           `json:"snapshotRequired"`
	NewDataCopy           bool           `json:"newDataCopy"`
	SourceSnapshotID      string         `json:"sourceSnapshotId"`
	SnapshotRootPath      string         `json:"snapshotRootPath"`
	ID                    string         `json:"id"`
	Kind                  string         `json:"kind"`
	AppID                 string         `json:"appId"`
	InstanceID            string         `json:"instanceId"`
	RootID                string         `json:"rootId"`
	RootPath              string         `json:"rootPath"`
	DataPath              string         `json:"dataPath"`
	SourceGenerationID    string         `json:"sourceGenerationId"`
	SnapshotID            string         `json:"snapshotId"`
	TargetVersion         string         `json:"targetVersion"`
	PublishHost           string         `json:"publishHost"`
	AccessURL             string         `json:"accessUrl"`
	StorageIdentity       string         `json:"storageIdentity"`
	DockerStorageIdentity string         `json:"dockerStorageIdentity"`
	MediaPath             string         `json:"mediaPath"`
	MediaRootPath         string         `json:"mediaRootPath"`
	MediaStorageIdentity  string         `json:"mediaStorageIdentity"`
	HostPort              int            `json:"hostPort"`
	PeerPort              int            `json:"peerPort"`
	DiscoveryPort         int            `json:"discoveryPort"`
	Recipe                RuntimeRecipe  `json:"recipe"`
	Images                []RuntimeImage `json:"images"`
	ExpiresAt             time.Time      `json:"expiresAt"`
}

type RuntimeFacts struct {
	Platform       string `json:"platform"`
	DockerRoot     string `json:"dockerRoot"`
	DockerVersion  string `json:"dockerVersion"`
	ComposeVersion string `json:"composeVersion"`
	UserID         int    `json:"userId"`
	GroupID        int    `json:"groupId"`
	CPUs           int    `json:"cpus"`
	MemoryBytes    uint64 `json:"memoryBytes"`
}

type RuntimeEngine interface {
	RuntimeFacts(context.Context) (RuntimeFacts, error)
	ResolveRuntimeImages(context.Context, RuntimeRecipe, string) ([]RuntimeImage, error)
	PrepareGeneration(context.Context, RuntimePlan) (RuntimeGeneration, error)
	LaunchGeneration(context.Context, RuntimePlan, RuntimeGeneration) (RuntimeGeneration, error)
	InspectGeneration(context.Context, RuntimeGeneration) (RuntimeGeneration, error)
	ControlGeneration(context.Context, RuntimeGeneration, string) error
	SnapshotGeneration(context.Context, RuntimeGeneration, string, string) (RuntimeSnapshot, error)
	RestoreGeneration(context.Context, RuntimeSnapshot, RuntimePlan) (RuntimeGeneration, error)
	RuntimeLogs(context.Context, RuntimeGeneration, string, int) (string, error)
	RuntimeDirectories(context.Context, string, string) ([]string, error)
}
