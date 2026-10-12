#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sidecar_ready_must_be_loopback_and_instance_bound() {
        for raw in [
            r#"{"event":"ready","address":"http://evil.example:4567","instanceId":"012345678901234567890123456789ab"}"#,
            r#"{"event":"ready","address":"http://127.0.0.1:0","instanceId":"012345678901234567890123456789ab"}"#,
            r#"{"event":"ready","address":"http://127.0.0.1:4567","instanceId":""}"#,
            r#"{"event":"ready","address":"http://user:secret@127.0.0.1:4567","instanceId":"012345678901234567890123456789ab"}"#,
        ] {
            assert!(parse_ready(raw).is_err());
        }
        assert!(parse_ready(r#"{"event":"ready","address":"http://127.0.0.1:4567","instanceId":"012345678901234567890123456789ab"}"#).is_ok());
    }
    #[test]
    fn vault_is_scoped_and_bounded() {
        assert!(validate_scope("nas:http://192.168.3.56:5055:user").is_ok());
        for scope in ["", "other-app", "nas:a\npassword", "nas:"] {
            assert!(validate_scope(scope).is_err());
        }
        assert!(validate_scope(&format!("nas:{}", "a".repeat(256))).is_err());
    }

    #[test]
    fn outside_links_cannot_execute_or_contain_credentials() {
        for value in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "http://user:secret@localhost/",
            "data:text/html,hello",
        ] {
            assert!(validate_external(value).is_err());
        }
        assert!(validate_external("http://192.168.3.56:3001/").is_ok());
        assert!(validate_external("https://example.com/").is_ok());
    }

    #[test]
    fn official_http_scope_allows_selected_routes_and_exact_newdir_url() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let scopes = capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["identifier"] == "http:default")
            .unwrap()["allow"]
            .as_array()
            .unwrap();
        let matches =
            |raw: &str| {
                scopes.iter().any(|v| {
                    // The plugin's private parser defaults search/hash to wildcards.
                    let mut init = urlpattern::UrlPatternInit::parse_constructor_string::<
                        regex::Regex,
                    >(v["url"].as_str().unwrap(), None)
                    .unwrap();
                    init.search = Some("*".into());
                    init.hash = Some("*".into());
                    let pattern =
                        urlpattern::UrlPattern::<regex::Regex>::parse(init, Default::default())
                            .unwrap();
                    pattern
                        .test(urlpattern::UrlPatternMatchInput::Url(raw.parse().unwrap()))
                        .unwrap()
                })
            };
        assert!(matches("http://192.168.3.56:5055/key/pub?signme=1"));
        assert!(matches("http://192.168.3.56:5055/zdocker/AppStore/v1/list"));
        assert!(matches("https://nas.example:5055/zdocker/AppStore/v1/list"));
        assert!(!matches(
            "http://192.168.3.56:5055/zdocker/AppStore/v1/remove"
        ));
        for path in [
            "/v2/album/feed/list",
            "/v2/album/home",
            "/system/polling2",
            "/zspool/info",
            "/zvideo/collection/info",
            "/zvideo/collection/video",
            "/file_search/file_search",
            "/v2/file/newdir",
            "/v2/file/upload",
            "/v2/file/tmpinfo",
            "/api/store/nas-session",
            "/api/store/logout",
            "/setting/change",
            "/AppStore/v1/disks",
            "/AppStore/v1/pkg/start",
            "/zdocker/AppStore/v1/pkg/stop",
            "/api/docker/capabilities",
            "/api/docker/containers",
            "/api/docker/control",
            "/zhelper/state",
            "/api/docker/create",
            "/api/docker/compose-create",
            "/kv/load",
            "/v2/file/notepad/list",
            "/v2/file/notepad/info",
            "/v2/file/notepad/new",
            "/v2/file/notepad/modify",
            "/v2/file/nb/list",
            "/v2/file/mrestore",
            "/v2/public/recycle/restore",
            "/v2/file/remove",
            "/downloader/engin/switch/exec",
            "/downloader/engin/switch/status",
            "/downloader/engin/switch/confirm",
            "/AppStore/v1/pkg/depend/by",
            "/AppStore/v1/pkg/remove",
            "/zdocker/AppStore/v1/pkg/remove",
            "/v2/file/decrypt/download",
            "/zdocker/app_check_port",
            "/zdocker/AppStore/v1/pkg/preinstall",
            "/zdocker/AppStore/v1/pkg/install",
            "/zdocker/AppStore/v1/pkg/depend/check",
            "/v2/album/albums",
            "/v2/album/album/create",
            "/v2/album/dirs",
            "/v2/album/feed/timeline",
            "/v2/album/babygrowth/timeline",
            "/api/docker/details/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "/api/docker/logs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",

        ] {
            assert!(matches(&format!("http://192.168.3.56:5055{path}")));
            assert!(matches(&format!("https://nas.example:5055{path}")));
        }
        for path in [
            "/file_search/file_search/extra",
            "/file_search/reindex",
            "/file_search/save_setting",
            "/file_search/skip_dir",
            "/file_search/history/delete",
            "/file_search/slow_file_search/start",
            "/file_search/slow_file_search/get_result",
            "/v2/file/newdir/child",
            "/v2/file/upload/child",
            "/v2/file/tmpinfo/child",
            "/v2/file/upload/whyfail",
            "/api/store/nas-session/extra",
            "/api/store/login",
            "/api/store/setup",
            "/api/store/install",
            "/v2/file/modify",
            "/v2/file/delete",
            "/api/docker/delete",
            "/api/docker/exec",
            "/v2/file/clean",
            "/v2/file/recycle",
        ] {
            assert!(!matches(&format!("http://192.168.3.56:5055{path}")));
            assert!(!matches(&format!("https://nas.example:5055{path}")));
        }
        // URLPattern scopes do not bind the selected NAS, method, query or port.
        // The private SDK enforces those fields; ACL assertions must not imply otherwise.
        assert!(matches(
            "http://nas.example:8050/v2/file/upload?remote_port=other"
        ));
        assert!(matches(
            "https://other.example:443/v2/file/tmpinfo?token=other"
        ));
        assert!(!matches("http://192.168.3.56:5055/zspool/delete"));
        assert!(!matches(
            "http://192.168.3.56:5055/zvideo/collection/delete"
        ));
        assert!(matches(
            "https://nas.example:5443/v2/file/sysdir?webagent=v2"
        ));
        assert!(!matches("http://192.168.3.56:5055/v2/file/delete"));
        assert!(!matches("http://192.168.3.56:5055/system/reset"));
    }
}
use serde::Deserialize;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ready {
    pub event: String,
    pub address: String,
    pub instance_id: String,
}

pub fn parse_ready(raw: &str) -> Result<Ready, String> {
    let ready: Ready = serde_json::from_str(raw).map_err(|_| "服务启动信息无效")?;
    let url = tauri::Url::parse(&ready.address).map_err(|_| "服务地址无效")?;
    if ready.event != "ready"
        || url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().unwrap_or(0) == 0
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || ready.instance_id.len() != 32
        || !ready.instance_id.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err("服务启动信息不属于本客户端".into());
    }
    Ok(ready)
}

pub fn validate_scope(scope: &str) -> Result<(), String> {
    if !scope.starts_with("nas:")
        || scope.len() <= 4
        || scope.len() > 256
        || scope.chars().any(char::is_control)
    {
        return Err("钥匙串范围无效".into());
    }
    Ok(())
}

pub fn validate_external(url: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|_| "链接无效")?;
    if !["http", "https"].contains(&parsed.scheme())
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || url.len() > 4096
    {
        return Err("仅支持不含账号密码的网页链接".into());
    }
    Ok(())
}
