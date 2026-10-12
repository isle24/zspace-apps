//! Read-only capabilities granted only by the normal system file picker.
use crate::media::{DownloadLease, MediaState};
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt, OpenOptionsSyncExt};
#[cfg(unix)]
use cap_std::fs::MetadataExt;
use cap_std::fs::{Dir, Metadata, OpenOptions};
use same_file::Handle;
use serde::Serialize;
use std::{
    collections::HashMap,
    ffi::OsString,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::ipc::Response;
use tauri_plugin_dialog::DialogExt;
const CHUNK: u64 = 2 * 1024 * 1024;
const LIMIT: usize = 64;
const TTL: Duration = Duration::from_secs(8 * 60 * 60);
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const CLOSED: &str = "上传源已失效，请重新选择文件";
const CHANGED: &str = "所选文件已变化，请重新选择文件";
const UNAVAILABLE: &str = "无法读取系统选择的普通文件";
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeUploadSource {
    id: String,
    name: String,
    size: u64,
    last_modified: u64,
    session_id: String,
}
#[derive(Clone, Default)]
pub struct UploadSourceState {
    registry: Arc<Mutex<Registry>>,
}
#[derive(Default)]
struct Registry {
    entries: HashMap<String, Arc<Pick>>,
    closed: bool,
}
struct Resources {
    lease: Option<DownloadLease>,
    file: Option<Arc<Pinned>>,
}
struct Pick {
    id: String,
    session_id: String,
    cancelled: AtomicBool,
    resources: Mutex<Resources>,
    touched: Mutex<Instant>,
    read_gate: Mutex<()>,
    // Hash output alone shares this per-source revocation gate. Never held for IO.
    output_gate: Mutex<()>,
}
impl Pick {
    fn active(&self) -> bool {
        !self.cancelled.load(Ordering::Acquire)
            && self.resources.lock().is_ok_and(|r| {
                r.lease
                    .as_ref()
                    .is_some_and(|l| !l.session.cancelled.load(Ordering::Acquire))
            })
    }
    fn revoke(&self) {
        self.cancelled.store(true, Ordering::Release);
        let _output = self.output_gate.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(mut r) = self.resources.lock() {
            r.file.take();
            r.lease.take();
        }
    }
}
#[derive(PartialEq, Eq)]
struct Snapshot {
    size: u64,
    modified: SystemTime,
    #[cfg(unix)]
    change: (i64, i64),
}
impl Snapshot {
    fn new(metadata: &Metadata) -> Result<Self, String> {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(UNAVAILABLE.into());
        }
        let modified = metadata.modified().map_err(|_| UNAVAILABLE)?.into_std();
        let size = metadata.len();
        let millis = modified
            .duration_since(UNIX_EPOCH)
            .map_err(|_| UNAVAILABLE)?
            .as_millis();
        if size > MAX_SAFE || millis > MAX_SAFE as u128 {
            return Err(UNAVAILABLE.into());
        }
        Ok(Self {
            size,
            modified,
            #[cfg(unix)]
            change: (metadata.ctime(), metadata.ctime_nsec()),
        })
    }
}
struct Pinned {
    parent: Dir,
    name: OsString,
    path: PathBuf,
    file: Handle,
    snapshot: Snapshot,
}
fn readonly_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No).nonblock(true);
    options
}
impl Pinned {
    fn pin(path: PathBuf) -> Result<Self, String> {
        if !path.is_absolute() {
            return Err(UNAVAILABLE.into());
        }
        let name = path.file_name().ok_or(UNAVAILABLE)?.to_owned();
        let public = name.to_str().ok_or(UNAVAILABLE)?;
        if public.is_empty()
            || public
                .chars()
                .any(|c| c.is_control() || c == '/' || c == '\\')
            || public.len() > 1024
        {
            return Err(UNAVAILABLE.into());
        }
        #[cfg(windows)]
        {
            if path.components().next().is_some_and(|component| {
                matches!(component, std::path::Component::Prefix(prefix)
                    if matches!(prefix.kind(), std::path::Prefix::DeviceNS(_) | std::path::Prefix::Verbatim(_)))
            }) {
                return Err(UNAVAILABLE.into());
            }
        }
        let parent = Dir::open_ambient_dir(
            path.parent().ok_or(UNAVAILABLE)?,
            cap_std::ambient_authority(),
        )
        .map_err(|_| UNAVAILABLE)?;
        let before = parent.symlink_metadata(&name).map_err(|_| UNAVAILABLE)?;
        if !before.is_file() || before.file_type().is_symlink() {
            return Err(UNAVAILABLE.into());
        }
        let file = Handle::from_file(
            parent
                .open_with(&name, &readonly_options())
                .map_err(|_| UNAVAILABLE)?
                .into_std(),
        )
        .map_err(|_| UNAVAILABLE)?;
        let metadata = Metadata::from_file(file.as_file()).map_err(|_| UNAVAILABLE)?;
        let snapshot = Snapshot::new(&metadata)?;
        if Snapshot::new(&before)? != snapshot {
            return Err(CHANGED.into());
        }
        let pinned = Self {
            parent,
            name,
            path,
            file,
            snapshot,
        };
        pinned.verify()?;
        Ok(pinned)
    }
    fn verify(&self) -> Result<(), String> {
        let handle = Metadata::from_file(self.file.as_file()).map_err(|_| CHANGED)?;
        if Snapshot::new(&handle)? != self.snapshot {
            return Err(CHANGED.into());
        }
        let entry = self
            .parent
            .symlink_metadata(&self.name)
            .map_err(|_| CHANGED)?;
        let absolute = Metadata::from_just_metadata(
            std::fs::symlink_metadata(&self.path).map_err(|_| CHANGED)?,
        );
        if Snapshot::new(&entry)? != self.snapshot || Snapshot::new(&absolute)? != self.snapshot {
            return Err(CHANGED.into());
        }
        // Reopen only for identity/metadata. Content always comes from the original selected handle.
        let entry_file = self
            .parent
            .open_with(&self.name, &readonly_options())
            .map_err(|_| CHANGED)?
            .into_std();
        let absolute_file = cap_std::fs::File::open_ambient_with(
            &self.path,
            &readonly_options(),
            cap_std::ambient_authority(),
        )
        .map_err(|_| CHANGED)?
        .into_std();
        for file in [entry_file, absolute_file] {
            let file = Handle::from_file(file).map_err(|_| CHANGED)?;
            let metadata = Metadata::from_file(file.as_file()).map_err(|_| CHANGED)?;
            if file != self.file || Snapshot::new(&metadata)? != self.snapshot {
                return Err(CHANGED.into());
            }
        }
        Ok(())
    }
    fn public(&self, pick: &Pick) -> NativeUploadSource {
        NativeUploadSource {
            id: pick.id.clone(),
            session_id: pick.session_id.clone(),
            name: self.name.to_str().unwrap().to_owned(),
            size: self.snapshot.size,
            last_modified: self
                .snapshot
                .modified
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
        }
    }
}
fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl UploadSourceState {
    pub(crate) fn attach(&self, media: &MediaState) {
        let weak = Arc::downgrade(&self.registry);
        media.set_revoked_notifier(Arc::new(move |sid| {
            if let Some(registry) = weak.upgrade() {
                let state = Self { registry };
                state.revoke_session(sid);
            }
        }));
    }
    fn remove(&self, pick: &Arc<Pick>) {
        pick.revoke();
        if let Ok(mut r) = self.registry.lock() {
            if r.entries
                .get(&pick.id)
                .is_some_and(|current| Arc::ptr_eq(current, pick))
            {
                r.entries.remove(&pick.id);
            }
        }
    }
    fn revoke_session(&self, sid: &str) {
        let removed = self
            .registry
            .lock()
            .map(|mut r| {
                let ids: Vec<_> = r
                    .entries
                    .iter()
                    .filter(|(_, p)| p.session_id == sid)
                    .map(|(id, _)| id.clone())
                    .collect();
                ids.into_iter()
                    .filter_map(|id| r.entries.remove(&id))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for pick in removed {
            pick.revoke();
        }
    }
    fn current(&self, pick: &Arc<Pick>) -> bool {
        self.check_current(pick, false)
    }
    fn refresh_current(&self, pick: &Arc<Pick>) -> bool {
        self.check_current(pick, true)
    }
    fn check_current(&self, pick: &Arc<Pick>, refresh: bool) -> bool {
        let current = self.is_current(pick, refresh);
        if !current {
            // Registry/timestamp guards are dropped before output/resource cleanup.
            self.remove(pick);
        }
        current
    }
    fn is_current(&self, pick: &Arc<Pick>, refresh: bool) -> bool {
        self.registry.lock().is_ok_and(|r| {
            !r.closed
                && r.entries
                    .get(&pick.id)
                    .is_some_and(|p| Arc::ptr_eq(p, pick))
                && pick.active()
                && pick.touched.lock().is_ok_and(|mut touched| {
                    // Check and optional refresh share this lock; an expired ticket
                    // cannot refresh itself before the periodic prune has run.
                    let now = Instant::now();
                    if now.saturating_duration_since(*touched) >= TTL {
                        return false;
                    }
                    if refresh {
                        *touched = now;
                    }
                    true
                })
        })
    }
    fn reserve(
        &self,
        media: &MediaState,
        base: &str,
        cookie: &str,
        sid: &str,
    ) -> Result<Arc<Pick>, String> {
        let origin = tauri_plugin_http::reqwest::Url::parse(base).map_err(|_| CLOSED)?;
        if base.len() > 2048
            || !matches!(origin.scheme(), "http" | "https")
            || origin.host_str().is_none()
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
        {
            return Err(CLOSED.into());
        }
        self.prune_at(Instant::now());
        let lease = media
            .download_session(base, cookie, sid)
            .map_err(|_| CLOSED)?;
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| UNAVAILABLE)?;
        let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let pick = Arc::new(Pick {
            id,
            session_id: sid.to_owned(),
            cancelled: AtomicBool::new(false),
            resources: Mutex::new(Resources {
                lease: Some(lease),
                file: None,
            }),
            touched: Mutex::new(Instant::now()),
            read_gate: Mutex::new(()),
            output_gate: Mutex::new(()),
        });
        let mut r = self.registry.lock().map_err(|_| CLOSED)?;
        if r.closed || !pick.active() {
            return Err(CLOSED.into());
        }
        if r.entries.len() >= LIMIT {
            return Err("上传源数量已达上限".into());
        }
        if r.entries.contains_key(&pick.id) {
            return Err(UNAVAILABLE.into());
        }
        r.entries.insert(pick.id.clone(), pick.clone());
        Ok(pick)
    }
    fn finish(
        &self,
        pick: &Arc<Pick>,
        path: Option<PathBuf>,
    ) -> Result<Option<NativeUploadSource>, String> {
        let result = (|| {
            if !self.current(pick) {
                return Err(CLOSED.into());
            }
            let Some(path) = path else {
                return Ok(None);
            };
            let pinned = Arc::new(Pinned::pin(path)?);
            if !self.current(pick) {
                return Err(CLOSED.into());
            }
            let public = pinned.public(pick);
            {
                let mut r = pick.resources.lock().map_err(|_| CLOSED)?;
                if pick.cancelled.load(Ordering::Acquire) {
                    return Err(CLOSED.into());
                }
                if r.file.is_some() {
                    return Err(CLOSED.into());
                }
                r.file = Some(pinned);
            }
            if !self.refresh_current(pick) {
                return Err(CLOSED.into());
            }
            Ok(Some(public))
        })();
        if !matches!(result, Ok(Some(_))) {
            self.remove(pick);
        }
        result
    }
    fn find(&self, id: &str, sid: &str) -> Result<Arc<Pick>, String> {
        if !valid_id(id) {
            return Err(CLOSED.into());
        }
        self.prune_at(Instant::now());
        let r = self.registry.lock().map_err(|_| CLOSED)?;
        let p = r
            .entries
            .get(id)
            .filter(|p| p.session_id == sid && p.active())
            .ok_or(CLOSED)?;
        Ok(p.clone())
    }
    fn read(
        &self,
        id: &str,
        sid: &str,
        offset: u64,
        length: u64,
        after_io: impl FnOnce(),
    ) -> Result<Vec<u8>, String> {
        if length > CHUNK || offset > MAX_SAFE {
            return Err("上传源读取范围无效".into());
        }
        let pick = self.find(id, sid)?;
        let _gate = pick
            .read_gate
            .try_lock()
            .map_err(|_| "上传源正在读取，请稍后重试")?;
        let pinned = pick
            .resources
            .lock()
            .map_err(|_| CLOSED)?
            .file
            .clone()
            .ok_or(CLOSED)?;
        if offset
            .checked_add(length)
            .is_none_or(|end| end > pinned.snapshot.size)
        {
            return Err("上传源读取范围无效".into());
        }
        let result = (|| {
            if !self.current(&pick) {
                return Err(CLOSED.into());
            }
            pinned.verify()?;
            let mut file = pinned.file.as_file();
            file.seek(SeekFrom::Start(offset))
                .map_err(|_| UNAVAILABLE)?;
            let mut bytes = vec![0u8; length as usize];
            file.read_exact(&mut bytes).map_err(|_| CHANGED)?;
            after_io();
            pinned.verify()?;
            if !self.refresh_current(&pick) {
                return Err(CLOSED.into());
            }
            Ok(bytes)
        })();
        if result.is_err() {
            self.remove(&pick);
        }
        result
    }
    fn release(&self, id: &str, sid: &str) -> Result<(), String> {
        let pick = self.find(id, sid)?;
        self.remove(&pick);
        Ok(())
    }
    pub(crate) fn prune_at(&self, now: Instant) {
        let removed = self
            .registry
            .lock()
            .map(|mut r| {
                let ids: Vec<_> = r
                    .entries
                    .iter()
                    .filter(|(_, p)| {
                        !p.active()
                            || !p
                                .touched
                                .lock()
                                .is_ok_and(|t| now.saturating_duration_since(*t) < TTL)
                    })
                    .map(|(id, _)| id.clone())
                    .collect();
                ids.into_iter()
                    .filter_map(|id| r.entries.remove(&id))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for pick in removed {
            pick.revoke();
        }
    }
    pub(crate) fn clear_all(&self) {
        let removed = self
            .registry
            .lock()
            .map(|mut r| {
                r.closed = true;
                r.entries.drain().map(|(_, p)| p).collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for pick in removed {
            pick.revoke();
        }
    }
    fn accept_read(&self, pick: &Arc<Pick>, bytes: Vec<u8>) -> Result<Response, String> {
        if !self.current(pick) {
            return Err(CLOSED.into());
        }
        Ok(Response::new(bytes))
    }
    #[cfg(test)]
    fn count(&self) -> usize {
        self.registry.lock().unwrap().entries.len()
    }
}
/// Private snapshot and exact selected-source ownership for off-thread hashing.
#[derive(Clone)]
pub(crate) struct HashSource {
    state: UploadSourceState,
    pick: Arc<Pick>,
    pub(crate) size: u64,
    pub(crate) last_modified: u64,
}
impl HashSource {
    pub(crate) fn with_hash_output<R>(&self, output: impl FnOnce() -> R) -> Option<R> {
        let _output = self.pick.output_gate.lock().ok()?;
        Some(output())
    }
    // Inside the output gate, inspect validity without recursively revoking it.
    // The ordinary current() call after emission reclaims invalid resources.
    pub(crate) fn current_for_output(&self) -> bool {
        self.state.is_current(&self.pick, false)
    }
    pub(crate) fn current(&self) -> bool {
        self.state.current(&self.pick)
    }
    pub(crate) fn verify(&self) -> Result<(), String> {
        if !self.current() {
            return Err(CLOSED.into());
        }
        let pinned = self
            .pick
            .resources
            .lock()
            .map_err(|_| CLOSED)?
            .file
            .clone()
            .ok_or(CLOSED)?;
        let result = pinned.verify();
        if result.is_err() {
            self.state.remove(&self.pick);
        }
        result?;
        if !self.current() {
            return Err(CLOSED.into());
        }
        Ok(())
    }
    pub(crate) fn read(&self, offset: u64, length: u64) -> Result<Vec<u8>, String> {
        self.state
            .read(&self.pick.id, &self.pick.session_id, offset, length, || {})
    }
}
impl UploadSourceState {
    pub(crate) fn hash_source(&self, id: &str, sid: &str) -> Result<HashSource, String> {
        let pick = self.find(id, sid)?;
        let pinned = pick
            .resources
            .lock()
            .map_err(|_| CLOSED)?
            .file
            .clone()
            .ok_or(CLOSED)?;
        Ok(HashSource {
            size: pinned.snapshot.size,
            last_modified: pinned
                .snapshot
                .modified
                .duration_since(UNIX_EPOCH)
                .map_err(|_| CLOSED)?
                .as_millis() as u64,
            state: self.clone(),
            pick,
        })
    }
    #[cfg(test)]
    pub(crate) fn hash_test_select(
        &self,
        media: &MediaState,
        path: PathBuf,
        sid: &str,
    ) -> NativeUploadSource {
        let ticket = self
            .reserve(
                media,
                "https://synthetic-nas.example/",
                "token=synthetic-cookie",
                sid,
            )
            .unwrap();
        self.finish(&ticket, Some(path)).unwrap().unwrap()
    }
    #[cfg(test)]
    pub(crate) fn hash_test_expire(&self, id: &str, sid: &str) {
        let pick = self.find(id, sid).unwrap();
        *pick.touched.lock().unwrap() = Instant::now() - TTL - Duration::from_secs(1);
    }
    #[cfg(test)]
    pub(crate) fn registry_count_for_hash_test(&self) -> usize {
        self.count()
    }
    #[cfg(test)]
    pub(crate) fn hash_test_release(&self, id: &str, sid: &str) {
        self.release(id, sid).unwrap();
    }
}
#[tauri::command]
pub async fn nas_upload_pick(
    base: String,
    cookie: String,
    session_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, UploadSourceState>,
    media: tauri::State<'_, MediaState>,
) -> Result<Option<NativeUploadSource>, String> {
    let pick = state.reserve(&media, &base, &cookie, &session_id)?;
    // No private Cookie/base clone is kept by the dialog or file capability.
    drop(base);
    drop(cookie);
    let (send, recv) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_file(move |path| {
        let selected = path.map(|p| p.into_path().map_err(|_| UNAVAILABLE.to_string()));
        let _ = send.send(selected);
    });
    let selected = match recv.await {
        Ok(Some(Ok(path))) => Some(path),
        Ok(None) => None,
        _ => {
            state.remove(&pick);
            return Err(UNAVAILABLE.into());
        }
    };
    let owned = state.inner().clone();
    let ticket = pick.clone();
    let result = tauri::async_runtime::spawn_blocking(move || owned.finish(&ticket, selected))
        .await
        .map_err(|_| UNAVAILABLE.to_string())?;
    if matches!(result, Ok(Some(_))) && !state.current(&pick) {
        state.remove(&pick);
        return Err(CLOSED.into());
    }
    result
}
#[tauri::command]
pub async fn nas_upload_read(
    id: String,
    session_id: String,
    offset: u64,
    length: u64,
    state: tauri::State<'_, UploadSourceState>,
) -> Result<Response, String> {
    let pick = state.find(&id, &session_id)?;
    let owned = state.inner().clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        owned.read(&id, &session_id, offset, length, || {})
    })
    .await
    .map_err(|_| UNAVAILABLE.to_string())??;
    state.accept_read(&pick, bytes)
}
#[tauri::command]
pub fn nas_upload_release(
    id: String,
    session_id: String,
    state: tauri::State<'_, UploadSourceState>,
) -> Result<(), String> {
    state.release(&id, &session_id)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::{
        fs,
        sync::{
            atomic::{AtomicBool, Ordering},
            Barrier,
        },
        thread,
    };
    const BASE: &str = "https://synthetic-nas.example/";
    const COOKIE: &str = "token=synthetic-cookie";
    const SID: &str = "synthetic-session";
    fn setup() -> (UploadSourceState, MediaState, tempfile::TempDir, PathBuf) {
        let state = UploadSourceState::default();
        let media = MediaState::default();
        state.attach(&media);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("选择 source.txt");
        fs::write(&path, b"0123456789").unwrap();
        (state, media, dir, path)
    }
    fn pick(state: &UploadSourceState, media: &MediaState, path: &Path) -> NativeUploadSource {
        let ticket = state.reserve(media, BASE, COOKIE, SID).unwrap();
        state.finish(&ticket, Some(path.into())).unwrap().unwrap()
    }
    #[test]
    fn selected_metadata_is_safe_opaque_and_path_cookie_free() {
        let (s, m, _d, p) = setup();
        let source = pick(&s, &m, &p);
        assert_eq!(source.name, "选择 source.txt");
        assert_eq!(source.size, 10);
        assert_eq!(source.session_id, SID);
        assert_eq!(source.id.len(), 64);
        assert!(source
            .id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        let value = serde_json::to_value(&source).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 5);
        let json = value.to_string();
        assert!(!json.contains(COOKIE));
        assert!(!json.contains(p.parent().unwrap().to_str().unwrap()));
        assert!(source.last_modified <= 9_007_199_254_740_991);
    }
    #[test]
    fn reads_exact_ranges_empty_and_never_changes_original() {
        let (s, m, _d, p) = setup();
        let source = pick(&s, &m, &p);
        let before = fs::metadata(&p).unwrap().modified().unwrap();
        assert_eq!(s.read(&source.id, SID, 3, 4, || {}).unwrap(), b"3456");
        assert_eq!(s.read(&source.id, SID, 10, 0, || {}).unwrap(), b"");
        assert_eq!(fs::read(&p).unwrap(), b"0123456789");
        assert_eq!(fs::metadata(&p).unwrap().modified().unwrap(), before);
    }
    #[test]
    fn rejects_oversized_invalid_ranges_and_foreign_owner() {
        let (s, m, _d, p) = setup();
        let source = pick(&s, &m, &p);
        for (offset, length) in [(0, CHUNK + 1), (9, 2), (11, 0), (u64::MAX, 1)] {
            assert!(s.read(&source.id, SID, offset, length, || {}).is_err());
        }
        assert!(s.read(&source.id, "foreign-session", 0, 1, || {}).is_err());
        assert!(s.read(&"f".repeat(64), SID, 0, 1, || {}).is_err());
        assert!(s.release(&source.id, "foreign-session").is_err());
        assert_eq!(s.read(&source.id, SID, 0, 1, || {}).unwrap(), b"0");
    }
    #[test]
    fn cap_sized_chunk_and_tail_cover_large_file() {
        let (s, m, _d, p) = setup();
        let bytes: Vec<u8> = (0..CHUNK + 17).map(|i| (i % 251) as u8).collect();
        fs::write(&p, &bytes).unwrap();
        let source = pick(&s, &m, &p);
        assert_eq!(
            s.read(&source.id, SID, 0, CHUNK, || {}).unwrap(),
            bytes[..CHUNK as usize]
        );
        assert_eq!(
            s.read(&source.id, SID, CHUNK, 17, || {}).unwrap(),
            bytes[CHUNK as usize..]
        );
    }
    #[test]
    fn empty_file_has_real_metadata_and_zero_read() {
        let (s, m, _d, p) = setup();
        fs::write(&p, b"").unwrap();
        let source = pick(&s, &m, &p);
        assert_eq!(source.size, 0);
        assert!(s.read(&source.id, SID, 0, 0, || {}).unwrap().is_empty());
    }
    #[test]
    fn picker_cancel_returns_none_and_releases_reservation() {
        let (s, m, _d, _p) = setup();
        let t = s.reserve(&m, BASE, COOKIE, SID).unwrap();
        assert!(s.finish(&t, None).unwrap().is_none());
        assert_eq!(s.count(), 0);
    }
    #[test]
    fn directories_and_missing_file_fail_with_static_private_errors() {
        let (s, m, d, _p) = setup();
        for p in [
            d.path().to_path_buf(),
            d.path().join("synthetic-secret-missing"),
        ] {
            let t = s.reserve(&m, BASE, COOKIE, SID).unwrap();
            let e = s.finish(&t, Some(p)).unwrap_err();
            assert!(!e.contains("synthetic-secret"));
            assert!(!e.contains(d.path().to_str().unwrap()));
        }
        assert_eq!(s.count(), 0);
    }
    #[cfg(unix)]
    #[test]
    fn selected_symlink_cannot_read_its_target() {
        let (s, m, d, p) = setup();
        let link = d.path().join("link");
        std::os::unix::fs::symlink(&p, &link).unwrap();
        let t = s.reserve(&m, BASE, COOKIE, SID).unwrap();
        assert!(s.finish(&t, Some(link)).is_err());
        assert_eq!(fs::read(p).unwrap(), b"0123456789");
    }
    #[test]
    fn replaced_entry_never_reads_replacement_and_drops_old_ref() {
        let (s, m, d, p) = setup();
        let source = pick(&s, &m, &p);
        fs::rename(&p, d.path().join("original")).unwrap();
        fs::write(&p, b"xxxxxxxxxx").unwrap();
        assert!(s.read(&source.id, SID, 0, 10, || {}).is_err());
        assert_eq!(s.count(), 0);
        assert_eq!(fs::read(p).unwrap(), b"xxxxxxxxxx");
    }
    #[test]
    fn size_or_same_size_mtime_change_revokes_source() {
        for bytes in [b"short".as_slice(), b"xxxxxxxxxx".as_slice()] {
            let (s, m, _d, p) = setup();
            let source = pick(&s, &m, &p);
            fs::write(&p, bytes).unwrap();
            assert!(s.read(&source.id, SID, 0, 1, || {}).is_err());
            assert_eq!(s.count(), 0);
        }
    }
    #[test]
    fn metadata_change_after_io_cannot_return_bytes() {
        let (s, m, _d, p) = setup();
        let source = pick(&s, &m, &p);
        assert!(s
            .read(&source.id, SID, 0, 1, || fs::write(&p, b"changed").unwrap())
            .is_err());
    }
    #[test]
    fn release_revokes_only_owned_source_and_preserves_other_leases() {
        let (s, m, _d, p) = setup();
        let old = pick(&s, &m, &p);
        let new = pick(&s, &m, &p);
        let media_ref = m
            .register(BASE, "/v2/file/download?path=%2Fsynthetic", COOKIE, SID)
            .unwrap();
        s.release(&old.id, SID).unwrap();
        assert!(s.read(&old.id, SID, 0, 1, || {}).is_err());
        assert_eq!(s.read(&new.id, SID, 0, 1, || {}).unwrap(), b"0");
        assert!(m.download_session(BASE, COOKIE, SID).is_ok());
        assert!(!media_ref.is_empty());
    }
    #[test]
    fn clear_and_auth_expiry_reclaim_sources_and_deny_old_identity() {
        for expired in [false, true] {
            let (s, m, _d, p) = setup();
            let source = pick(&s, &m, &p);
            if expired {
                m.expire_auth(SID);
            } else {
                m.clear(SID).unwrap();
            }
            assert_eq!(s.count(), 0);
            assert!(s.read(&source.id, SID, 0, 1, || {}).is_err());
            assert!(s.reserve(&m, BASE, COOKIE, SID).is_err());
        }
    }
    #[test]
    fn delayed_picker_after_clear_cannot_resurrect_or_remove_new_session_source() {
        let (s, m, _d, p) = setup();
        let old = s.reserve(&m, BASE, COOKIE, SID).unwrap();
        m.clear(SID).unwrap();
        let new = s.reserve(&m, BASE, COOKIE, "new-session").unwrap();
        let new = s.finish(&new, Some(p.clone())).unwrap().unwrap();
        assert!(s.finish(&old, Some(p)).is_err());
        assert_eq!(s.read(&new.id, "new-session", 0, 1, || {}).unwrap(), b"0");
        assert_eq!(s.count(), 1);
    }
    #[test]
    fn release_during_io_suppresses_output_without_registry_deadlock() {
        let (s, m, _d, p) = setup();
        let source = pick(&s, &m, &p);
        let b = Arc::new(Barrier::new(2));
        let c = b.clone();
        let worker = s.clone();
        let id = source.id.clone();
        let run = thread::spawn(move || {
            worker.read(&id, SID, 0, 1, || {
                c.wait();
                c.wait();
            })
        });
        b.wait();
        s.release(&source.id, SID).unwrap();
        b.wait();
        assert!(run.join().unwrap().is_err());
    }
    #[test]
    fn clear_during_io_suppresses_output_and_new_session_remains_valid() {
        let (s, m, _d, p) = setup();
        let source = pick(&s, &m, &p);
        assert!(s
            .read(&source.id, SID, 0, 1, || m.clear(SID).unwrap())
            .is_err());
        let t = s.reserve(&m, BASE, COOKIE, "new-session").unwrap();
        let new = s.finish(&t, Some(p)).unwrap().unwrap();
        assert_eq!(s.read(&new.id, "new-session", 0, 1, || {}).unwrap(), b"0");
    }
    #[test]
    fn bounded_pending_and_source_idle_pruning_reclaims_handles() {
        let (s, m, _d, p) = setup();
        let source = pick(&s, &m, &p);
        let mut pending = Vec::new();
        for _ in 1..LIMIT {
            pending.push(s.reserve(&m, BASE, COOKIE, SID).unwrap());
        }
        assert!(s.reserve(&m, BASE, COOKIE, SID).is_err());
        s.prune_at(Instant::now() + TTL + Duration::from_secs(1));
        assert_eq!(s.count(), 0);
        assert!(s.read(&source.id, SID, 0, 1, || {}).is_err());
        assert!(s.finish(&pending[0], Some(p)).is_err());
    }
    #[test]
    fn exit_revokes_pending_and_inflight_sources_without_touching_files() {
        let (s, m, _d, p) = setup();
        let source = pick(&s, &m, &p);
        let t = s.reserve(&m, BASE, COOKIE, SID).unwrap();
        assert!(s.read(&source.id, SID, 0, 1, || s.clear_all()).is_err());
        assert!(s.finish(&t, Some(p.clone())).is_err());
        assert!(s.reserve(&m, BASE, COOKIE, SID).is_err());
        assert_eq!(fs::read(p).unwrap(), b"0123456789");
    }
    #[test]
    fn wrong_cookie_or_nas_cannot_bind_existing_identity() {
        let (s, m, _d, p) = setup();
        let _source = pick(&s, &m, &p);
        assert!(s.reserve(&m, BASE, "token=foreign", SID).is_err());
        assert!(s
            .reserve(&m, "https://foreign.example/", COOKIE, SID)
            .is_err());
    }
    #[test]
    fn metadata_only_post_io_check_is_executed_for_empty_reads() {
        let (s, m, _d, p) = setup();
        let source = pick(&s, &m, &p);
        let called = AtomicBool::new(false);
        let result = s.read(&source.id, SID, 0, 0, || {
            called.store(true, Ordering::Relaxed);
            m.clear(SID).unwrap();
        });
        assert!(called.load(Ordering::Relaxed));
        assert!(result.is_err());
    }
    #[test]
    fn invalid_private_origin_is_rejected_before_picker() {
        let (s, m, _d, _p) = setup();
        for base in [
            "file:///synthetic",
            "https://user:synthetic-secret@nas.example/",
            "https://nas.example/path",
            "https://nas.example/?token=synthetic-secret",
            "https://nas.example/#fragment",
        ] {
            assert!(
                s.reserve(&m, base, COOKIE, SID).is_err(),
                "invalid origin accepted"
            );
        }
        assert_eq!(s.count(), 0);
    }
    #[test]
    fn concurrent_same_source_read_fails_promptly_without_unbounded_waits() {
        let (s, m, _d, p) = setup();
        let source = pick(&s, &m, &p);
        let b = Arc::new(Barrier::new(2));
        let c = b.clone();
        let worker = s.clone();
        let id = source.id.clone();
        let run = thread::spawn(move || {
            worker.read(&id, SID, 0, 1, || {
                c.wait();
                c.wait();
            })
        });
        b.wait();
        assert!(s.read(&source.id, SID, 0, 1, || {}).is_err());
        b.wait();
        assert_eq!(run.join().unwrap().unwrap(), b"0");
    }
    #[test]
    fn session_clear_drops_owned_file_and_lease_even_with_old_ticket_held() {
        let (s, m, _d, p) = setup();
        let t = s.reserve(&m, BASE, COOKIE, SID).unwrap();
        let _source = s.finish(&t, Some(p)).unwrap();
        m.clear(SID).unwrap();
        let resources = t.resources.lock().unwrap();
        assert!(resources.file.is_none());
        assert!(resources.lease.is_none());
    }
    #[cfg(unix)]
    #[test]
    fn file_replaced_with_symlink_is_rejected_even_if_target_is_original() {
        let (s, m, d, p) = setup();
        let source = pick(&s, &m, &p);
        let old = d.path().join("old");
        fs::rename(&p, &old).unwrap();
        std::os::unix::fs::symlink(&old, &p).unwrap();
        assert!(s.read(&source.id, SID, 0, 1, || {}).is_err());
        assert_eq!(fs::read(old).unwrap(), b"0123456789");
    }
    #[test]
    fn renamed_parent_cannot_authorize_replaced_original_path() {
        let (s, m, d, _p) = setup();
        let parent = d.path().join("parent");
        fs::create_dir(&parent).unwrap();
        let p = parent.join("source");
        fs::write(&p, b"original").unwrap();
        let source = pick(&s, &m, &p);
        fs::rename(&parent, d.path().join("old-parent")).unwrap();
        fs::create_dir(&parent).unwrap();
        fs::write(&p, b"replaced").unwrap();
        assert!(s.read(&source.id, SID, 0, 1, || {}).is_err());
    }

    #[test]
    fn ipc_returns_exact_binary_body_and_rechecks_owner_after_blocking_read() {
        use tauri::ipc::{InvokeResponseBody, IpcResponse};
        let (s, m, _d, p) = setup();
        let source = pick(&s, &m, &p);
        let ticket = s.find(&source.id, SID).unwrap();
        let bytes = s.read(&source.id, SID, 0, 10, || {}).unwrap();
        match s
            .accept_read(&ticket, bytes.clone())
            .unwrap()
            .body()
            .unwrap()
        {
            InvokeResponseBody::Raw(raw) => assert_eq!(raw, b"0123456789"),
            _ => panic!("must be binary IPC"),
        }
        s.release(&source.id, SID).unwrap();
        assert!(s.accept_read(&ticket, bytes).is_err());
    }
    #[test]
    fn finishing_delayed_picker_starts_full_source_idle_lifetime() {
        let (s, m, _d, p) = setup();
        let ticket = s.reserve(&m, BASE, COOKIE, SID).unwrap();
        *ticket.touched.lock().unwrap() = Instant::now() - TTL + Duration::from_secs(1);
        let source = s.finish(&ticket, Some(p)).unwrap().unwrap();
        s.prune_at(Instant::now() + Duration::from_secs(2));
        assert_eq!(s.read(&source.id, SID, 0, 1, || {}).unwrap(), b"0");
    }
    #[test]
    fn pre_epoch_file_metadata_is_rejected_without_exporting_path() {
        let (s, m, _d, p) = setup();
        let file = fs::OpenOptions::new().write(true).open(&p).unwrap();
        file.set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH - Duration::from_secs(1)))
            .unwrap();
        let ticket = s.reserve(&m, BASE, COOKIE, SID).unwrap();
        assert!(s.finish(&ticket, Some(p)).is_err());
        assert_eq!(s.count(), 0);
    }
    fn age_without_pruning(ticket: &Arc<Pick>) {
        *ticket.touched.lock().unwrap() = Instant::now() - TTL - Duration::from_secs(1);
    }
    fn assert_revoked_resources(ticket: &Arc<Pick>) {
        assert!(ticket.cancelled.load(Ordering::Acquire));
        let resources = ticket.resources.lock().unwrap();
        assert!(resources.file.is_none());
        assert!(resources.lease.is_none());
    }
    #[test]
    fn expired_pending_picker_cannot_refresh_before_periodic_prune() {
        let (s, m, _d, p) = setup();
        let unrelated = pick(&s, &m, &p);
        let expired = s.reserve(&m, BASE, COOKIE, SID).unwrap();
        let valid_new = s.reserve(&m, BASE, COOKIE, "new-session").unwrap();
        let valid_new = s.finish(&valid_new, Some(p.clone())).unwrap().unwrap();
        age_without_pruning(&expired);
        let aged = *expired.touched.lock().unwrap();
        assert!(s.finish(&expired, Some(p.clone())).is_err());
        assert_eq!(*expired.touched.lock().unwrap(), aged);
        assert_revoked_resources(&expired);
        assert_eq!(s.count(), 2);
        assert_eq!(s.read(&unrelated.id, SID, 0, 1, || {}).unwrap(), b"0");
        assert_eq!(
            s.read(&valid_new.id, "new-session", 0, 1, || {}).unwrap(),
            b"0"
        );
        assert!(m.download_session(BASE, COOKIE, SID).is_ok());
        assert_eq!(fs::read(p).unwrap(), b"0123456789");
    }
    #[test]
    fn expired_after_io_cannot_return_or_refresh_before_periodic_prune() {
        let (s, m, _d, p) = setup();
        let source = pick(&s, &m, &p);
        let unrelated = pick(&s, &m, &p);
        let ticket = s.find(&source.id, SID).unwrap();
        let result = s.read(&source.id, SID, 0, 1, || age_without_pruning(&ticket));
        assert!(result.is_err());
        assert!(Instant::now().saturating_duration_since(*ticket.touched.lock().unwrap()) >= TTL);
        assert_revoked_resources(&ticket);
        assert_eq!(s.count(), 1);
        assert_eq!(s.read(&unrelated.id, SID, 0, 1, || {}).unwrap(), b"0");
        assert!(m.download_session(BASE, COOKIE, SID).is_ok());
        assert_eq!(fs::read(p).unwrap(), b"0123456789");
    }
    #[test]
    fn expired_post_join_result_cannot_be_binary_ipc_before_periodic_prune() {
        let (s, m, _d, p) = setup();
        let source = pick(&s, &m, &p);
        let unrelated = pick(&s, &m, &p);
        let ticket = s.find(&source.id, SID).unwrap();
        let bytes = s.read(&source.id, SID, 0, 1, || {}).unwrap();
        age_without_pruning(&ticket);
        let aged = *ticket.touched.lock().unwrap();
        assert!(s.accept_read(&ticket, bytes).is_err());
        assert_eq!(*ticket.touched.lock().unwrap(), aged);
        assert_revoked_resources(&ticket);
        assert_eq!(s.count(), 1);
        assert_eq!(s.read(&unrelated.id, SID, 0, 1, || {}).unwrap(), b"0");
        assert!(m.download_session(BASE, COOKIE, SID).is_ok());
        assert_eq!(fs::read(p).unwrap(), b"0123456789");
    }
}
