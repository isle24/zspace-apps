package store

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

func validCloudSource(raw string) bool {
	if raw == "" {
		return true
	}
	u, err := url.Parse(raw)
	return err == nil && len(raw) <= 1000 && u.Scheme == "https" && u.Hostname() != "" && u.User == nil && u.RawQuery == "" && u.Fragment == "" && u.Port() == "" && !strings.ContainsAny(raw, "\\\r\n\t")
}
func cloudValidateListing(a CloudApp) bool {
	return a.CatalogOnly && cloudAppIDRE.MatchString(a.ID) && cloudText(a.Name, 1, 128) && cloudText(a.Description, 1, 2048) && cloudAppIDRE.MatchString(a.Category) && cloudVersionRE.MatchString(a.Version) && cloudText(a.CompatibilityNote, 1, 1000) && validCloudSource(a.SourceURL) && (a.Icon == "" || cloudIconURL(a.Icon))
}

// A public reference has no executable delivery fields. It never becomes a
// restricted-v1 installable just because an administrator published its name.
func cloudListingProjection(a CloudApp) CloudApp {
	return CloudApp{ID: a.ID, Name: a.Name, Description: a.Description, Category: a.Category, Icon: a.Icon, Version: a.Version, CatalogOnly: true, CompatibilityNote: a.CompatibilityNote, SourceURL: a.SourceURL, Published: a.Published, DataTargets: []string{}, Environment: []CloudEnvironment{}}
}
func (c *cloudService) publishListingApp(ctx context.Context, a CloudApp) (CloudApp, error) {
	a = cloudListingProjection(a)
	if !cloudValidateListing(a) {
		return CloudApp{}, errors.New("invalid_listing")
	}
	if prior, err := c.readApp(a.ID, true); err == nil && !prior.CatalogOnly {
		return CloudApp{}, errors.New("existing_delivery_preserved")
	}
	a.Published = true
	b, _ := json.Marshal(a)
	_, err := c.db.ExecContext(ctx, `INSERT INTO cloud_apps(id,draft_json,published_json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET draft_json=excluded.draft_json,published_json=excluded.published_json,revision=cloud_apps.revision+1`, a.ID, string(b), string(b))
	return a, err
}
func (c *cloudService) publishListing(w http.ResponseWriter, r *http.Request) {
	c.publicationMu.Lock()
	defer c.publicationMu.Unlock()
	a, err := c.readApp(r.PathValue("id"), false)
	if err != nil {
		fail(w, 404, "cloud_app_not_found", "应用草稿不存在。")
		return
	}
	a, err = c.publishListingApp(r.Context(), a)
	if err != nil {
		fail(w, 400, "invalid_listing", "请核对公开资料；已发布的安装版本需要保留。")
		return
	}
	respond(w, 200, map[string]any{"app": a})
}

type CloudPublicationOutcome struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Code   string `json:"code,omitempty"`
}

func (c *cloudService) publishCloudApps(ctx context.Context, apps []CloudApp) ([]CloudPublicationOutcome, error) {
	outcomes := []CloudPublicationOutcome{}
	// Review independent public registry references before the brief serialized
	// publication phase. Six bounded reads avoid holding maintenance for one
	// timeout per application; only verified SDK results feed the same publisher.
	type inspection struct {
		info CloudImageInspection
		err  error
	}
	inspected := map[string]inspection{}
	references := map[string]bool{}
	for _, app := range apps {
		if !app.CatalogOnly && cloudValidateApp(app) {
			if prior, e := c.readApp(app.ID, true); e == nil && prior.Published {
				continue
			}
			references[app.Image] = true
		}
	}
	resolver := c.resolveImage
	var mu sync.Mutex
	var wg sync.WaitGroup
	slots := make(chan struct{}, 6)
	for reference := range references {
		wg.Add(1)
		go func(ref string) {
			defer wg.Done()
			select {
			case slots <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-slots }()
			info, e := resolver(ctx, ref)
			mu.Lock()
			inspected[ref] = inspection{info, e}
			mu.Unlock()
		}(reference)
	}
	wg.Wait()
	reviewedResolver := func(_ context.Context, ref string) (CloudImageInspection, error) {
		value, ok := inspected[ref]
		if !ok {
			return CloudImageInspection{}, errors.New("image_not_reviewed")
		}
		return value.info, value.err
	}
	for _, a := range apps {
		if ctx.Err() != nil {
			return outcomes, ctx.Err()
		}
		if !cloudAppIDRE.MatchString(a.ID) {
			return outcomes, errors.New("invalid_application_id")
		}
		if prior, err := c.readApp(a.ID, true); err == nil && prior.Published {
			outcomes = append(outcomes, CloudPublicationOutcome{a.ID, "preserved", ""})
			continue
		}
		c.publicationMu.Lock()
		result := CloudPublicationOutcome{ID: a.ID, Status: "catalog-only"}
		if !a.CatalogOnly {
			_, _, err := c.publishInstallableUsing(ctx, a, reviewedResolver)
			if err == nil {
				result.Status = "installable"
			} else {
				result.Code = err.Error()
				a.CatalogOnly = true
				a.CompatibilityNote = "镜像或安装配置尚未通过核验，安装支持待适配。"
			}
		}
		if result.Status != "installable" {
			_, err := c.publishListingApp(ctx, a)
			if err != nil {
				c.publicationMu.Unlock()
				return outcomes, errors.New("catalog_listing_publication_failed")
			}
		}
		c.publicationMu.Unlock()
		outcomes = append(outcomes, result)
	}
	return outcomes, nil
}

// PublishCloudApps is a local server-operator entrypoint. It creates no HTTP
// listener or account session and uses the same validation/signing as the API.
func (s *Service) PublishCloudApps(ctx context.Context, apps []CloudApp) ([]CloudPublicationOutcome, error) {
	if !s.opts.CatalogOnly || s.opts.EngineMode != "disabled" {
		return nil, errors.New("operator_requires_catalog_only_disabled_engine")
	}
	c, err := newCloudService(s)
	if err != nil {
		return nil, errors.New("catalog_operator_unavailable")
	}
	return c.publishCloudApps(ctx, apps)
}
