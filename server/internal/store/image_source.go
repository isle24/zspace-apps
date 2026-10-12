package store

import (
	"encoding/json"
	"errors"
)

// This exact, server-owned tuple is the only permitted retry source migration.
// Keep engine recipe validation and reviewed retry validation on the same mapping.
var retryImageSources = []struct{ appID, source, previous, image string }{
	{"uptime-kuma", "ghcr", "louislam/uptime-kuma:2.5.6", "ghcr.io/louislam/uptime-kuma:2.5.6"},
}

func retryImage(appID, previous, source string) (string, error) {
	for _, choice := range retryImageSources {
		if choice.appID == appID && choice.previous == previous && choice.source == source {
			return choice.image, nil
		}
	}
	return "", errors.New("当前应用镜像不支持所选的同版本官方源切换。")
}

func controlledRecipe(image string) (App, bool) {
	canonical := image
	for _, choice := range retryImageSources {
		if image == choice.image {
			canonical = choice.previous
		}
	}
	var apps []App
	if json.Unmarshal(catalogJSON, &apps) != nil {
		return App{}, false
	}
	for _, app := range apps {
		if app.Installable && app.Image == canonical {
			return app, true
		}
	}
	return App{}, false
}

func validateRetryImage(p Plan) error {
	recipe, ok := controlledRecipe(p.Image)
	if !ok || recipe.ID != p.AppID {
		return errors.New("重试镜像不属于受控应用配方。")
	}
	if p.PreviousImage != "" {
		if p.MediaPath != "" || p.MediaRootID != "" || p.MediaRootPath != "" || p.MediaStorageIdentity != "" || p.ContainerPort != 3001 || len(p.Mounts) != 1 || p.Mounts[0] != (Mount{Source: p.DataPath, Target: "/app/data"}) {
			return errors.New("镜像源切换与受控配方端口或挂载不一致。")
		}
		selected, err := retryImage(p.AppID, p.PreviousImage, "ghcr")
		if err != nil || selected != p.Image || p.RetryOfPlanID == "" || p.RetryOfJobID == "" {
			return errors.New("镜像源切换缺少有效的原镜像与重试计划关联。")
		}
	}
	return nil
}
