//! Bounded native hashing of already selected capabilities. No upload transport.
use crate::upload_source::{HashSource, UploadSourceState};
use md5::Md5;
use serde::Serialize;
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    task::Poll,
    time::Duration,
};
use tauri::Emitter;
const CHUNK: u64 = 2 * 1024 * 1024;
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const FAILED: &str = "Could not hash upload source";
const CANCELLED: &str = "Upload hashing cancelled";
const CHANGED: &str = "Upload source changed";
const INVALID: &str = "Invalid upload source";
const BUSY: &str = "Upload hashing is busy";
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadHashes {
    size: u64,
    uuid: String,
    quick_hash: String,
    md5: String,
    sha256: String,
}
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HashProgress {
    operation_id: String,
    source_id: String,
    session_id: String,
    processed_bytes: u64,
    total_bytes: u64,
}
#[derive(Clone, Default)]
pub struct UploadHashState {
    registry: Arc<Mutex<Registry>>,
}
#[derive(Default)]
struct Registry {
    // A cancelled caller does not free its blocking worker's slot.
    active: HashMap<String, Arc<Job>>,
    owners: HashMap<String, Arc<Job>>,
}
struct Job {
    source: HashSource,
    id: String,
    sid: String,
    op: String,
    cancelled: AtomicBool,
    output_gate: Mutex<()>,
}
struct WorkerGuard {
    state: UploadHashState,
    job: Arc<Job>,
}
impl Drop for WorkerGuard {
    fn drop(&mut self) {
        self.state.finish_worker(&self.job);
    }
}
struct CallerGuard {
    state: UploadHashState,
    job: Arc<Job>,
}
impl Drop for CallerGuard {
    fn drop(&mut self) {
        self.job.cancelled.store(true, Ordering::Release);
        // An entered synchronous emission finishes before caller teardown returns.
        let _output = self
            .job
            .output_gate
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        self.state.finish_caller(&self.job);
    }
}
fn lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl UploadHashState {
    fn begin(
        &self,
        sources: &UploadSourceState,
        id: &str,
        sid: &str,
        op: &str,
        target: &str,
    ) -> Result<Arc<Job>, String> {
        if !lower_hex(id, 64) || !lower_hex(op, 32) {
            return Err(INVALID.into());
        }
        let source = sources.hash_source(id, sid).map_err(|_| INVALID)?;
        validate(source.size, source.last_modified, target)?;
        if !source.current() {
            return Err(CHANGED.into());
        }
        let job = Arc::new(Job {
            source,
            id: id.into(),
            sid: sid.into(),
            op: op.into(),
            cancelled: AtomicBool::new(false),
            output_gate: Mutex::new(()),
        });
        let mut registry = self.registry.lock().map_err(|_| FAILED)?;
        if registry.active.len() >= 4
            || registry.active.contains_key(id)
            || registry.owners.contains_key(id)
        {
            return Err(BUSY.into());
        }
        registry.active.insert(id.into(), job.clone());
        registry.owners.insert(id.into(), job.clone());
        Ok(job)
    }
    fn current(&self, job: &Arc<Job>) -> bool {
        !job.cancelled.load(Ordering::Acquire)
            && job.source.current()
            && self
                .registry
                .lock()
                .is_ok_and(|r| r.owners.get(&job.id).is_some_and(|j| Arc::ptr_eq(j, job)))
    }
    fn check(&self, job: &Arc<Job>) -> Result<(), String> {
        if job.cancelled.load(Ordering::Acquire) {
            return Err(CANCELLED.into());
        }
        if !self.current(job) {
            return Err(CHANGED.into());
        }
        Ok(())
    }
    fn cancel(&self, id: &str, sid: &str, op: &str) -> Result<(), String> {
        if !lower_hex(id, 64) || !lower_hex(op, 32) {
            return Err(INVALID.into());
        }
        let job = self
            .registry
            .lock()
            .map_err(|_| FAILED)?
            .owners
            .get(id)
            .filter(|j| j.sid == sid && j.op == op)
            .cloned()
            .ok_or(INVALID)?;
        // Only this job's synchronous output is serialized with its cancellation.
        // Registry and file IO are outside this guard.
        let _output = job.output_gate.lock().map_err(|_| FAILED)?;
        job.cancelled.store(true, Ordering::Release);
        Ok(())
    }
    fn finish_worker(&self, job: &Arc<Job>) {
        if let Ok(mut r) = self.registry.lock() {
            if r.active.get(&job.id).is_some_and(|j| Arc::ptr_eq(j, job)) {
                r.active.remove(&job.id);
            }
        }
    }
    fn finish_caller(&self, job: &Arc<Job>) {
        if let Ok(mut r) = self.registry.lock() {
            if r.owners.get(&job.id).is_some_and(|j| Arc::ptr_eq(j, job)) {
                r.owners.remove(&job.id);
            }
        }
    }
    fn progress(
        &self,
        job: &Arc<Job>,
        processed: u64,
        emit: &mut impl FnMut(HashProgress) -> Result<(), String>,
    ) -> Result<(), String> {
        let result = {
            let _output = job.output_gate.lock().map_err(|_| FAILED)?;
            job.source
                .with_hash_output(|| {
                    self.check_output(job)?;
                    emit(HashProgress {
                        operation_id: job.op.clone(),
                        source_id: job.id.clone(),
                        session_id: job.sid.clone(),
                        processed_bytes: processed,
                        total_bytes: job.source.size,
                    })
                    .map_err(|_| FAILED)?;
                    self.check_output(job)
                })
                .ok_or(FAILED)?
        };
        // Revoke expired/invalid sources only after both output gates are dropped.
        if result.is_err() {
            let _ = job.source.current();
        }
        result
    }
    fn check_output(&self, job: &Arc<Job>) -> Result<(), String> {
        if job.cancelled.load(Ordering::Acquire) {
            return Err(CANCELLED.into());
        }
        if !job.source.current_for_output()
            || !self
                .registry
                .lock()
                .is_ok_and(|r| r.owners.get(&job.id).is_some_and(|j| Arc::ptr_eq(j, job)))
        {
            return Err(CHANGED.into());
        }
        Ok(())
    }

    fn run(
        &self,
        job: &Arc<Job>,
        target: &str,
        mut emit: impl FnMut(HashProgress) -> Result<(), String>,
        mut before_read: impl FnMut(u64, u64),
    ) -> Result<UploadHashes, String> {
        self.check(job)?;
        job.source.verify().map_err(|_| CHANGED)?;
        self.check(job)?;
        let size = job.source.size;
        let mut md5 = Md5::new();
        let mut sha256 = Sha256::new();
        let mut quick = Sha1::new();
        quick.update(size.to_string().as_bytes());
        let mut offset = 0;
        while offset < size {
            self.check(job)?;
            let length = CHUNK.min(size - offset);
            before_read(offset, length);
            self.check(job)?;
            let bytes = job.source.read(offset, length).map_err(|_| CHANGED)?;
            self.check(job)?;
            if bytes.len() as u64 != length {
                return Err(FAILED.into());
            }
            md5.update(&bytes);
            sha256.update(&bytes);
            if size <= 2048 {
                quick.update(&bytes);
            } else {
                if offset < 1024 {
                    quick.update(&bytes[..(length.min(1024 - offset)) as usize]);
                }
                let tail_start = offset.max(size - 1024);
                if tail_start < offset + length {
                    quick.update(&bytes[(tail_start - offset) as usize..]);
                }
            }
            offset += length;
            self.check(job)?;
            if offset < size {
                self.progress(job, offset, &mut emit)?;
            }
        }
        self.check(job)?;
        job.source.verify().map_err(|_| CHANGED)?;
        self.check(job)?;
        let result = UploadHashes {
            size,
            uuid: hex(Sha1::digest(
                format!("{}{}", job.source.last_modified + size, target).as_bytes(),
            )),
            quick_hash: hex(quick.finalize()),
            md5: hex(md5.finalize()),
            sha256: hex(sha256.finalize()),
        };
        self.check(job)?;
        self.progress(job, size, &mut emit)?;
        // Observer failure/cancellation/metadata mutation must not turn into a result.
        job.source.verify().map_err(|_| CHANGED)?;
        self.check(job)?;
        Ok(result)
    }
    async fn accept_result(
        &self,
        job: &Arc<Job>,
        result: UploadHashes,
        guard: WorkerGuard,
    ) -> Result<UploadHashes, String> {
        self.check(job)?;
        let owned = self.clone();
        let ticket = job.clone();
        // Transfer the original worker slot across this final metadata check.
        // A cancelled caller cannot release that slot while verification blocks.
        let worker = tauri::async_runtime::spawn_blocking(move || {
            owned.check(&ticket)?;
            ticket.source.verify().map_err(|_| CHANGED)?;
            owned.check(&ticket)?;
            Ok::<_, String>((result, guard))
        });
        let (result, _guard) = self.await_current(job, worker).await??;
        self.check(job)?;
        Ok(result)
    }
    async fn await_current<T>(
        &self,
        job: &Arc<Job>,
        worker: impl Future<Output = Result<T, tauri::Error>>,
    ) -> Result<T, String> {
        // Polling also covers source/session/TTL revocation without extra observers.
        // Dropping a join on cancellation leaves its bounded worker guard in place.
        let mut worker = std::pin::pin!(worker);
        let mut timer = std::pin::pin!(tokio::time::sleep(Duration::from_millis(10)));
        std::future::poll_fn(|cx| {
            if let Err(e) = self.check(job) {
                return Poll::Ready(Err(e));
            }
            if let Poll::Ready(result) = worker.as_mut().poll(cx) {
                return Poll::Ready(
                    self.check(job)
                        .and_then(|_| result.map_err(|_| FAILED.to_string())),
                );
            }
            if timer.as_mut().poll(cx).is_ready() {
                timer
                    .as_mut()
                    .reset(tokio::time::Instant::now() + Duration::from_millis(10));
                let _ = timer.as_mut().poll(cx);
            }
            Poll::Pending
        })
        .await
    }
}
fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}
fn validate(size: u64, mtime: u64, path: &str) -> Result<(), String> {
    if size > MAX_SAFE || mtime > MAX_SAFE || size.checked_add(mtime).is_none_or(|n| n > MAX_SAFE) {
        return Err(INVALID.into());
    }
    if path.len() > 8192
        || !path.starts_with('/')
        || path.contains('\\')
        || path.chars().any(|c| c.is_control())
        || !path[1..].split('/').all(|c| {
            !c.trim_matches(|ch: char| ch.is_whitespace() || ch == '\u{feff}')
                .is_empty()
                && c != "."
                && c != ".."
                && c.len() <= 255
        })
    {
        return Err("Invalid upload target path".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn nas_upload_hash(
    id: String,
    session_id: String,
    operation_id: String,
    target_path: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, UploadHashState>,
    sources: tauri::State<'_, UploadSourceState>,
) -> Result<UploadHashes, String> {
    let job = state.begin(&sources, &id, &session_id, &operation_id, &target_path)?;
    let _caller = CallerGuard {
        state: state.inner().clone(),
        job: job.clone(),
    };
    let owned = state.inner().clone();
    let ticket = job.clone();
    let guard = WorkerGuard {
        state: owned.clone(),
        job: ticket.clone(),
    };
    let worker = tauri::async_runtime::spawn_blocking(move || {
        let result = owned.run(
            &ticket,
            &target_path,
            |progress| {
                app.emit("nas-upload-hash-progress", progress)
                    .map_err(|_| FAILED.to_string())
            },
            |_, _| {},
        )?;
        Ok::<_, String>((result, guard))
    });
    let (result, guard) = state.await_current(&job, worker).await??;
    state.accept_result(&job, result, guard).await
}
#[tauri::command]
pub fn nas_upload_hash_cancel(
    id: String,
    session_id: String,
    operation_id: String,
    state: tauri::State<'_, UploadHashState>,
) -> Result<(), String> {
    state.cancel(&id, &session_id, &operation_id)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::MediaState;
    use std::{
        fs,
        time::{Duration, UNIX_EPOCH},
    };
    const SID: &str = "synthetic-session";
    const OP: &str = "0123456789abcdef0123456789abcdef";
    const TARGET: &str = "/新目录/资料.txt";
    struct Fixture {
        state: UploadHashState,
        sources: UploadSourceState,
        media: MediaState,
        _dir: tempfile::TempDir,
        path: std::path::PathBuf,
        id: String,
    }
    fn fixture(n: usize) -> Fixture {
        let sources = UploadSourceState::default();
        let media = MediaState::default();
        sources.attach(&media);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("private-source.txt");
        let bytes: Vec<u8> = if n == 3 {
            b"abc".to_vec()
        } else {
            (0..n).map(|i| (i % 251) as u8).collect()
        };
        fs::write(&path, &bytes).unwrap();
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_times(
            fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_millis(1700000000123)),
        )
        .unwrap();
        let source = sources.hash_test_select(&media, path.clone(), SID);
        let id = serde_json::to_value(source).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        Fixture {
            state: UploadHashState::default(),
            sources,
            media,
            _dir: dir,
            path,
            id,
        }
    }
    fn job(f: &Fixture) -> Arc<Job> {
        f.state.begin(&f.sources, &f.id, SID, OP, TARGET).unwrap()
    }
    #[test]
    fn independent_python_vectors_full_and_quick_boundaries() {
        let vectors = [
            (
                0,
                "d41d8cd98f00b204e9800998ecf8427e",
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                "b6589fc6ab0dc82cf12099d1c2d40ab994e8410c",
                "ebe4d3fe294d243b9efe8292866000300d8df522",
            ),
            (
                1,
                "93b885adfe0da089cdf634904fd59f71",
                "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
                "e91fe173f59b063d620a934ce1a010f2b114c1f3",
                "0e47c1ae0b0b7a85d088777f8789ea5409cf39da",
            ),
            (
                3,
                "900150983cd24fb0d6963f7d28e17f72",
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                "849a2d6d722dd7429b22eaad96c44aee92450bb7",
                "24a82a3b2a733f66fb5ccd8c0b00e82af519c4bc",
            ),
            (
                2048,
                "1544ef7a46131a30cf328f55979db73d",
                "b2a8170614e23194ae2951423d601987f518ce2f11205d7b0b708080103b9f76",
                "38279892d34d3ec5f5066259e4c919ee34f33cd2",
                "8d8b22a469d6e6a6c3e6ef6b83789e7bcba88366",
            ),
            (
                2049,
                "cb7fabac9ac9fd2cb4e79a6d12c8308e",
                "26e1e2808e3a6cf967ca03f6749a063c5ed55f92f5874653a1faabed78346f00",
                "41e22fffb471e98bc81424506d8fd49f29c8a8dc",
                "cfdf31ec130cbc5acabb5aec1800c7d13f97c6d6",
            ),
            (
                2097169,
                "a0c528060e3514b6df937c15b8f1d2a8",
                "b057f26faa652e9916aa08eed7e50906151f83de0e878173e9d06e359c0dd75e",
                "fc729edd49a510c5d1d5ac5daf2b8ad1a0407a1c",
                "f40b777fa47fc1076391d91996d6dabb6ed4cfd3",
            ),
            (
                2097664,
                "0b6fcfd5da4b1d887f93149e368d4ed2",
                "c7190d0e848284b5ae882daa22fe8b9272b866d0c74ac322e13b07c78c4c2d09",
                "5eaf0c8d3d214f6192034759149567b366e725fe",
                "c8d2713d0475ded7b63e09b543c9c55944df94b3",
            ),
        ];
        for (n, md5, sha256, quick, uuid) in vectors {
            let f = fixture(n);
            let j = job(&f);
            let mut reads = Vec::new();
            let mut events = Vec::new();
            let out = f
                .state
                .run(
                    &j,
                    TARGET,
                    |p| {
                        events.push(p);
                        Ok(())
                    },
                    |o, l| reads.push((o, l)),
                )
                .unwrap();
            assert_eq!(
                out,
                UploadHashes {
                    size: n as u64,
                    md5: md5.into(),
                    sha256: sha256.into(),
                    quick_hash: quick.into(),
                    uuid: uuid.into()
                }
            );
            assert_eq!(
                reads,
                if n == 0 {
                    vec![]
                } else if n <= CHUNK as usize {
                    vec![(0, n as u64)]
                } else {
                    vec![(0, CHUNK), (CHUNK, n as u64 - CHUNK)]
                }
            );
            assert_eq!(events.last().unwrap().processed_bytes, n as u64);
            assert_eq!(
                events
                    .iter()
                    .filter(|p| p.processed_bytes == n as u64)
                    .count(),
                1
            );
            assert!(events
                .windows(2)
                .all(|p| p[0].processed_bytes < p[1].processed_bytes));
            for event in &events {
                assert_eq!(event.operation_id, OP);
                assert_eq!(event.source_id, f.id);
                assert_eq!(event.session_id, SID);
                assert_eq!(event.total_bytes, n as u64);
                assert!(event.processed_bytes <= event.total_bytes);
                assert_eq!(
                    serde_json::to_value(event)
                        .unwrap()
                        .as_object()
                        .unwrap()
                        .len(),
                    5
                );
            }
            let json = serde_json::to_string(&events).unwrap();
            assert!(
                !json.contains("private-source")
                    && !json.contains("synthetic-cookie")
                    && !json.contains(TARGET)
            );
            assert_eq!(
                serde_json::to_value(&out)
                    .unwrap()
                    .as_object()
                    .unwrap()
                    .len(),
                5
            );
        }
    }
    #[test]
    fn same_ts_path_and_numeric_metadata_contract() {
        for p in ["/a", "/ 新 名 /资料.txt", TARGET] {
            assert!(validate(3, 1700000000123, p).is_ok());
        }
        for p in [
            "",
            "/",
            "relative",
            "//a",
            "/a/",
            "/./a",
            "/../a",
            "/  /a",
            "/a\\b",
            "/\u{feff}/a",
            "/a\u{0085}",
            "/a\0",
        ] {
            assert!(validate(3, 1, p).is_err());
        }
        assert!(validate(1, 9_007_199_254_740_991, "/a").is_err());
        assert!(validate(u64::MAX, 1, "/a").is_err());
        assert!(validate(0, 0, &format!("/{}", "界".repeat(85))).is_ok());
        assert!(validate(0, 0, &format!("/{}", "界".repeat(86))).is_err());
        let p = "/".to_owned() + &vec!["a".repeat(255); 32].join("/");
        assert_eq!(p.len(), 8192);
        assert!(validate(0, 0, &p).is_ok());
        let p =
            "/".to_owned() + &vec!["a".repeat(255); 31].join("/") + "/" + &"a".repeat(254) + "/a";
        assert_eq!(p.len(), 8193);
        assert!(validate(0, 0, &p).is_err());
    }
    #[test]
    fn cancel_matches_exact_job_and_keeps_source() {
        let f = fixture(3);
        let j = job(&f);
        assert!(f.state.cancel(&f.id, "foreign", OP).is_err());
        assert!(f.state.cancel(&f.id, SID, &"f".repeat(32)).is_err());
        assert!(f.state.current(&j));
        f.state.cancel(&f.id, SID, OP).unwrap();
        assert_eq!(
            f.state.run(&j, TARGET, |_| Ok(()), |_, _| {}).unwrap_err(),
            CANCELLED
        );
        assert!(f.sources.hash_source(&f.id, SID).unwrap().verify().is_ok());
        assert!(f
            .media
            .download_session(
                "https://synthetic-nas.example/",
                "token=synthetic-cookie",
                SID
            )
            .is_ok());
    }
    #[test]
    fn bounded_slots_and_single_source_include_cancelled_unfinished_workers() {
        let f = fixture(3);
        let mut jobs = vec![job(&f)];
        assert!(f
            .state
            .begin(&f.sources, &f.id, SID, &"1".repeat(32), TARGET)
            .is_err());
        for _ in 1..4 {
            let src = f.sources.hash_test_select(&f.media, f.path.clone(), SID);
            let id = serde_json::to_value(src).unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            jobs.push(f.state.begin(&f.sources, &id, SID, OP, TARGET).unwrap());
        }
        let src = f.sources.hash_test_select(&f.media, f.path.clone(), SID);
        let id = serde_json::to_value(src).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(f.state.begin(&f.sources, &id, SID, OP, TARGET).is_err());
        f.state.cancel(&f.id, SID, OP).unwrap();
        f.state.finish_caller(&jobs[0]);
        assert!(f.state.begin(&f.sources, &id, SID, OP, TARGET).is_err());
        assert!(f.state.begin(&f.sources, &f.id, SID, OP, TARGET).is_err());
        f.state.finish_worker(&jobs[0]);
        let new = f
            .state
            .begin(&f.sources, &f.id, SID, &"1".repeat(32), TARGET)
            .unwrap();
        f.state.finish_caller(&jobs[0]);
        assert!(f.state.current(&new));
    }
    #[test]
    fn stale_source_release_clear_expiry_and_change_suppress_output() {
        for action in 0..5 {
            let f = fixture(CHUNK as usize + 17);
            let j = job(&f);
            let mut events = 0;
            let e = f
                .state
                .run(
                    &j,
                    TARGET,
                    |_| {
                        events += 1;
                        Ok(())
                    },
                    |_, _| match action {
                        0 => f.sources.hash_test_release(&f.id, SID),
                        1 => f.media.clear(SID).unwrap(),
                        2 => f.sources.hash_test_expire(&f.id, SID),
                        3 => fs::write(&f.path, b"changed").unwrap(),
                        _ => f.sources.clear_all(),
                    },
                )
                .unwrap_err();
            assert!(!e.contains(f.path.to_str().unwrap()));
            assert_eq!(events, 0);
        }
    }
    #[test]
    fn progress_observer_errors_are_static_and_cancel_after_progress_stops_reads() {
        let f = fixture(CHUNK as usize + 17);
        let j = job(&f);
        let mut reads = 0;
        assert_eq!(
            f.state
                .run(
                    &j,
                    TARGET,
                    |_| Err("secret cookie/path/content".into()),
                    |_, _| reads += 1
                )
                .unwrap_err(),
            FAILED
        );
        assert_eq!(reads, 1);
        f.state.finish_worker(&j);
        f.state.finish_caller(&j);
        let j = job(&f);
        reads = 0;
        assert_eq!(
            f.state
                .run(
                    &j,
                    TARGET,
                    |_| {
                        j.cancelled.store(true, Ordering::Release);
                        Ok(())
                    },
                    |_, _| reads += 1
                )
                .unwrap_err(),
            CANCELLED
        );
        assert_eq!(reads, 1);
    }
    #[test]
    fn post_digest_and_post_join_ownership_fences() {
        let f = fixture(3);
        let j = job(&f);
        let out = f.state.run(&j, TARGET, |_| Ok(()), |_, _| {}).unwrap();
        assert_eq!(out.size, 3);
        f.sources.hash_test_expire(&f.id, SID);
        assert!(!f.state.current(&j));
    }
    #[test]
    fn prompt_async_cancel_stalled_worker_late_join_and_new_owner_are_fenced() {
        tauri::async_runtime::block_on(async {
            let f = fixture(3);
            let j = job(&f);
            let (started, rx) = tokio::sync::oneshot::channel();
            let (release, wait) = std::sync::mpsc::channel();
            let state = f.state.clone();
            let ticket = j.clone();
            let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let events = count.clone();
            let guard = WorkerGuard {
                state: state.clone(),
                job: ticket.clone(),
            };
            let worker = tauri::async_runtime::spawn_blocking(move || {
                let _guard = guard;
                let mut started = Some(started);
                state.run(
                    &ticket,
                    TARGET,
                    |_| {
                        events.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    },
                    |_, _| {
                        started.take().unwrap().send(()).unwrap();
                        wait.recv().unwrap();
                    },
                )
            });
            rx.await.unwrap();
            f.state.cancel(&f.id, SID, OP).unwrap();
            let began = std::time::Instant::now();
            assert_eq!(
                f.state.await_current(&j, worker).await.unwrap_err(),
                CANCELLED
            );
            assert!(began.elapsed() < Duration::from_millis(250));
            f.state.finish_caller(&j);
            assert!(f
                .state
                .begin(&f.sources, &f.id, SID, &"1".repeat(32), TARGET)
                .is_err());
            assert_eq!(f.state.registry.lock().unwrap().active.len(), 1);
            release.send(()).unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while !f.state.registry.lock().unwrap().active.is_empty() {
                assert!(std::time::Instant::now() < deadline);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert_eq!(count.load(Ordering::SeqCst), 0);
            let new = f
                .state
                .begin(&f.sources, &f.id, SID, &"1".repeat(32), TARGET)
                .unwrap();
            f.state.finish_worker(&j);
            f.state.finish_caller(&j);
            assert!(f.state.current(&new));
            assert!(f.state.cancel(&f.id, SID, OP).is_err());
            assert!(f.state.current(&new));
            assert!(f.sources.hash_source(&f.id, SID).unwrap().verify().is_ok());
        });
    }
    #[test]
    fn source_revocation_promptly_rejects_stalled_async_worker() {
        for action in 0..4 {
            tauri::async_runtime::block_on(async {
                let f = fixture(3);
                let j = job(&f);
                let (started, rx) = tokio::sync::oneshot::channel();
                let (release, wait) = std::sync::mpsc::channel();
                let state = f.state.clone();
                let ticket = j.clone();
                let guard = WorkerGuard {
                    state: state.clone(),
                    job: ticket.clone(),
                };
                let worker = tauri::async_runtime::spawn_blocking(move || {
                    let _guard = guard;
                    let mut start = Some(started);
                    state.run(
                        &ticket,
                        TARGET,
                        |_| panic!("revoked worker must not emit"),
                        |_, _| {
                            start.take().unwrap().send(()).unwrap();
                            wait.recv().unwrap();
                        },
                    )
                });
                rx.await.unwrap();
                match action {
                    0 => f.sources.hash_test_release(&f.id, SID),
                    1 => f.media.clear(SID).unwrap(),
                    2 => f.sources.hash_test_expire(&f.id, SID),
                    _ => f.sources.clear_all(),
                }
                let now = std::time::Instant::now();
                assert!(f.state.await_current(&j, worker).await.is_err());
                assert!(now.elapsed() < Duration::from_millis(250));
                f.state.finish_caller(&j);
                release.send(()).unwrap();
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                while !f.state.registry.lock().unwrap().active.is_empty() {
                    assert!(std::time::Instant::now() < deadline);
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            });
        }
    }
    #[test]
    fn cancelled_or_expired_late_ready_result_is_not_accepted() {
        tauri::async_runtime::block_on(async {
            for action in 0..3 {
                let f = fixture(3);
                let j = job(&f);
                let out = f.state.run(&j, TARGET, |_| Ok(()), |_, _| {}).unwrap();
                match action {
                    0 => f.state.cancel(&f.id, SID, OP).unwrap(),
                    1 => f.sources.hash_test_expire(&f.id, SID),
                    _ => f.media.clear(SID).unwrap(),
                }
                assert!(f
                    .state
                    .await_current(&j, std::future::ready(Ok(out)))
                    .await
                    .is_err());
            }
        });
    }
    #[test]
    fn digest_terminal_observer_cannot_accept_changed_or_cancelled_source() {
        for n in [0, 3] {
            for action in 0..3 {
                let f = fixture(n);
                let j = job(&f);
                let mut events = 0;
                assert!(f
                    .state
                    .run(
                        &j,
                        TARGET,
                        |p| {
                            events += 1;
                            assert_eq!(p.processed_bytes, n as u64);
                            match action {
                                0 => j.cancelled.store(true, Ordering::Release),
                                1 => fs::write(&f.path, b"changed").unwrap(),
                                _ => f.sources.hash_test_expire(&f.id, SID),
                            };
                            Ok(())
                        },
                        |_, _| {}
                    )
                    .is_err());
                assert_eq!(events, 1);
            }
        }
    }
    #[test]
    fn source_replacement_and_foreign_operation_never_rebind_identity() {
        let f = fixture(3);
        for op in [
            "",
            "F0123456789abcdef0123456789abcdef",
            "f",
            &"f".repeat(33),
        ] {
            assert!(f.state.begin(&f.sources, &f.id, SID, op, TARGET).is_err());
        }
        assert!(f
            .state
            .begin(&f.sources, &f.id, "foreign", OP, TARGET)
            .is_err());
        let j = job(&f);
        fs::rename(&f.path, f._dir.path().join("old-original")).unwrap();
        fs::write(&f.path, b"xyz").unwrap();
        assert!(f
            .state
            .run(
                &j,
                TARGET,
                |_| panic!("changed source must not emit"),
                |_, _| {}
            )
            .is_err());
        f.state.finish_worker(&j);
        f.state.finish_caller(&j);
        let new = f
            .sources
            .hash_test_select(&f.media, f.path.clone(), "new-session");
        let id = serde_json::to_value(new).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let fresh = f
            .state
            .begin(&f.sources, &id, "new-session", OP, TARGET)
            .unwrap();
        f.state.finish_worker(&j);
        f.state.finish_caller(&j);
        assert!(f.state.current(&fresh));
    }

    #[test]
    fn changed_source_between_digest_and_async_accept_is_rejected() {
        tauri::async_runtime::block_on(async {
            let f = fixture(3);
            let j = job(&f);
            let out = f.state.run(&j, TARGET, |_| Ok(()), |_, _| {}).unwrap();
            fs::write(&f.path, b"xyz").unwrap();
            let guard = WorkerGuard {
                state: f.state.clone(),
                job: j.clone(),
            };
            assert!(f.state.accept_result(&j, out, guard).await.is_err());
        });
    }

    #[test]
    fn cancellation_wakes_an_already_pending_async_wait() {
        tauri::async_runtime::block_on(async {
            let f = fixture(3);
            let j = job(&f);
            let state = f.state.clone();
            let id = f.id.clone();
            let cancel = tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(30)).await;
                state.cancel(&id, SID, OP).unwrap();
            });
            let result = tokio::time::timeout(
                Duration::from_millis(250),
                f.state
                    .await_current(&j, std::future::pending::<Result<(), tauri::Error>>()),
            )
            .await;
            cancel.await.unwrap();
            assert_eq!(
                result
                    .expect("pending cancelled join must not wait for IO")
                    .unwrap_err(),
                CANCELLED
            );
        });
    }

    #[test]
    fn exact_cancel_linearizes_against_inflight_emission_without_global_lock() {
        let f = fixture(3);
        let j = job(&f);
        let state = f.state.clone();
        let ticket = j.clone();
        let (started, rx) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            state.run(
                &ticket,
                TARGET,
                |_| {
                    started.send(()).unwrap();
                    wait.recv().unwrap();
                    Ok(())
                },
                |_, _| {},
            )
        });
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let state = f.state.clone();
        let id = f.id.clone();
        let (began, begin) = std::sync::mpsc::channel();
        let (finished, finish) = std::sync::mpsc::channel();
        let canceller = std::thread::spawn(move || {
            began.send(()).unwrap();
            state.cancel(&id, SID, OP).unwrap();
            finished.send(()).unwrap();
        });
        begin.recv().unwrap();
        let returned_while_emitting = finish.recv_timeout(Duration::from_millis(50)).is_ok();
        // Other registry/source operations remain independent while emit is blocked.
        assert!(f.sources.hash_source(&f.id, SID).unwrap().current());
        release.send(()).unwrap();
        let result = worker.join().unwrap();
        canceller.join().unwrap();
        assert!(
            !returned_while_emitting,
            "cancel must not return ahead of an event it revokes"
        );
        assert!(result.is_err() || !f.state.current(&j));
    }
    #[test]
    fn successful_final_async_accept_preserves_bytes_and_releases_worker_slot() {
        tauri::async_runtime::block_on(async {
            let f = fixture(3);
            let j = job(&f);
            let before = fs::metadata(&f.path).unwrap().modified().unwrap();
            let out = f.state.run(&j, TARGET, |_| Ok(()), |_, _| {}).unwrap();
            let guard = WorkerGuard {
                state: f.state.clone(),
                job: j.clone(),
            };
            let accepted = f.state.accept_result(&j, out, guard).await.unwrap();
            assert_eq!(accepted.md5, "900150983cd24fb0d6963f7d28e17f72");
            assert!(f.state.registry.lock().unwrap().active.is_empty());
            f.state.finish_caller(&j);
            assert!(f.state.registry.lock().unwrap().owners.is_empty());
            assert_eq!(
                f.sources
                    .hash_source(&f.id, SID)
                    .unwrap()
                    .read(0, 3)
                    .unwrap(),
                b"abc"
            );
            assert_eq!(fs::read(&f.path).unwrap(), b"abc");
            assert_eq!(fs::metadata(&f.path).unwrap().modified().unwrap(), before);
        });
    }
    fn blocked_emit_revocation(action: u8) {
        let f = fixture(3);
        let j = job(&f);
        let state = f.state.clone();
        let ticket = j.clone();
        let (started, rx) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let (hold_slot, slot_wait) = std::sync::mpsc::channel();
        let (worker_finished, finished) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _guard = WorkerGuard {
                state: state.clone(),
                job: ticket.clone(),
            };
            let result = state.run(
                &ticket,
                TARGET,
                |_| {
                    started.send(()).unwrap();
                    wait.recv().unwrap();
                    Ok(())
                },
                |_, _| {},
            );
            worker_finished.send(result.is_err()).unwrap();
            slot_wait.recv().unwrap();
            result
        });
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let unrelated = f
            .sources
            .hash_test_select(&f.media, f.path.clone(), "unrelated-session");
        let other_id = serde_json::to_value(unrelated).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let other = f
            .sources
            .hash_source(&other_id, "unrelated-session")
            .unwrap();
        let source = f.sources.clone();
        let media = f.media.clone();
        let state = f.state.clone();
        let ticket = j.clone();
        let id = f.id.clone();
        let (began, begin) = std::sync::mpsc::channel();
        let (revoked, done) = std::sync::mpsc::channel();
        let revoker = std::thread::spawn(move || {
            began.send(()).unwrap();
            match action {
                0 => drop(CallerGuard { state, job: ticket }),
                1 => source.hash_test_release(&id, SID),
                2 => media.clear(SID).unwrap(),
                _ => source.clear_all(),
            }
            revoked.send(()).unwrap();
        });
        begin.recv().unwrap();
        let returned_before_publication = done.recv_timeout(Duration::from_millis(50)).is_ok();
        assert_eq!(f.state.registry.lock().unwrap().active.len(), 1);
        // Neither registry is held by a revocation waiting for synchronous output.
        if action != 3 {
            assert!(other.current());
        }
        assert!(f.sources.registry_count_for_hash_test() <= 2);
        release.send(()).unwrap();
        revoker.join().unwrap();
        assert!(finished.recv_timeout(Duration::from_secs(2)).unwrap());
        assert_eq!(f.state.registry.lock().unwrap().active.len(), 1);
        assert!(!f.state.current(&j));
        hold_slot.send(()).unwrap();
        assert!(worker.join().unwrap().is_err());
        assert!(f.state.registry.lock().unwrap().active.is_empty());
        assert!(
            !returned_before_publication,
            "revocation returned before old native emission finished"
        );
    }
    #[test]
    fn caller_guard_drop_orders_already_entered_emission() {
        blocked_emit_revocation(0);
    }
    #[test]
    fn selected_source_release_orders_already_entered_emission() {
        blocked_emit_revocation(1);
    }
    #[test]
    fn media_session_clear_orders_already_entered_emission() {
        blocked_emit_revocation(2);
    }
    #[test]
    fn native_exit_orders_already_entered_emission() {
        blocked_emit_revocation(3);
    }
    #[test]
    fn actual_caller_drop_stalled_io_is_prompt_and_keeps_worker_slot() {
        let f = fixture(3);
        let j = job(&f);
        let state = f.state.clone();
        let ticket = j.clone();
        let (started, rx) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _guard = WorkerGuard {
                state: state.clone(),
                job: ticket.clone(),
            };
            state.run(
                &ticket,
                TARGET,
                |_| panic!("dropped caller must not emit"),
                |_, _| {
                    started.send(()).unwrap();
                    wait.recv().unwrap();
                },
            )
        });
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let now = std::time::Instant::now();
        drop(CallerGuard {
            state: f.state.clone(),
            job: j.clone(),
        });
        assert!(now.elapsed() < Duration::from_millis(250));
        assert!(f.state.registry.lock().unwrap().owners.is_empty());
        assert_eq!(f.state.registry.lock().unwrap().active.len(), 1);
        assert!(f
            .state
            .begin(&f.sources, &f.id, SID, &"1".repeat(32), TARGET)
            .is_err());
        assert!(f.sources.hash_source(&f.id, SID).unwrap().verify().is_ok());
        release.send(()).unwrap();
        assert_eq!(worker.join().unwrap().unwrap_err(), CANCELLED);
        assert!(f.state.registry.lock().unwrap().active.is_empty());
        let fresh = f
            .state
            .begin(&f.sources, &f.id, SID, &"1".repeat(32), TARGET)
            .unwrap();
        f.state.finish_caller(&j);
        f.state.finish_worker(&j);
        assert!(f.state.current(&fresh));
    }
}
