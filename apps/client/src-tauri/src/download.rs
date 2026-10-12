//! Download-only capabilities; never exposed through the renderer media scheme.
#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        path::Path,
    };
    fn server(status: &str, headers: &str, bytes: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let status = status.to_owned();
        let headers = headers.to_owned();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                .unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nConnection: close\r\n{headers}\r\n"
            );
            let _ = stream.write_all(&bytes);
        });
        base
    }
    fn source(base: &str) -> String {
        format!("{base}/v2/file/download?path=%2Fsynthetic%2Fa&webagent=v2&request_purpose=5&show_hidden=0")
    }
    fn state_ref(
        base: &str,
        size: Option<u64>,
    ) -> (DownloadState, crate::media::MediaState, String) {
        let downloads = DownloadState::default();
        let media = crate::media::MediaState::default();
        let id = downloads
            .register(
                &media,
                base,
                &source(base),
                "device_id=synthetic; zenithtoken=synthetic",
                "test-session",
                "a",
                size,
            )
            .unwrap();
        (downloads, media, id)
    }
    fn pinned(path: &Path) -> Destination {
        Destination::pin(path).unwrap()
    }
    #[test]
    fn windows_destination_names_cannot_target_streams_or_device_aliases() {
        for name in [
            "report.txt:stream",
            "report.txt::$DATA",
            "C:report.txt",
            "CON",
            "con.txt",
            "NUL",
            "aux.pdf",
            "PRN.txt",
            "COM1",
            "COM9.txt",
            "LPT1",
            "LPT9.png",
            "COM¹.txt",
            "LPT²",
            "CONIN$",
            "CONOUT$.txt",
            "CLOCK$",
            "con .txt",
            "report.",
            "report ",
            "\\\\?\\C:\\report",
            "a/b",
            "a\\b",
            "bad?name",
            ".",
            "..",
        ] {
            assert!(!windows_destination_name(name), "accepted {name}");
        }
        for name in [
            "report.txt",
            "新文件.json",
            "my new report.txt",
            "a;b=1.txt",
            "COM10.txt",
            "auxiliary.txt",
            "con-name.txt",
        ] {
            assert!(windows_destination_name(name), "rejected {name}");
        }
    }
    #[test]
    fn existing_regular_empty_and_symlink_are_unchanged() {
        let temp = tempfile::tempdir().unwrap();
        for bytes in [vec![], b"existing user data".to_vec()] {
            let name = if bytes.is_empty() { "empty" } else { "regular" };
            let path = temp.path().join(name);
            std::fs::write(&path, &bytes).unwrap();
            assert!(pinned(&path).create().is_err());
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        }
        #[cfg(unix)]
        {
            let target = temp.path().join("regular");
            let link = temp.path().join("link");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            assert!(pinned(&link).create().is_err());
            assert_eq!(std::fs::read(target).unwrap(), b"existing user data");
            assert!(std::fs::symlink_metadata(link)
                .unwrap()
                .file_type()
                .is_symlink());
        }
    }
    #[test]
    fn parent_replacement_does_not_redirect_the_write() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("parent");
        std::fs::create_dir(&parent).unwrap();
        let destination = pinned(&parent.join("a"));
        std::fs::rename(&parent, temp.path().join("original")).unwrap();
        std::fs::create_dir(&parent).unwrap();
        let mut file = destination.create().unwrap();
        file.write_all(b"new bytes").unwrap();
        assert!(!parent.join("a").exists());
        assert_eq!(
            std::fs::read(temp.path().join("original/a")).unwrap(),
            b"new bytes"
        );
    }
    #[test]
    fn duplicate_start_and_closed_session_cannot_choose_or_write() {
        let (state, media, id) = state_ref("http://127.0.0.1:1", None);
        let task = state.reserve(&id).unwrap();
        assert!(state.reserve(&id).is_err());
        media.clear("test-session").unwrap();
        assert!(!task.active());
        assert!(state.reserve(&id).is_err());
    }
    #[test]
    fn download_only_session_survives_unrelated_media_purge() {
        let (state, media, id) = state_ref("http://127.0.0.1:1", None);
        let _ = media
            .register(
                "http://127.0.0.1:1",
                "/transcode/thumb?file_path=%2Fa.jpg",
                "device_id=synthetic; zenithtoken=synthetic",
                "another-session",
            )
            .unwrap();
        assert!(state.reserve(&id).unwrap().active());
    }
    #[test]
    fn running_task_lease_survives_reference_expiry_and_media_purge() {
        let (state, media, id) = state_ref("http://127.0.0.1:1", None);
        let mut task = state.reserve(&id).unwrap();
        Arc::get_mut(&mut task.reference).unwrap().expires =
            Instant::now() - Duration::from_secs(1);
        media
            .register(
                "http://127.0.0.1:1",
                "/transcode/thumb?file_path=%2Fa.jpg",
                "device_id=synthetic; zenithtoken=synthetic",
                "other-session",
            )
            .unwrap();
        assert!(task.active());
        media.clear("test-session").unwrap();
        assert!(!task.active());
    }
    #[test]
    fn exact_download_routes_and_media_isolation() {
        let (state, media, _) = state_ref("http://127.0.0.1:1", None);
        for url in [
            "/v2/file/download",
            "/v2/file/download?path=%2Fa&webagent=v2&request_purpose=5&show_hidden=0&path=%2Fb",
            "/v2/file/zipstream?path=%2Fa",
            "http://wrong.test/v2/file/download?path=%2Fa",
        ] {
            assert!(state
                .register(
                    &media,
                    "http://127.0.0.1:1",
                    url,
                    "device_id=synthetic; zenithtoken=synthetic",
                    "test-session",
                    "a",
                    None
                )
                .is_err());
        }
    }
    #[test]
    fn complete_large_file_and_legal_nonmedia_files_are_saved() {
        tauri::async_runtime::block_on(async {
            for (mime, bytes) in [
                ("video/mp4", vec![0x59; (8 << 20) + 123]),
                ("application/json", b"{\"legal\":true}".to_vec()),
                ("image/svg+xml", b"<svg/>".to_vec()),
                ("text/plain", b"ordinary text".to_vec()),
                ("text/html", b"<html>saved file</html>".to_vec()),
                ("application/octet-stream", vec![]),
            ] {
                let base = server("200 OK", &format!("Content-Disposition: attachment; filename=\"a\"\r\nContent-Type: {mime}\r\nContent-Length: {}\r\n", bytes.len()), bytes.clone());
                let (state, media, id) = state_ref(&base, Some(bytes.len() as u64));
                let task = state.reserve(&id).unwrap();
                let temp = tempfile::tempdir().unwrap();
                let path = temp.path().join("a");
                state
                    .run(&media, task.clone(), Some(pinned(&path)), |_| {})
                    .await;
                assert_eq!(state.tasks("test-session").unwrap()[0].status, "completed");
                assert_eq!(std::fs::read(path).unwrap(), bytes);
            }
        });
    }
    #[test]
    fn size_range_identity_redirect_and_auth_fail_closed() {
        tauri::async_runtime::block_on(async {
            for (status, extra, expected) in [
                ("200 OK", "Content-Length: 3\r\n", Some(4)),
                (
                    "206 Partial Content",
                    "Content-Length: 3\r\nContent-Range: bytes 0-2/6\r\n",
                    None,
                ),
                (
                    "200 OK",
                    "Content-Length: 3\r\nContent-Type: application/json\r\n",
                    None,
                ),
                (
                    "302 Found",
                    "Location: http://wrong.test/secret\r\nContent-Length: 3\r\n",
                    None,
                ),
                ("401 Unauthorized", "Content-Length: 3\r\n", None),
            ] {
                let identity = if extra.contains("application/json") {
                    ""
                } else {
                    "Content-Disposition: attachment; filename=\"a\"\r\n"
                };
                let base = server(status, &format!("{identity}{extra}"), b"abc".to_vec());
                let (state, media, id) = state_ref(&base, expected);
                let task = state.reserve(&id).unwrap();
                let temp = tempfile::tempdir().unwrap();
                let path = temp.path().join("a");
                state.run(&media, task, Some(pinned(&path)), |_| {}).await;
                let result = state.tasks("test-session").unwrap().pop().unwrap();
                assert_ne!(result.status, "completed");
                assert!(!serde_json::to_string(&result).unwrap().contains(&base));
                if status.starts_with("401") {
                    assert!(state
                        .register(
                            &media,
                            &base,
                            &source(&base),
                            "device_id=synthetic; zenithtoken=synthetic",
                            "test-session",
                            "a",
                            None
                        )
                        .is_err());
                }
            }
        });
    }
    #[test]
    fn dialog_cancel_and_old_delayed_dialog_make_no_file() {
        tauri::async_runtime::block_on(async {
            let (state, media, id) = state_ref("http://127.0.0.1:1", None);
            let task = state.reserve(&id).unwrap();
            state.run(&media, task, None, |_| {}).await;
            assert_eq!(state.tasks("test-session").unwrap()[0].status, "cancelled");
            let (state, media, id) = state_ref("http://127.0.0.1:1", None);
            let task = state.reserve(&id).unwrap();
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("a");
            media.clear("test-session").unwrap();
            state.run(&media, task, Some(pinned(&path)), |_| {}).await;
            assert!(!path.exists());
            assert_eq!(state.tasks("test-session").unwrap()[0].status, "cancelled");
        });
    }
    #[test]
    fn response_filename_identity_must_match_actual_file() {
        tauri::async_runtime::block_on(async {
            for disposition in [
                "attachment; filename=\"wrong\"",
                "attachment; filename=\"../a\"",
                "attachment; filename=\"\"",
                "attachment; xfilename=\"a\"",
                "attachment; filename=\"a\"; filename=\"wrong\"",
                "attachment; filename*=UTF-8''%ZZ",
            ] {
                let base = server(
                    "200 OK",
                    &format!("Content-Disposition: {disposition}\r\nContent-Length: 3\r\n"),
                    b"abc".to_vec(),
                );
                let (state, media, id) = state_ref(&base, None);
                let task = state.reserve(&id).unwrap();
                let temp = tempfile::tempdir().unwrap();
                let path = temp.path().join("a");
                state.run(&media, task, Some(pinned(&path)), |_| {}).await;
                assert_eq!(
                    state.tasks("test-session").unwrap()[0].status,
                    "failed",
                    "accepted {disposition}"
                );
                assert!(!path.exists());
            }
        });
    }
    #[test]
    fn complete_whole_range_is_saved_and_truncated_fresh_partial_is_retained() {
        tauri::async_runtime::block_on(async {
            for (status, headers, expected_status) in [
                (
                    "206 Partial Content",
                    "Content-Range: bytes 0-2/3\r\nContent-Length: 3\r\n",
                    "completed",
                ),
                ("200 OK", "Content-Length: 6\r\n", "failed"),
            ] {
                let base = server(
                    status,
                    &format!("Content-Disposition: attachment; filename*=UTF-8''a\r\n{headers}"),
                    b"abc".to_vec(),
                );
                let (state, media, id) = state_ref(&base, None);
                let task = state.reserve(&id).unwrap();
                let temp = tempfile::tempdir().unwrap();
                let path = temp.path().join("a");
                state.run(&media, task, Some(pinned(&path)), |_| {}).await;
                let result = &state.tasks("test-session").unwrap()[0];
                assert_eq!(result.status, expected_status);
                assert_eq!(std::fs::read(path).unwrap(), b"abc");
                if expected_status == "failed" {
                    assert_eq!(result.retained_partial, Some(true));
                    assert_eq!(result.received, 3);
                }
            }
        });
    }
    fn stalled_server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            let _=stream.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Disposition: attachment; filename=\"a\"\r\nContent-Length: 6\r\n\r\nabc");
            std::thread::sleep(std::time::Duration::from_secs(2));
        });
        base
    }
    #[test]
    fn explicit_cancel_logout_and_inactivity_retain_only_fresh_incomplete_output() {
        tauri::async_runtime::block_on(async {
            for cause in ["cancel", "logout", "timeout"] {
                let base = stalled_server();
                let (state, media, id) = state_ref(&base, Some(6));
                let task = state.reserve(&id).unwrap();
                let task_id = task.id.clone();
                if cause == "timeout" {
                    state
                        .client
                        .set(Ok(Client::builder()
                            .redirect(reqwest::redirect::Policy::none())
                            .read_timeout(Duration::from_millis(80))
                            .build()
                            .unwrap()))
                        .unwrap();
                }
                let temp = tempfile::tempdir().unwrap();
                let path = temp.path().join("a");
                let destination = pinned(&path);
                let cloned = state.clone();
                let authority = media.clone();
                let run = tauri::async_runtime::spawn(async move {
                    cloned
                        .run(&authority, task, Some(destination), |_| {})
                        .await;
                });
                if cause != "timeout" {
                    for _ in 0..100 {
                        if std::fs::metadata(&path).is_ok_and(|m| m.len() == 3) {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    assert_eq!(std::fs::read(&path).unwrap(), b"abc");
                    if cause == "cancel" {
                        state.cancel(&task_id).unwrap();
                    } else {
                        media.clear("test-session").unwrap();
                    }
                }
                run.await.unwrap();
                let result = &state.tasks("test-session").unwrap()[0];
                assert_eq!(
                    result.status,
                    if cause == "timeout" {
                        "failed"
                    } else {
                        "cancelled"
                    }
                );
                assert_eq!(result.retained_partial, Some(true));
                assert_eq!(result.received, 3);
                assert_eq!(std::fs::read(path).unwrap(), b"abc");
            }
        });
    }
}

use crate::media::{DownloadLease, MediaState};
use cap_std::fs::{Dir, OpenOptions};
use serde::Serialize;
use std::{
    collections::HashMap,
    ffi::OsString,
    future::{poll_fn, Future},
    io::Write,
    path::{Component, Path},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    task::Poll,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_http::reqwest::{self, Client, Url};
const LIMIT: usize = 4096;
const ACTIVE_LIMIT: usize = 4;
const TTL: Duration = Duration::from_secs(8 * 60 * 60);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTransfer {
    id: String,
    session_id: String,
    name: String,
    received: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retained_partial: Option<bool>,
}
struct FileRef {
    source: Url,
    session_id: String,
    name: String,
    size: Option<u64>,
    lease: DownloadLease,
    expires: Instant,
}
#[derive(Clone)]
struct Task {
    reference: Arc<FileRef>,
    cancelled: Arc<AtomicBool>,
    id: String,
}
impl Task {
    fn active(&self) -> bool {
        !self.cancelled.load(Ordering::Acquire)
            && !self
                .reference
                .lease
                .session
                .cancelled
                .load(Ordering::Acquire)
    }
}
struct TaskEntry {
    progress: FileTransfer,
    cancelled: Arc<AtomicBool>,
}
#[derive(Default)]
struct Registry {
    refs: HashMap<String, Arc<FileRef>>,
    tasks: HashMap<String, TaskEntry>,
}
#[derive(Clone, Default)]
pub struct DownloadState {
    registry: Arc<Mutex<Registry>>,
    client: Arc<OnceLock<Result<Client, &'static str>>>,
}
fn opaque_id() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "无法创建文件下载引用")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn valid_id(value: &str) -> Result<(), String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Err("文件下载引用无效".into())
    } else {
        Ok(())
    }
}
fn safe_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && ![".", ".."].contains(&value)
        && !value
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
}
fn guarded_source(base: &str, source: &str) -> Result<Url, String> {
    if base.len() > 2048 || source.len() > 32768 || source.bytes().any(|b| b <= 0x20 || b == 0x7f) {
        return Err("文件下载地址无效".into());
    }
    let base = Url::parse(base).map_err(|_| "NAS 地址无效")?;
    if !matches!(base.scheme(), "http" | "https")
        || base.host_str().is_none()
        || !base.username().is_empty()
        || base.password().is_some()
        || base.path() != "/"
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err("NAS 地址无效".into());
    }
    let source = base.join(source).map_err(|_| "文件下载地址无效")?;
    if source.origin() != base.origin()
        || !source.username().is_empty()
        || source.password().is_some()
        || source.fragment().is_some()
        || !["/v2/file/download", "/v2/file/decrypt/download"].contains(&source.path())
    {
        return Err("文件下载地址不属于当前 NAS 单文件入口".into());
    }
    let mut params = HashMap::new();
    for (key, value) in source.query_pairs() {
        if params.insert(key.to_string(), value.to_string()).is_some() {
            return Err("文件下载参数无效".into());
        }
    }
    let identity = if source.path() == "/v2/file/download" {
        params.get("path").is_some_and(|p| {
            p.starts_with('/') && !p.starts_with("//") && !p.chars().any(char::is_control)
        }) && !params.contains_key("encrypted_path")
            && !params.contains_key("from")
    } else {
        params
            .get("encrypted_path")
            .is_some_and(|p| !p.is_empty() && !p.chars().any(char::is_control))
            && params.get("from").is_some_and(|p| {
                !p.is_empty() && p.len() <= 128 && !p.chars().any(char::is_control)
            })
            && !params.contains_key("path")
    };
    let allowed = [
        "path",
        "encrypted_path",
        "from",
        "webagent",
        "request_purpose",
        "show_hidden",
        "plat",
        "version",
        "device_id",
        "device",
        "_l",
        "rnd",
        "token",
        "nasid",
    ];
    if !identity
        || params.get("webagent").map(String::as_str) != Some("v2")
        || params.get("request_purpose").map(String::as_str) != Some("5")
        || !matches!(
            params.get("show_hidden").map(String::as_str),
            Some("0" | "1")
        )
        || params.keys().any(|key| !allowed.contains(&key.as_str()))
    {
        return Err("文件下载参数无效".into());
    }
    Ok(source)
}
impl DownloadState {
    pub(crate) fn register(
        &self,
        media: &MediaState,
        base: &str,
        source: &str,
        cookie: &str,
        session_id: &str,
        name: &str,
        size: Option<u64>,
    ) -> Result<String, String> {
        let source = guarded_source(base, source)?;
        if !safe_name(name)
            || size.is_some_and(|s| s > 9_007_199_254_740_991)
            || crate::media::guarded_cookie(cookie)?
                .iter()
                .any(|secret| name.contains(secret))
            || source.query_pairs().any(|(key, value)| {
                ["token", "nasid"].contains(&key.as_ref())
                    && !value.is_empty()
                    && name.contains(value.as_ref())
            })
        {
            return Err("NAS 文件身份无效".into());
        }
        let mut registry = self.registry.lock().map_err(|_| "文件下载状态不可用")?;
        registry.refs.retain(|_, value| {
            value.expires > Instant::now() && !value.lease.session.cancelled.load(Ordering::Acquire)
        });
        if registry.refs.len() >= LIMIT {
            return Err("文件下载引用已达上限".into());
        }
        let lease = media.download_session(base, cookie, session_id)?;
        let id = opaque_id()?;
        registry.refs.insert(
            id.clone(),
            Arc::new(FileRef {
                source,
                session_id: session_id.to_owned(),
                name: name.to_owned(),
                size,
                lease,
                expires: Instant::now() + TTL,
            }),
        );
        Ok(id)
    }
    fn reserve(&self, id: &str) -> Result<Task, String> {
        valid_id(id)?;
        let mut registry = self.registry.lock().map_err(|_| "文件下载状态不可用")?;
        if registry
            .tasks
            .values()
            .filter(|t| matches!(t.progress.status.as_str(), "choosing" | "running"))
            .count()
            >= ACTIVE_LIMIT
        {
            return Err("同时下载任务已达上限".into());
        }
        let reference = registry.refs.remove(id).ok_or("文件下载引用已使用或失效")?;
        if reference.expires <= Instant::now()
            || reference.lease.session.cancelled.load(Ordering::Acquire)
        {
            return Err("NAS 会话已结束，请重新登录".into());
        }
        if registry.tasks.len() >= LIMIT {
            registry
                .tasks
                .retain(|_, t| matches!(t.progress.status.as_str(), "choosing" | "running"));
        }
        let task = Task {
            id: opaque_id()?,
            reference,
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        let progress = FileTransfer {
            id: task.id.clone(),
            session_id: task.reference.session_id.clone(),
            name: task.reference.name.clone(),
            received: 0,
            total: task.reference.size,
            status: "choosing".into(),
            message: None,
            retained_partial: None,
        };
        registry.tasks.insert(
            task.id.clone(),
            TaskEntry {
                progress,
                cancelled: task.cancelled.clone(),
            },
        );
        Ok(task)
    }
    fn tasks(&self, session_id: &str) -> Result<Vec<FileTransfer>, String> {
        crate::media::valid_session_id(session_id)?;
        let registry = self.registry.lock().map_err(|_| "文件下载状态不可用")?;
        let mut tasks = registry
            .tasks
            .values()
            .filter(|t| t.progress.session_id == session_id)
            .map(|t| t.progress.clone())
            .collect::<Vec<_>>();
        tasks.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(tasks)
    }
    fn cancel(&self, id: &str) -> Result<(), String> {
        valid_id(id)?;
        let registry = self.registry.lock().map_err(|_| "文件下载状态不可用")?;
        let task = registry.tasks.get(id).ok_or("文件下载任务不存在")?;
        task.cancelled.store(true, Ordering::Release);
        Ok(())
    }
    fn update(
        &self,
        task: &Task,
        status: &str,
        received: u64,
        total: Option<u64>,
        message: Option<&'static str>,
        retained_partial: Option<bool>,
        emit: &impl Fn(FileTransfer),
    ) {
        let progress = self.registry.lock().ok().and_then(|mut registry| {
            registry.tasks.get_mut(&task.id).map(|entry| {
                entry.progress.status = status.to_owned();
                entry.progress.received = received;
                entry.progress.total = total;
                entry.progress.message = message;
                entry.progress.retained_partial = retained_partial;
                entry.progress.clone()
            })
        });
        if let Some(progress) = progress {
            emit(progress);
        }
    }
    async fn run(
        &self,
        media: &MediaState,
        task: Task,
        destination: Option<Destination>,
        emit: impl Fn(FileTransfer),
    ) {
        let mut received = 0;
        let mut total = task.reference.size;
        let mut created = false;
        let result = self
            .transfer(
                media,
                &task,
                destination,
                &mut received,
                &mut total,
                &mut created,
                &emit,
            )
            .await;
        match result {
            Ok(()) => self.update(&task, "completed", received, total, None, None, &emit),
            Err(message) => {
                let cancelled = !task.active() || message == "未选择保存位置";
                self.update(
                    &task,
                    if cancelled { "cancelled" } else { "failed" },
                    received,
                    total,
                    Some(message),
                    if created { Some(true) } else { None },
                    &emit,
                );
            }
        }
    }
    async fn transfer(
        &self,
        media: &MediaState,
        task: &Task,
        destination: Option<Destination>,
        received: &mut u64,
        total: &mut Option<u64>,
        created: &mut bool,
        emit: &impl Fn(FileTransfer),
    ) -> Result<(), &'static str> {
        if !task.active() {
            return Err("NAS 会话或下载任务已结束");
        }
        let destination = destination.ok_or("未选择保存位置")?;
        let client = self
            .client
            .get_or_init(|| {
                Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .connect_timeout(Duration::from_secs(15))
                    .read_timeout(Duration::from_secs(30))
                    .referer(false)
                    .no_gzip()
                    .no_brotli()
                    .no_deflate()
                    .no_zstd()
                    .build()
                    .map_err(|_| "下载网络初始化失败")
            })
            .as_ref()
            .map_err(|e| *e)?;
        let mut response = active_await(
            client
                .get(task.reference.source.clone())
                .header("Cookie", &task.reference.lease.session.cookie)
                .header("Accept-Encoding", "identity")
                .send(),
            task,
        )
        .await?;
        let status = response.status().as_u16();
        if status == 401 || status == 403 {
            media.expire_auth(&task.reference.session_id);
            return Err("NAS 登录已失效，请重新登录");
        }
        if status != 200 && status != 206 {
            return Err("NAS 未提供有效单文件响应");
        }
        let lengths = response_lengths(response.headers(), status, &task.reference.name)?;
        if task
            .reference
            .size
            .is_some_and(|s| lengths.iter().any(|length| *length != s))
        {
            return Err("NAS 文件大小与返回身份不匹配");
        }
        *total = task.reference.size.or_else(|| lengths.first().copied());
        if !task.active() {
            return Err("NAS 会话或下载任务已结束");
        }
        let mut file = destination
            .create()
            .map_err(|_| "保存位置已存在或无法创建新文件，请选择新名称")?;
        *created = true;
        self.update(task, "running", 0, *total, None, None, emit);
        let mut last_emit = Instant::now();
        while let Some(chunk) = active_await(response.chunk(), task).await? {
            // reqwest's chunks are reused; no complete file or media-sized buffer.
            for bytes in chunk.chunks(64 << 10) {
                if !task.active() {
                    return Err("NAS 会话或下载任务已结束");
                }
                let next = received
                    .checked_add(bytes.len() as u64)
                    .ok_or("文件下载大小超出范围")?;
                if total.is_some_and(|size| next > size) {
                    return Err("NAS 文件大小不匹配，下载未完成");
                }
                file.write_all(bytes)
                    .map_err(|_| "无法写入保存位置，已保留未完成文件")?;
                *received = next;
            }
            if last_emit.elapsed() >= Duration::from_millis(100) {
                self.update(task, "running", *received, *total, None, None, emit);
                last_emit = Instant::now();
            }
        }
        if !task.active() {
            return Err("NAS 会话或下载任务已结束");
        }
        if total.is_some_and(|size| size != *received)
            || lengths.iter().any(|size| *size != *received)
        {
            return Err("文件下载不完整，已保留未完成文件");
        }
        file.flush().map_err(|_| "无法完成保存，已保留未完成文件")?;
        file.sync_all()
            .map_err(|_| "无法完成保存，已保留未完成文件")?;
        if !task.active() {
            return Err("NAS 会话或下载任务已结束");
        }
        Ok(())
    }
}
fn download_filename(header: &str) -> Option<String> {
    if header.len() > 4096 || header.chars().any(char::is_control) {
        return None;
    }
    let end = header.find(';').unwrap_or(header.len());
    if !header[..end].trim().eq_ignore_ascii_case("attachment") {
        return None;
    }
    let mut rest = &header[end..];
    if !rest.trim().is_empty() && !rest.trim_start().starts_with(';') {
        return None;
    }
    static PARAMETER: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = PARAMETER.get_or_init(|| regex::Regex::new(r#"^\s*;\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*("(?:[^"\\\r\n]|\\[^\r\n])*"|[^\s;"]+)\s*"#).expect("static header pattern"));
    let mut parameters = HashMap::new();
    while !rest.trim().is_empty() {
        let captures = pattern.captures(rest)?;
        let key = captures.get(1)?.as_str().to_ascii_lowercase();
        let raw = captures.get(2)?.as_str();
        let value = if raw.starts_with('"') {
            let mut value = String::new();
            let mut chars = raw[1..raw.len() - 1].chars();
            while let Some(c) = chars.next() {
                value.push(if c == '\\' { chars.next()? } else { c });
            }
            value
        } else {
            raw.to_owned()
        };
        if parameters.insert(key, value).is_some() {
            return None;
        }
        rest = &rest[captures.get(0)?.end()..];
    }
    let name = if let Some(encoded) = parameters.get("filename*") {
        let mut components = encoded.splitn(3, '\'');
        if !components.next()?.eq_ignore_ascii_case("UTF-8") {
            return None;
        }
        components.next()?;
        let value = components.next()?;
        for (index, byte) in value.bytes().enumerate() {
            if byte == b'%'
                && !value
                    .as_bytes()
                    .get(index + 1..index + 3)
                    .is_some_and(|hex| hex.iter().all(u8::is_ascii_hexdigit))
            {
                return None;
            }
        }
        percent_encoding::percent_decode_str(value)
            .decode_utf8()
            .ok()?
            .into_owned()
    } else {
        parameters.remove("filename")?
    };
    safe_name(&name).then_some(name)
}
fn response_lengths(
    headers: &reqwest::header::HeaderMap,
    status: u16,
    name: &str,
) -> Result<Vec<u64>, &'static str> {
    // This assumption is intentionally pending live NAS verification. Reject
    // unlabelled success JSON/login pages while allowing actual JSON/SVG files.
    if headers.get_all("Content-Disposition").iter().count() != 1
        || headers.get_all("Content-Length").iter().count() > 1
        || headers.get_all("Content-Range").iter().count() > 1
    {
        return Err("NAS 文件响应头含糊不清");
    }
    let disposition = headers
        .get("Content-Disposition")
        .and_then(|v| v.to_str().ok())
        .ok_or("NAS 未返回可验证的下载文件身份")?;
    if download_filename(disposition).as_deref() != Some(name) {
        return Err("NAS 未返回匹配的下载文件身份");
    }
    if headers
        .get("Content-Encoding")
        .is_some_and(|v| v != "identity")
    {
        return Err("NAS 返回了不受支持的文件编码");
    }
    let mut lengths = Vec::new();
    if let Some(value) = headers.get("Content-Length") {
        let raw = value.to_str().map_err(|_| "NAS 文件长度无效")?;
        if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
            return Err("NAS 文件长度无效");
        }
        lengths.push(raw.parse::<u64>().map_err(|_| "NAS 文件长度无效")?);
    }
    if status == 206 {
        let range = headers
            .get("Content-Range")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("bytes 0-"))
            .and_then(|v| v.split_once('/'))
            .ok_or("NAS 未提供完整文件范围")?;
        if !range.0.bytes().all(|b| b.is_ascii_digit())
            || !range.1.bytes().all(|b| b.is_ascii_digit())
        {
            return Err("NAS 文件范围无效");
        }
        let last = range.0.parse::<u64>().map_err(|_| "NAS 文件范围无效")?;
        let size = range.1.parse::<u64>().map_err(|_| "NAS 文件范围无效")?;
        if size == 0
            || last.checked_add(1) != Some(size)
            || lengths.iter().any(|length| *length != size)
        {
            return Err("NAS 未提供完整文件范围");
        }
        lengths.push(size);
    } else if headers.contains_key("Content-Range") {
        return Err("NAS 文件范围无效");
    }
    Ok(lengths)
}
async fn active_await<T>(
    future: impl Future<Output = Result<T, reqwest::Error>>,
    task: &Task,
) -> Result<T, &'static str> {
    let mut future = std::pin::pin!(future);
    let mut interval = tokio::time::interval(Duration::from_millis(50));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    poll_fn(|context| {
        if !task.active() {
            return Poll::Ready(Err("NAS 会话或下载任务已结束"));
        }
        if let Poll::Ready(result) = future.as_mut().poll(context) {
            return Poll::Ready(result.map_err(|_| "下载连接中断，文件未完成"));
        }
        while interval.poll_tick(context).is_ready() {}
        Poll::Pending
    })
    .await
}
#[cfg(any(target_os = "windows", test))]
fn windows_destination_name(name: &str) -> bool {
    // Win32 may interpret these names as device aliases or NTFS streams even
    // with CREATE_NEW. Reject aliases before opening any selected destination.
    if name.is_empty()
        || name.encode_utf16().count() > 255
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return false;
    }
    let base = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"].contains(&base.as_str()) {
        return false;
    }
    for prefix in ["COM", "LPT"] {
        if let Some(suffix) = base.strip_prefix(prefix) {
            if ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"].contains(&suffix) {
                return false;
            }
        }
    }
    true
}
struct Destination {
    parent: Dir,
    name: OsString,
}
impl Destination {
    fn pin(path: &Path) -> Result<Self, String> {
        if !path.is_absolute() {
            return Err("系统保存位置无效".into());
        }
        let name = path.file_name().ok_or("系统保存文件名无效")?;
        #[cfg(target_os = "windows")]
        {
            if !name.to_str().is_some_and(windows_destination_name) || path.components().next().is_some_and(|component| matches!(component,
                Component::Prefix(prefix) if matches!(prefix.kind(), std::path::Prefix::DeviceNS(_) | std::path::Prefix::Verbatim(_)))) {
                return Err("系统保存文件名包含不受支持的 Windows 别名".into());
            }
        }
        if Path::new(name).components().count() != 1
            || !matches!(
                Path::new(name).components().next(),
                Some(Component::Normal(_))
            )
        {
            return Err("系统保存文件名无效".into());
        }
        let parent = Dir::open_ambient_dir(
            path.parent().ok_or("系统保存位置无效")?,
            cap_std::ambient_authority(),
        )
        .map_err(|_| "无法访问系统选择的保存目录")?;
        Ok(Self {
            parent,
            name: name.to_owned(),
        })
    }
    fn create(&self) -> Result<std::fs::File, String> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        self.parent
            .open_with(Path::new(&self.name), &options)
            .map(|file| file.into_std())
            .map_err(|_| "只能保存为新文件，已有文件保持不变".into())
    }
}
#[tauri::command]
pub fn nas_download_register(
    base_url: String,
    source_url: String,
    cookie: String,
    session_id: String,
    name: String,
    size: Option<u64>,
    state: tauri::State<'_, DownloadState>,
    media: tauri::State<'_, MediaState>,
) -> Result<String, String> {
    state.register(
        &media,
        &base_url,
        &source_url,
        &cookie,
        &session_id,
        &name,
        size,
    )
}
#[tauri::command]
pub fn nas_download_tasks(
    session_id: String,
    state: tauri::State<'_, DownloadState>,
) -> Result<Vec<FileTransfer>, String> {
    state.tasks(&session_id)
}
#[tauri::command]
pub fn nas_download_cancel(
    task_id: String,
    state: tauri::State<'_, DownloadState>,
) -> Result<(), String> {
    state.cancel(&task_id)
}
#[tauri::command]
pub fn nas_download_start(
    reference: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, DownloadState>,
) -> Result<FileTransfer, String> {
    let task = state.reserve(&reference)?;
    let progress = state
        .tasks(&task.reference.session_id)?
        .into_iter()
        .find(|p| p.id == task.id)
        .ok_or("文件下载任务不存在")?;
    let _ = app.emit("nas-download-progress", &progress);
    let downloads = state.inner().clone();
    let handle = app.clone();
    let (send, recv) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&task.reference.name)
        .save_file(move |path| {
            // Pin directory authority immediately at the native callback boundary.
            let destination = path.map(|path| {
                path.into_path()
                    .map_err(|_| "系统保存位置无效".to_string())
                    .and_then(|path| Destination::pin(&path))
            });
            let _ = send.send(destination);
        });
    tauri::async_runtime::spawn(async move {
        let destination = match recv.await {
            Ok(Some(Ok(destination))) => Some(destination),
            Ok(None) => None,
            _ => {
                downloads.update(
                    &task,
                    "failed",
                    0,
                    task.reference.size,
                    Some("无法访问系统选择的保存位置"),
                    None,
                    &|progress| {
                        let _ = handle.emit("nas-download-progress", progress);
                    },
                );
                return;
            }
        };
        let media = handle.state::<MediaState>().inner().clone();
        downloads
            .run(&media, task, destination, |progress| {
                let _ = handle.emit("nas-download-progress", progress);
            })
            .await;
    });
    Ok(progress)
}
