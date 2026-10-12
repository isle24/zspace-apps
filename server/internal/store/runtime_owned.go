package store

import "errors"

var runtimeOwnerUnavailable = errors.New("owner_image_unavailable: 作者软件尚未导入或完整身份无法核验，请导入固定作者交付归档；不从镜像仓库拉取")

func nasReaderImage() RuntimeImage {
	return RuntimeImage{ServiceID: "nasreader", TagReference: "nasreader:free-platforms-reader-licensed-amd64-20261010", Reference: "sha256:0f1ea3da17ac3c2a37a7525323dbaeb5ea1c3c0ae7a5508329ca8f6a008f9ccb", Platform: "linux/amd64", Publisher: "nasreader", DeliverySource: "owner-archive", ConfigID: "sha256:0f1ea3da17ac3c2a37a7525323dbaeb5ea1c3c0ae7a5508329ca8f6a008f9ccb", ArchiveSHA256: "90e7de4c1d97c548a838d086190b80ab52f7feb4be3abef013f3fcf4562fd491", ArchiveSizeBytes: 44854784, DiffIDs: []string{
		"sha256:e63b02c2b5c761df2cb95e657d744f27d95da4e051235a13c80b88cd68eab188",
		"sha256:15a1fd6977575dfbd3ce1a551140eeb3210e944b7d50bf69e69f5815b8506c7a",
		"sha256:f8b32a7528ea40fb89aa834497fa3562c9099801ee2abbdc7e87714f48839408",
		"sha256:54f59a3b6c5d3204c4d96327b21b1484fcb57919cbe1b72d6aa99adb311592b4",
		"sha256:e36189ddb1f2188fd22b562f2a5551aec748aade5ba6a1c9204991e3c90ff2a7",
		"sha256:287a4a9a15206855817ba3624df195400b576c9a78326bc156625555c2cfe25a"}}
}
func nasReaderRecipe(version string) (RuntimeRecipe, bool) {
	if version != "" && version != "0.1.0" {
		return RuntimeRecipe{}, false
	}
	return RuntimeRecipe{AppID: "nasreader", Name: "nasReader", Version: "0.1.0", Revision: "2026-10-12.1", License: "AGPL-3.0", Category: "reading", Icon: "/app-icons/nasreader.svg", MediaTarget: "/library", MigrationStrategy: "snapshot-copy-switch", Initialization: "administrator-setup", Description: "自有图书阅读服务；原生授权需在应用内核验", DefaultPort: 8080, RequiresMedia: true, SupportedPlatforms: []string{"linux/amd64"}, CompatibleFrom: []string{}, MinimumMemoryBytes: 256 * 1024 * 1024, DeliveryLabel: "licensed-amd64-20261010", NativeLicense: "授权待应用内核验", Services: []RuntimeService{{ID: "nasreader", Image: nasReaderImage().TagReference, HealthPath: "/health", UserMode: "host", Entry: true, ContainerPort: 8080, Environment: map[string]string{}, Volumes: []RuntimeVolume{{Name: "data", Target: "/data", Role: "data"}, {Name: "inbox", Target: "/inbox", Role: "data"}, {Name: "media", Target: "/library", Role: "media-readonly"}}}}}, true
}
