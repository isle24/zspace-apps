package store

import (
	"context"
	"strings"
)

func resolveRuntimeCloudImages(ctx context.Context, recipe RuntimeRecipe, platform string) ([]RuntimeImage, error) {
	if !runtimeCloudRecipeApproved(recipe) || platform != "linux/amd64" || len(recipe.Services) != 1 {
		return nil, runtimeCloudFailure
	}
	service := recipe.Services[0]
	ref, err := cloudImageReference(service.Image)
	if err != nil {
		return nil, runtimeCloudFailure
	}
	expected := ref.Identifier()
	if !cloudDigestRE.MatchString(expected) {
		return nil, runtimeCloudFailure
	}
	info, err := inspectCachedCloudImage(ctx, service.Image)
	if err != nil {
		info, err = inspectCloudImage(ctx, service.Image)
	}
	if err != nil || info.ImageDigest != expected || info.Architecture != platform {
		return nil, runtimeCloudFailure
	}
	repository := cloudRepository(ref)
	registry := strings.Split(repository, "/")[0]
	if registry == "docker.io" {
		registry = "registry-1.docker.io"
	}
	return []RuntimeImage{{ServiceID: service.ID, TagReference: service.Image, Reference: repository + "@" + expected, Digest: expected, Platform: platform, Publisher: repository, DeliverySource: registry}}, nil
}
