mod contracts;
mod download;
mod media;
mod upload_hash;
mod upload_source;
use contracts::{parse_ready, validate_external, validate_scope};
use serde::Deserialize;
use std::sync::Mutex;
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, SubmenuBuilder};
use tauri::Manager;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

#[derive(Default)]
struct GatewayState {
    started: Mutex<bool>,
    ready: Mutex<Option<Result<String, String>>>,
    child: Mutex<Option<CommandChild>>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GatewayConfig {
    engine: Option<String>,
    ssh_alias: Option<String>,
    storage_root: Option<String>,
}

#[tauri::command]
async fn gateway_address(
    app: tauri::AppHandle,
    state: tauri::State<'_, GatewayState>,
) -> Result<String, String> {
    {
        let mut started = state.started.lock().map_err(|_| "商店服务状态不可用")?;
        if !*started {
            *started = true;
            if let Err(message) = start_gateway(&app) {
                *state.ready.lock().map_err(|_| "商店服务状态不可用")? = Some(Err(message));
            }
        }
    }
    for _ in 0..240 {
        if let Some(result) = state.ready.lock().map_err(|_| "服务状态不可用")?.as_ref() {
            return result.clone();
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Err("本地服务启动超时，请重启客户端并检查网关配置".into())
}

#[tauri::command]
fn vault_read(scope: String) -> Result<Option<String>, String> {
    validate_scope(&scope)?;
    let entry =
        keyring::Entry::new("com.isle.space-desktop", &scope).map_err(|_| "无法访问系统钥匙串")?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("无法读取系统钥匙串".into()),
    }
}

#[tauri::command]
fn vault_write(scope: String, value: String) -> Result<(), String> {
    validate_scope(&scope)?;
    if value.len() > 65536 {
        return Err("钥匙串内容过大".into());
    }
    keyring::Entry::new("com.isle.space-desktop", &scope)
        .map_err(|_| "无法访问系统钥匙串")?
        .set_password(&value)
        .map_err(|_| "无法保存到系统钥匙串".into())
}

#[tauri::command]
fn vault_delete(scope: String) -> Result<(), String> {
    validate_scope(&scope)?;
    let entry =
        keyring::Entry::new("com.isle.space-desktop", &scope).map_err(|_| "无法访问系统钥匙串")?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("无法清除本客户端的登录记录".into()),
    }
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    validate_external(&url)?;
    open::that(url).map_err(|_| "无法打开系统浏览器".into())
}

fn start_gateway(app: &tauri::AppHandle) -> Result<(), String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|_| "客户端数据目录不可用")?;
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|_| "客户端配置目录不可用")?;
    std::fs::create_dir_all(&data).map_err(|_| "无法创建客户端数据目录")?;
    let config = match std::fs::read(config_dir.join("gateway.json")) {
        Ok(bytes) => serde_json::from_slice::<GatewayConfig>(&bytes).map_err(|_| "网关配置无效")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => GatewayConfig::default(),
        Err(_) => return Err("无法读取网关配置".into()),
    };
    let engine = config.engine.as_deref().unwrap_or("disabled");
    if !["disabled", "local", "sshbind"].contains(&engine) {
        return Err("网关引擎配置无效".into());
    }
    let mut path = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = std::env::split_paths(&path).collect::<Vec<_>>();
    if let Some(home) = std::env::var_os("HOME") {
        paths.push(std::path::PathBuf::from(home).join(".local/bin"));
    }
    paths.push("/opt/homebrew/bin".into());
    paths.push("/usr/local/bin".into());
    if let Ok(joined) = std::env::join_paths(paths) {
        path = joined;
    }
    let command = app
        .shell()
        .sidecar("space-gateway")
        .map_err(|_| "安装包缺少网关程序")?
        .args([
            "--listen",
            "127.0.0.1:0",
            "--data-dir",
            &data.to_string_lossy(),
            "--engine",
            engine,
            "--ssh-alias",
            config.ssh_alias.as_deref().unwrap_or(""),
            "--storage-root",
            config.storage_root.as_deref().unwrap_or(""),
        ])
        .env("PATH", path);
    let (mut events, child) = command.spawn().map_err(|_| "无法启动本地网关程序")?;
    *app.state::<GatewayState>()
        .child
        .lock()
        .map_err(|_| "服务状态不可用")? = Some(child);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let result = parse_ready(&String::from_utf8_lossy(&bytes)).map(|r| r.address);
                    *handle.state::<GatewayState>().ready.lock().unwrap() = Some(result);
                }
                CommandEvent::Error(_) | CommandEvent::Terminated(_) => {
                    *handle.state::<GatewayState>().ready.lock().unwrap() =
                        Some(Err("本地服务已停止，请重新打开客户端".into()));
                    break;
                }
                _ => {} // No raw stderr forwarded to the frontend or logs.
            }
        }
    });
    Ok(())
}

/**
 * 自定义 macOS 菜单。
 *
 * 为什么必须自定义：Tauri 的默认菜单里有 `File → Close Window`（⌘W），
 * 而 macOS 上**菜单快捷键优先于网页里的 keydown** —— 于是应用内"⌘W 关闭最前窗口"
 * 永远不会触发，按下去直接关掉**整个应用窗口**（桌面连同会话一起消失）。
 * 默认的 Window 菜单里还有 Minimize(⌘M)，同样会抢走应用内的最小化。
 *
 * 这里保留三样必需的东西，去掉会与应用内快捷键打架的项：
 *   - 应用菜单：关于 / 服务 / 隐藏 / 退出(⌘Q)
 *   - **编辑菜单：撤销/重做/剪切/复制/粘贴/全选** —— macOS 上文本框的
 *     ⌘C/⌘V 依赖菜单项存在，删掉它输入框就不能复制粘贴了；
 *   - 显示菜单：全屏(⌃⌘F)。
 * 窗口的关闭/最小化交给应用自己管（⌘W/⌘M 因此能落到网页里）。
 */
fn desktop_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    let about = AboutMetadataBuilder::new()
        .name(Some("空间桌面"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .build();
    let app_menu = SubmenuBuilder::new(app, "空间桌面")
        .about(Some(about))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view_menu = SubmenuBuilder::new(app, "显示").fullscreen().build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &view_menu])
        .build()
}

pub fn run() {
    let app = media::attach(tauri::Builder::default())
        .menu(desktop_menu)
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(download::DownloadState::default())
        .manage(upload_source::UploadSourceState::default())
        .manage(upload_hash::UploadHashState::default())
        .manage(GatewayState::default())
        .invoke_handler(tauri::generate_handler![
            media::nas_media_register,
            media::nas_media_clear,
            download::nas_download_register,
            download::nas_download_start,
            download::nas_download_cancel,
            download::nas_download_tasks,
            upload_source::nas_upload_pick,
            upload_source::nas_upload_read,
            upload_source::nas_upload_release,
            upload_hash::nas_upload_hash,
            upload_hash::nas_upload_hash_cancel,
            gateway_address,
            vault_read,
            vault_write,
            vault_delete,
            open_external
        ])
        .build(tauri::generate_context!())
        .expect("Unable to initialize desktop runtime");
    let uploads = app
        .state::<upload_source::UploadSourceState>()
        .inner()
        .clone();
    uploads.attach(&app.state::<media::MediaState>());
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            uploads.prune_at(std::time::Instant::now());
        }
    });
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            handle
                .state::<upload_source::UploadSourceState>()
                .clear_all();
            if let Some(child) = handle.state::<GatewayState>().child.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
    });
}
