package store

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"time"
)

func (c *cloudService) readApps(published bool) ([]CloudApp, error) {
	column := "draft_json"
	where := ""
	if published {
		column = "published_json"
		where = " WHERE published_json IS NOT NULL"
	}
	rows, err := c.db.Query(`SELECT ` + column + ` FROM cloud_apps` + where + ` ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []CloudApp{}
	for rows.Next() {
		var b string
		var item CloudApp
		if err := rows.Scan(&b); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(b), &item); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
func (c *cloudService) readApp(id string, published bool) (CloudApp, error) {
	column := "draft_json"
	if published {
		column = "published_json"
	}
	var b sql.NullString
	var app CloudApp
	err := c.db.QueryRow(`SELECT `+column+` FROM cloud_apps WHERE id=?`, id).Scan(&b)
	if err == nil && !b.Valid {
		err = sql.ErrNoRows
	}
	if err == nil {
		err = json.Unmarshal([]byte(b.String), &app)
	}
	return app, err
}
func (c *cloudService) catalog(w http.ResponseWriter, r *http.Request) {
	items, err := c.readApps(true)
	if err != nil {
		fail(w, 500, "cloud_catalog_failed", "无法读取应用目录。")
		return
	}
	respond(w, 200, map[string]any{"items": items})
}
func (c *cloudService) catalogDetail(w http.ResponseWriter, r *http.Request) {
	app, err := c.readApp(r.PathValue("id"), true)
	if err != nil {
		fail(w, 404, "cloud_app_not_found", "应用未上架。")
		return
	}
	if !app.CatalogOnly {
		c.cache.enqueue(app.Image)
	}
	data := map[string]any{"app": app}
	if app.CatalogOnly {
		respond(w, 200, data)
		return
	}
	var raw []byte
	if err := c.db.QueryRowContext(r.Context(), `SELECT manifest FROM cloud_releases WHERE app_id=? AND release_number=?`, app.ID, app.ReleaseNumber).Scan(&raw); err == nil {
		data["manifest"] = json.RawMessage(raw)
		data["protocol"] = "store.app.v1"
	}
	respond(w, 200, data)
}
func (c *cloudService) adminApps(w http.ResponseWriter, r *http.Request) {
	items, err := c.readApps(false)
	if err != nil {
		fail(w, 500, "cloud_catalog_failed", "无法读取应用目录。")
		return
	}
	respond(w, 200, map[string]any{"items": items})
}

type CloudWishlist struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Image       string `json:"image,omitempty"`
	Username    string `json:"username"`
	Status      string `json:"status"`
	CreatedAt   string `json:"createdAt"`
	AppID       string `json:"appId,omitempty"`
}

func (c *cloudService) wishlistRows(userID string) ([]CloudWishlist, error) {
	where := ""
	args := []any{}
	if userID != "" {
		where = " WHERE w.user_id=?"
		args = append(args, userID)
	}
	rows, err := c.db.Query(`SELECT w.id,w.name,w.description,w.image,COALESCE(a.username,(SELECT username FROM cloud_admin WHERE id=1),''),w.status,w.created_at,w.app_id FROM cloud_wishlist w LEFT JOIN cloud_accounts a ON a.id=w.user_id`+where+` ORDER BY w.created_at DESC,w.id LIMIT 1000`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []CloudWishlist{}
	for rows.Next() {
		var item CloudWishlist
		var created int64
		if err := rows.Scan(&item.ID, &item.Name, &item.Description, &item.Image, &item.Username, &item.Status, &created, &item.AppID); err != nil {
			return nil, err
		}
		item.CreatedAt = time.Unix(created, 0).UTC().Format(time.RFC3339)
		items = append(items, item)
	}
	return items, rows.Err()
}
func (c *cloudService) wishlist(w http.ResponseWriter, r *http.Request) {
	c.listWishlist(w, r, cloudActor(r).ID)
}
func (c *cloudService) adminWishlist(w http.ResponseWriter, r *http.Request) {
	c.listWishlist(w, r, "")
}
func (c *cloudService) listWishlist(w http.ResponseWriter, r *http.Request, userID string) {
	items, err := c.wishlistRows(userID)
	if err != nil {
		fail(w, 500, "cloud_wishlist_failed", "无法读取心愿单。")
		return
	}
	respond(w, 200, map[string]any{"items": items})
}
func (c *cloudService) createWishlist(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Image       string `json:"image"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	in.Description = strings.TrimSpace(in.Description)
	if !cloudText(in.Name, 1, 160) || !cloudText(in.Description, 1, 2000) {
		fail(w, 400, "invalid_wishlist", "请填写应用名称和需求说明。")
		return
	}
	if in.Image != "" {
		if _, err := cloudImageReference(in.Image); err != nil {
			fail(w, 400, "invalid_image", "镜像仅支持公开 Docker Hub 或 GHCR 引用。")
			return
		}
	}
	user := cloudActor(r)
	var count int
	if err := c.db.QueryRowContext(r.Context(), `SELECT count(*) FROM cloud_wishlist WHERE user_id=?`, user.ID).Scan(&count); err != nil {
		fail(w, 500, "cloud_wishlist_failed", "无法保存心愿单。")
		return
	}
	if count >= 100 {
		fail(w, 409, "wishlist_limit", "每个账户最多保存100条应用心愿。")
		return
	}
	item := CloudWishlist{ID: randomID(), Name: in.Name, Description: in.Description, Image: in.Image, Username: user.Username, Status: "pending", CreatedAt: time.Now().UTC().Format(time.RFC3339)}
	if _, err := c.db.ExecContext(r.Context(), `INSERT INTO cloud_wishlist(id,user_id,name,description,image,status,created_at) VALUES(?,?,?,?,?,?,?)`, item.ID, user.ID, item.Name, item.Description, item.Image, item.Status, time.Now().Unix()); err != nil {
		fail(w, 500, "cloud_wishlist_failed", "无法保存心愿单。")
		return
	}
	respond(w, 201, map[string]any{"item": item})
}
func (c *cloudService) updateWishlist(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Status string `json:"status"`
		AppID  string `json:"appId"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !map[string]bool{"pending": true, "reviewing": true, "planned": true, "published": true, "rejected": true}[in.Status] {
		fail(w, 400, "invalid_wishlist_status", "心愿单状态无效。")
		return
	}
	if in.AppID != "" {
		if _, err := c.readApp(in.AppID, in.Status == "published"); err != nil {
			fail(w, 400, "invalid_app", "关联应用不存在或尚未发布。")
			return
		}
	} else if in.Status == "published" {
		fail(w, 400, "invalid_app", "已上架的心愿须关联应用。")
		return
	}
	result, err := c.db.ExecContext(r.Context(), `UPDATE cloud_wishlist SET status=?,app_id=? WHERE id=?`, in.Status, in.AppID, r.PathValue("id"))
	if err != nil {
		fail(w, 500, "cloud_wishlist_failed", "无法保存心愿单状态。")
		return
	}
	n, _ := result.RowsAffected()
	if n != 1 {
		fail(w, 404, "wishlist_not_found", "心愿单不存在。")
		return
	}
	respond(w, 200, map[string]bool{"updated": true})
}

type CloudHistory struct {
	ID         string `json:"id"`
	AppID      string `json:"appId"`
	AppName    string `json:"appName"`
	Version    string `json:"version"`
	Status     string `json:"status"`
	DeviceName string `json:"deviceName,omitempty"`
	UpdatedAt  string `json:"updatedAt"`
}

var cloudVersionRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`)
var cloudDeviceRE = regexp.MustCompile(`^[\p{L}\p{N} _().-]{0,80}$`)
var cloudIPv4RE = regexp.MustCompile(`\b[0-9]{1,3}(?:\.[0-9]{1,3}){3}\b`)

func (c *cloudService) history(w http.ResponseWriter, r *http.Request) {
	rows, err := c.db.QueryContext(r.Context(), `SELECT id,app_id,app_name,version,status,device_name,updated_at FROM cloud_history WHERE user_id=? ORDER BY updated_at DESC,id LIMIT 1000`, cloudActor(r).ID)
	if err != nil {
		fail(w, 500, "cloud_history_failed", "无法读取安装记录。")
		return
	}
	defer rows.Close()
	items := []CloudHistory{}
	for rows.Next() {
		var item CloudHistory
		var updated int64
		if err := rows.Scan(&item.ID, &item.AppID, &item.AppName, &item.Version, &item.Status, &item.DeviceName, &updated); err != nil {
			fail(w, 500, "cloud_history_failed", "无法读取安装记录。")
			return
		}
		item.UpdatedAt = time.Unix(updated, 0).UTC().Format(time.RFC3339)
		items = append(items, item)
	}
	if rows.Err() != nil {
		fail(w, 500, "cloud_history_failed", "无法读取安装记录。")
		return
	}
	respond(w, 200, map[string]any{"items": items})
}
func (c *cloudService) recordHistory(w http.ResponseWriter, r *http.Request) {
	var in struct {
		AppID      string `json:"appId"`
		Version    string `json:"version"`
		Status     string `json:"status"`
		DeviceName string `json:"deviceName"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !cloudVersionRE.MatchString(in.Version) || (in.Status != "installed" && in.Status != "removed") || !cloudDeviceRE.MatchString(in.DeviceName) || cloudIPv4RE.MatchString(in.DeviceName) {
		fail(w, 400, "invalid_history", "安装记录仅支持版本、安装状态和设备昵称。")
		return
	}
	app, err := c.readApp(in.AppID, true)
	if err != nil {
		fail(w, 400, "cloud_app_not_found", "应用未上架。")
		return
	}
	if app.CatalogOnly {
		fail(w, 400, "cloud_app_not_installable", "此应用仅公开资料，安装支持待适配。")
		return
	}
	user := cloudActor(r)
	id := randomID()
	now := time.Now().UTC().Truncate(time.Second)
	if _, err := c.db.ExecContext(r.Context(), `INSERT INTO cloud_history(id,user_id,app_id,app_name,version,status,device_name,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,app_id,device_name) DO UPDATE SET app_name=excluded.app_name,version=excluded.version,status=excluded.status,updated_at=excluded.updated_at`, id, user.ID, app.ID, app.Name, in.Version, in.Status, in.DeviceName, now.Unix()); err != nil {
		fail(w, 500, "cloud_history_failed", "无法保存安装记录。")
		return
	}
	if err := c.db.QueryRowContext(r.Context(), `SELECT id FROM cloud_history WHERE user_id=? AND app_id=? AND device_name=?`, user.ID, app.ID, in.DeviceName).Scan(&id); err != nil {
		fail(w, 500, "cloud_history_failed", "无法保存安装记录。")
		return
	}
	respond(w, 201, map[string]any{"item": CloudHistory{ID: id, AppID: app.ID, AppName: app.Name, Version: in.Version, Status: in.Status, DeviceName: in.DeviceName, UpdatedAt: now.Format(time.RFC3339)}})
}
