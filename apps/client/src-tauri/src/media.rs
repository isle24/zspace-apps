//! Native renderer media transport. NAS URLs and normal-session cookies never
//! appear in a DOM URL; this module opens no listener and exposes no NAS API.
use std::{
    collections::{HashMap, HashSet},
    future::{poll_fn, Future},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
    task::Poll,
    time::{Duration, Instant},
};
use tauri::{
    http::{Request, Response},
    Emitter, Manager,
};
use tauri_plugin_http::reqwest::{self, Client, Url};

const REF_TTL: Duration = Duration::from_secs(8 * 60 * 60);
const REF_LIMIT: usize = 4096;
const CLOSED_LIMIT: usize = 8192;
const REQUEST_LIMIT: usize = 8;

pub(crate) struct Session {
    base: Url,
    pub(crate) cookie: String,
    secrets: Vec<String>,
    pub(crate) cancelled: AtomicBool,
    file_leases: AtomicUsize,
}
pub(crate) struct DownloadLease {
    pub(crate) session: Arc<Session>,
}
impl Drop for DownloadLease {
    fn drop(&mut self) {
        self.session.file_leases.fetch_sub(1, Ordering::AcqRel);
    }
}
#[derive(Clone)]
struct MediaRef {
    source: Url,
    session_id: String,
    session: Arc<Session>,
    expires: Instant,
}
#[derive(Default)]
struct Registry {
    refs: HashMap<String, MediaRef>,
    sessions: HashMap<String, Arc<Session>>,
    closed: HashSet<String>,
    closed_full: bool,
}
impl Registry {
    fn purge(&mut self) {
        let now = Instant::now();
        self.refs.retain(|_, entry| {
            entry.expires > now && !entry.session.cancelled.load(Ordering::Acquire)
        });
        let used: HashSet<String> = self
            .refs
            .values()
            .map(|entry| entry.session_id.clone())
            .collect();
        self.sessions.retain(|id, session| {
            let keep = used.contains(id) || session.file_leases.load(Ordering::Acquire) > 0;
            if !keep {
                session.cancelled.store(true, Ordering::Release);
            }
            keep
        });
    }
}

#[derive(Clone, Default)]
pub struct MediaState {
    registry: Arc<Mutex<Registry>>,
    client: Arc<OnceLock<Result<Client, &'static str>>>,
    pending: Arc<AtomicUsize>,
    auth_expired: Arc<OnceLock<Arc<dyn Fn(&str) + Send + Sync>>>,
    revoked: Arc<OnceLock<Arc<dyn Fn(&str) + Send + Sync>>>,
}

impl MediaState {
    pub(crate) fn set_revoked_notifier(&self, notifier: Arc<dyn Fn(&str) + Send + Sync>) {
        let _ = self.revoked.set(notifier);
    }
    fn set_auth_expired_notifier(&self, notifier: Arc<dyn Fn(&str) + Send + Sync>) {
        let _ = self.auth_expired.set(notifier);
    }
    pub(crate) fn expire_auth(&self, session_id: &str) {
        // Only an upstream auth response terminates/announces a live session.
        // Explicit logout, ref TTL and duplicate responses never emit expiry.
        let notify = self.registry.lock().is_ok_and(|registry| {
            registry
                .sessions
                .get(session_id)
                .is_some_and(|session| !session.cancelled.swap(true, Ordering::AcqRel))
        });
        let _ = self.clear(session_id);
        if notify {
            if let Some(notifier) = self.auth_expired.get() {
                notifier(session_id);
            }
        }
    }

    // A dedicated lease keeps a download-only or running-transfer session alive
    // through media-reference TTL purge. Explicit clear/auth expiry still cancels.
    pub(crate) fn download_session(
        &self,
        base: &str,
        cookie: &str,
        session_id: &str,
    ) -> Result<DownloadLease, String> {
        valid_session_id(session_id)?;
        let base = Url::parse(base).map_err(|_| "NAS 地址无效")?;
        let secrets = guarded_cookie(cookie)?;
        let mut registry = self.registry.lock().map_err(|_| "媒体状态不可用")?;
        registry.purge();
        if registry.closed_full || registry.closed.contains(session_id) {
            return Err("NAS 会话已结束，请重新登录".into());
        }
        if registry.sessions.len() >= REF_LIMIT {
            return Err("NAS 会话已达上限".into());
        }
        let session = match registry.sessions.get(session_id) {
            Some(session)
                if session.base != base
                    || session.cookie != cookie
                    || session.cancelled.load(Ordering::Acquire) =>
            {
                return Err("NAS 会话与当前连接不匹配".into())
            }
            Some(session) => session.clone(),
            None => {
                let session = Arc::new(Session {
                    base,
                    cookie: cookie.to_owned(),
                    secrets,
                    cancelled: AtomicBool::new(false),
                    file_leases: AtomicUsize::new(0),
                });
                registry
                    .sessions
                    .insert(session_id.to_owned(), session.clone());
                session
            }
        };
        session.file_leases.fetch_add(1, Ordering::AcqRel);
        Ok(DownloadLease { session })
    }
    pub(crate) fn register(
        &self,
        base: &str,
        source: &str,
        cookie: &str,
        session_id: &str,
    ) -> Result<String, String> {
        valid_session_id(session_id)?;
        let source = guarded_source(base, source)?;
        let base = Url::parse(base).map_err(|_| "NAS 地址无效")?;
        let mut secrets = guarded_cookie(cookie)?;
        for (key, value) in source.query_pairs() {
            let key = key.to_ascii_lowercase();
            if [
                "token",
                "password",
                "secret",
                "authorization",
                "cookie",
                "sign",
                "key",
            ]
            .iter()
            .any(|part| key.contains(part))
                && !value.is_empty()
            {
                secrets.push(value.into_owned());
            }
        }
        let mut registry = self.registry.lock().map_err(|_| "媒体状态不可用")?;
        let now = Instant::now();
        registry.purge();
        if registry.closed_full || registry.closed.contains(session_id) {
            return Err("媒体会话已结束，请重新登录".into());
        }
        if registry.refs.len() >= REF_LIMIT {
            return Err("媒体引用已达上限，请重新登录后刷新".into());
        }
        let session = match registry.sessions.get(session_id) {
            Some(session) if session.base != base || session.cookie != cookie => {
                return Err("媒体会话与当前 NAS 不匹配".into())
            }
            Some(session) => session.clone(),
            None => {
                let session = Arc::new(Session {
                    base,
                    cookie: cookie.to_owned(),
                    secrets,
                    cancelled: AtomicBool::new(false),
                    file_leases: AtomicUsize::new(0),
                });
                registry
                    .sessions
                    .insert(session_id.to_owned(), session.clone());
                session
            }
        };
        // Source query credentials may differ from the cookie encoding. Keep
        // each ref's source private; response checking also covers query values.
        let mut id = [0u8; 32];
        getrandom::fill(&mut id).map_err(|_| "无法创建媒体引用")?;
        let id: String = id.iter().map(|byte| format!("{byte:02x}")).collect();
        registry.refs.insert(
            id.clone(),
            MediaRef {
                source,
                session_id: session_id.to_owned(),
                session,
                expires: now + REF_TTL,
            },
        );
        #[cfg(any(target_os = "windows", target_os = "android"))]
        return Ok(format!("http://nas-media.localhost/{id}"));
        #[cfg(not(any(target_os = "windows", target_os = "android")))]
        Ok(format!("nas-media://localhost/{id}"))
    }

    pub(crate) fn clear(&self, session_id: &str) -> Result<(), String> {
        valid_session_id(session_id)?;
        let mut registry = self.registry.lock().map_err(|_| "媒体状态不可用")?;
        if let Some(session) = registry.sessions.remove(session_id) {
            session.cancelled.store(true, Ordering::Release);
        }
        registry
            .refs
            .retain(|_, entry| entry.session_id != session_id);
        if registry.closed.len() < CLOSED_LIMIT {
            registry.closed.insert(session_id.to_owned());
        } else {
            registry.closed_full = true;
        }
        // Notify outside the media lock: source cleanup drops file-session leases.
        drop(registry);
        if let Some(notifier) = self.revoked.get() {
            notifier(session_id);
        }
        Ok(())
    }

    fn lookup(&self, request: &Request<Vec<u8>>) -> Result<MediaRef, MediaFailure> {
        if !matches!(request.method().as_str(), "GET" | "HEAD") || !request.body().is_empty() {
            return Err(MediaFailure(405, "只允许只读媒体请求"));
        }
        if ["Cookie", "Authorization", "token"]
            .iter()
            .any(|name| request.headers().contains_key(*name))
        {
            return Err(MediaFailure(400, "媒体请求包含不受支持的认证头"));
        }
        let uri = request.uri();
        let scheme = uri.scheme_str().unwrap_or("");
        let host = uri.host().unwrap_or("");
        if !((scheme == "nas-media" && host == "localhost")
            || (matches!(scheme, "http" | "https") && host == "nas-media.localhost"))
            || !matches!(
                uri.authority().map(|value| value.as_str()),
                Some("localhost" | "nas-media.localhost")
            )
            || uri.port_u16().is_some()
            || uri.query().is_some()
        {
            return Err(MediaFailure(400, "媒体引用无效"));
        }
        let id = uri
            .path()
            .strip_prefix('/')
            .ok_or(MediaFailure(400, "媒体引用无效"))?;
        if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(MediaFailure(400, "媒体引用无效"));
        }
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| MediaFailure(503, "媒体状态不可用"))?;
        registry.purge();
        registry
            .refs
            .get(id)
            .cloned()
            .ok_or(MediaFailure(401, "媒体会话已过期，请刷新列表"))
    }

    async fn serve(&self, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        let head = request.method() == "HEAD";
        let result = match self.lookup(&request) {
            Ok(reference) => {
                let permit =
                    self.pending
                        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                            (value < REQUEST_LIMIT).then_some(value + 1)
                        });
                if permit.is_err() {
                    return failure_response(MediaFailure(429, "媒体请求繁忙，请稍后重试"), head);
                }
                let _permit = RequestPermit(self.pending.clone());
                let timeout = if complete_image_request(&reference, &request) {
                    125
                } else {
                    35
                };
                match tokio::time::timeout(
                    Duration::from_secs(timeout),
                    self.read(reference, request),
                )
                .await
                {
                    Ok(result) => result,
                    Err(_) => Err(MediaFailure(504, "NAS 媒体读取超时")),
                }
            }
            Err(error) => Err(error),
        };
        result.unwrap_or_else(|error| failure_response(error, head))
    }

    async fn read(
        &self,
        reference: MediaRef,
        request: Request<Vec<u8>>,
    ) -> Result<Response<Vec<u8>>, MediaFailure> {
        let client = self
            .client
            .get_or_init(|| {
                Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .connect_timeout(Duration::from_secs(15))
                    .timeout(Duration::from_secs(30))
                    .referer(false)
                    .no_gzip()
                    .no_brotli()
                    .no_deflate()
                    .no_zstd()
                    .build()
                    .map_err(|_| "媒体网络初始化失败")
            })
            .as_ref()
            .map_err(|message| MediaFailure(503, message))?;
        let session = &reference.session;
        let raw_range = request
            .headers()
            .get("Range")
            .map(|v| v.to_str())
            .transpose()
            .map_err(|_| MediaFailure(400, "媒体范围无效"))?;
        let range = bounded_range(raw_range).map_err(|message| MediaFailure(416, message))?;
        let head = request.method() == "HEAD";
        let mut secrets = session.secrets.clone();
        for (key, value) in reference.source.query_pairs() {
            if [
                "token",
                "password",
                "secret",
                "authorization",
                "cookie",
                "sign",
                "key",
            ]
            .iter()
            .any(|part| key.to_ascii_lowercase().contains(part))
                && !value.is_empty()
            {
                secrets.push(value.into_owned());
            }
        }
        if complete_image_request(&reference, &request) {
            return self.read_complete_image(client, &reference, &secrets).await;
        }
        let mut verified_mime = None;
        // A range can begin beyond an HLS/JSON header. Always verify byte zero
        // independently before fetching the requested offset or exposing HEAD.
        if raw_range.is_some() || head {
            let mut probe = active_await(
                client
                    .get(reference.source.clone())
                    .header("Cookie", &session.cookie)
                    .header("Accept-Encoding", "identity")
                    .header("Range", "bytes=0-511")
                    .timeout(Duration::from_secs(15))
                    .send(),
                session,
            )
            .await?;
            accepted_status(probe.status().as_u16(), self, &reference.session_id)?;
            if probe.status().as_u16() == 206 {
                let parsed = content_range(
                    probe
                        .headers()
                        .get("Content-Range")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or(""),
                )?;
                if parsed.first != 0 || parsed.last > 511 {
                    return Err(MediaFailure(502, "NAS 未返回媒体开头范围"));
                }
            }
            let mime = content_type(probe.headers());
            let prefix = read_prefix(&mut probe, session).await?;
            verified_mime = Some(
                classify_prefix(&mime, &prefix, &secrets)
                    .map_err(|message| MediaFailure(415, message))?,
            );
        }
        let method = if head {
            reqwest::Method::HEAD
        } else {
            reqwest::Method::GET
        };
        let mut pending = client
            .request(method, reference.source.clone())
            .header("Cookie", &session.cookie)
            .header("Accept-Encoding", "identity");
        if !head {
            pending = pending.header("Range", &range);
        }
        let mut upstream = active_await(pending.send(), session).await?;
        let status = upstream.status().as_u16();
        if status == 416 {
            let mut reply = media_response(416, "application/octet-stream", Vec::new());
            if let Some(value) = upstream
                .headers()
                .get("Content-Range")
                .and_then(|v| v.to_str().ok())
            {
                if value
                    .strip_prefix("bytes */")
                    .is_some_and(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
                {
                    reply.headers_mut().insert(
                        "Content-Range",
                        value
                            .parse()
                            .map_err(|_| MediaFailure(502, "媒体范围响应无效"))?,
                    );
                }
            }
            return Ok(reply);
        }
        accepted_status(status, self, &reference.session_id)?;
        let parsed_range = if status == 206 {
            Some(content_range(
                upstream
                    .headers()
                    .get("Content-Range")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or(""),
            )?)
        } else {
            None
        };
        if let Some(parsed) = &parsed_range {
            validate_content_range(parsed, &range)?;
        } else if raw_range.is_some() && !head {
            return Err(MediaFailure(502, "NAS 未提供请求的媒体范围"));
        }
        let declared_len = upstream
            .headers()
            .get("Content-Length")
            .map(|v| v.to_str().ok().and_then(|v| v.parse::<u64>().ok()))
            .transpose_option()?;
        if !head && declared_len.is_some_and(|value| value > CHUNK_LIMIT as u64) {
            return Err(MediaFailure(502, "NAS 媒体响应超过单次范围上限"));
        }
        let headers = upstream.headers().clone();
        let mime = content_type(&headers);
        let body = if head {
            Vec::new()
        } else {
            read_body(&mut upstream, session, CHUNK_LIMIT).await?
        };
        if session.cancelled.load(Ordering::Acquire) {
            return Err(MediaFailure(401, "媒体会话已结束"));
        }
        if !head {
            if declared_len.is_some_and(|len| len != body.len() as u64)
                || parsed_range
                    .as_ref()
                    .is_some_and(|r| r.last - r.first + 1 != body.len() as u64)
            {
                return Err(MediaFailure(502, "NAS 媒体范围长度无效"));
            }
            let prefix = &body[..body.len().min(512)];
            // A nonzero offset begins inside compressed or PCM bytes. Only a
            // textual descriptor may be recognized by its opening punctuation;
            // byte-zero responses retain the stricter original media check.
            let offset = parsed_range.as_ref().is_some_and(|range| range.first > 0);
            if (unsafe_marker(prefix) && (!offset || textual_prefix(prefix)))
                || contains_secret(&body, &secrets)
            {
                return Err(MediaFailure(415, "NAS 返回了媒体描述，无法直接播放"));
            }
        }
        let resolved_mime = if let Some(verified) = verified_mime {
            if !mime.is_empty() && !passive_mime(&mime) {
                return Err(MediaFailure(415, "NAS 返回的内容不是可直接播放的媒体"));
            }
            if mime.is_empty() {
                verified
            } else {
                mime
            }
        } else {
            classify_prefix(&mime, &body[..body.len().min(512)], &secrets)
                .map_err(|message| MediaFailure(415, message))?
        };
        let mut reply = media_response(status, &resolved_mime, body);
        for name in ["Content-Range", "ETag", "Last-Modified"] {
            if let Some(value) = headers.get(name) {
                if !contains_secret(value.as_bytes(), &secrets) {
                    reply.headers_mut().insert(
                        tauri::http::HeaderName::from_bytes(name.as_bytes())
                            .map_err(|_| MediaFailure(502, "媒体响应头无效"))?,
                        value.clone(),
                    );
                }
            }
        }
        if head {
            if let Some(value) = declared_len {
                reply.headers_mut().insert(
                    "Content-Length",
                    value
                        .to_string()
                        .parse()
                        .map_err(|_| MediaFailure(502, "媒体长度无效"))?,
                );
            }
        }
        if parsed_range.is_some() || headers.get("Accept-Ranges").is_some_and(|v| v == "bytes") {
            reply.headers_mut().insert(
                "Accept-Ranges",
                tauri::http::HeaderValue::from_static("bytes"),
            );
        }
        Ok(reply)
    }

    async fn read_complete_image(
        &self,
        client: &Client,
        reference: &MediaRef,
        secrets: &[String],
    ) -> Result<Response<Vec<u8>>, MediaFailure> {
        let session = &reference.session;
        // A renderer image GET requires the whole image, not a synthetic video chunk.
        let mut upstream = active_await(
            client
                .get(reference.source.clone())
                .header("Cookie", &session.cookie)
                .header("Accept-Encoding", "identity")
                .timeout(Duration::from_secs(120))
                .send(),
            session,
        )
        .await?;
        let status = upstream.status().as_u16();
        accepted_status(status, self, &reference.session_id)?;
        let headers = upstream.headers().clone();
        let declared = headers
            .get("Content-Length")
            .map(|v| v.to_str().ok().and_then(|v| v.parse::<u64>().ok()))
            .transpose_option()?;
        if declared.is_some_and(|size| size > IMAGE_LIMIT as u64) {
            return Err(MediaFailure(413, "图片预览超过 64 MiB 上限"));
        }
        let range = match headers.get("Content-Range") {
            Some(value) => Some(content_range_limited(
                value
                    .to_str()
                    .map_err(|_| MediaFailure(502, "图片范围响应无效"))?,
                IMAGE_LIMIT,
            )?),
            None if status == 206 => return Err(MediaFailure(502, "NAS 未返回完整图片范围")),
            None => None,
        };
        if let Some(range) = &range {
            if range.total > IMAGE_LIMIT as u64 {
                return Err(MediaFailure(413, "图片预览超过 64 MiB 上限"));
            }
            if range.first != 0 || range.last + 1 != range.total {
                return Err(MediaFailure(502, "NAS 未返回完整图片范围"));
            }
        }
        let mime = content_type(&headers);
        if !mime.is_empty()
            && mime != "application/octet-stream"
            && !matches!(
                mime.as_str(),
                "image/jpeg"
                    | "image/png"
                    | "image/gif"
                    | "image/webp"
                    | "image/bmp"
                    | "image/tiff"
                    | "image/avif"
                    | "image/heic"
                    | "image/heif"
            )
        {
            return Err(MediaFailure(415, "NAS 返回的内容不是受支持的图片"));
        }
        let body = read_body(&mut upstream, session, IMAGE_LIMIT).await?;
        if session.cancelled.load(Ordering::Acquire) {
            return Err(MediaFailure(401, "媒体会话已结束"));
        }
        if declared.is_some_and(|size| size != body.len() as u64)
            || range.as_ref().is_some_and(|r| r.total != body.len() as u64)
        {
            return Err(MediaFailure(502, "NAS 图片长度不完整"));
        }
        let image_type =
            image_mime(&body).ok_or(MediaFailure(415, "NAS 返回的内容不是受支持的图片"))?;
        if contains_secret(&body, secrets) {
            return Err(MediaFailure(415, "NAS 返回的图片包含不受支持的认证内容"));
        }
        // Normalize a validated whole 206 to a complete 200 image response.
        let mut reply = media_response(200, image_type, body);
        for name in ["ETag", "Last-Modified"] {
            if let Some(value) = headers.get(name) {
                if !contains_secret(value.as_bytes(), secrets) {
                    reply.headers_mut().insert(
                        tauri::http::HeaderName::from_bytes(name.as_bytes())
                            .map_err(|_| MediaFailure(502, "图片响应头无效"))?,
                        value.clone(),
                    );
                }
            }
        }
        Ok(reply)
    }
}

pub fn attach<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .manage(MediaState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            app.state::<MediaState>()
                .set_auth_expired_notifier(Arc::new(move |session_id| {
                    let _ = handle.emit("nas-media-session-expired", session_id);
                }));
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("nas-media", |context, request, responder| {
            let state = context.app_handle().state::<MediaState>().inner().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(state.serve(request).await);
            });
        })
}

#[tauri::command]
pub fn nas_media_register(
    base_url: String,
    source_url: String,
    cookie: String,
    session_id: String,
    state: tauri::State<'_, MediaState>,
) -> Result<String, String> {
    state.register(&base_url, &source_url, &cookie, &session_id)
}

#[tauri::command]
pub fn nas_media_clear(
    session_id: String,
    state: tauri::State<'_, MediaState>,
) -> Result<(), String> {
    state.clear(&session_id)
}

pub(crate) fn valid_session_id(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
    {
        return Err("媒体会话标识无效");
    }
    Ok(())
}
struct MediaFailure(u16, &'static str);
struct RequestPermit(Arc<AtomicUsize>);
impl Drop for RequestPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

async fn active_await<T>(
    future: impl Future<Output = Result<T, reqwest::Error>>,
    session: &Session,
) -> Result<T, MediaFailure> {
    let mut future = std::pin::pin!(future);
    let mut interval = tokio::time::interval(Duration::from_millis(50));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    poll_fn(|context| {
        if session.cancelled.load(Ordering::Acquire) {
            return Poll::Ready(Err(MediaFailure(401, "媒体会话已结束")));
        }
        if let Poll::Ready(result) = future.as_mut().poll(context) {
            return Poll::Ready(result.map_err(|_| MediaFailure(502, "无法读取 NAS 媒体")));
        }
        while interval.poll_tick(context).is_ready() {}
        Poll::Pending
    })
    .await
}

fn accepted_status(status: u16, state: &MediaState, session_id: &str) -> Result<(), MediaFailure> {
    if status == 401 || status == 403 {
        state.expire_auth(session_id);
        return Err(MediaFailure(401, "NAS 会话已过期，请重新登录"));
    }
    if status != 200 && status != 206 {
        return Err(MediaFailure(502, "NAS 无法提供此媒体"));
    }
    Ok(())
}

fn content_type(headers: &reqwest::header::HeaderMap) -> String {
    headers
        .get("Content-Type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}
struct ContentRange {
    first: u64,
    last: u64,
    total: u64,
}
fn content_range(raw: &str) -> Result<ContentRange, MediaFailure> {
    content_range_limited(raw, CHUNK_LIMIT)
}
fn content_range_limited(raw: &str, limit: usize) -> Result<ContentRange, MediaFailure> {
    let parse = |value: &str| {
        value
            .parse::<u64>()
            .map_err(|_| MediaFailure(502, "媒体范围响应无效"))
    };
    let (span, total) = raw
        .strip_prefix("bytes ")
        .and_then(|v| v.split_once('/'))
        .ok_or(MediaFailure(502, "媒体范围响应无效"))?;
    let (first, last) = span
        .split_once('-')
        .ok_or(MediaFailure(502, "媒体范围响应无效"))?;
    let (first, last, total) = (parse(first)?, parse(last)?, parse(total)?);
    if first > last || last >= total || last - first >= limit as u64 {
        return Err(MediaFailure(502, "媒体范围响应无效"));
    }
    Ok(ContentRange { first, last, total })
}
fn validate_content_range(value: &ContentRange, requested: &str) -> Result<(), MediaFailure> {
    let (first, last) = requested[6..]
        .split_once('-')
        .ok_or(MediaFailure(502, "媒体范围响应无效"))?;
    let valid = if first.is_empty() {
        let len = last
            .parse::<u64>()
            .map_err(|_| MediaFailure(502, "媒体范围响应无效"))?;
        value.first == value.total.saturating_sub(len) && value.last == value.total - 1
    } else {
        let first = first
            .parse::<u64>()
            .map_err(|_| MediaFailure(502, "媒体范围响应无效"))?;
        let last = last
            .parse::<u64>()
            .map_err(|_| MediaFailure(502, "媒体范围响应无效"))?;
        value.first == first && value.last <= last
    };
    if valid {
        Ok(())
    } else {
        Err(MediaFailure(502, "NAS 未返回请求的媒体范围"))
    }
}

trait TransposeOption {
    fn transpose_option(self) -> Result<Option<u64>, MediaFailure>;
}
impl TransposeOption for Option<Option<u64>> {
    fn transpose_option(self) -> Result<Option<u64>, MediaFailure> {
        match self {
            Some(Some(value)) => Ok(Some(value)),
            Some(None) => Err(MediaFailure(502, "媒体长度无效")),
            None => Ok(None),
        }
    }
}
async fn read_prefix(
    response: &mut reqwest::Response,
    session: &Session,
) -> Result<Vec<u8>, MediaFailure> {
    let mut body = Vec::with_capacity(512);
    while body.len() < 512 {
        match active_await(response.chunk(), session).await? {
            Some(chunk) => body.extend_from_slice(&chunk[..chunk.len().min(512 - body.len())]),
            None => break,
        }
    }
    Ok(body)
}
async fn read_body(
    response: &mut reqwest::Response,
    session: &Session,
    limit: usize,
) -> Result<Vec<u8>, MediaFailure> {
    let mut body = Vec::new();
    while let Some(chunk) = active_await(response.chunk(), session).await? {
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(if limit == IMAGE_LIMIT {
                MediaFailure(413, "图片预览超过 64 MiB 上限")
            } else {
                MediaFailure(502, "NAS 媒体响应超过单次范围上限")
            });
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
fn media_response(status: u16, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Content-Length", body.len())
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}
fn failure_response(error: MediaFailure, head: bool) -> Response<Vec<u8>> {
    let body = if head {
        Vec::new()
    } else {
        error.1.as_bytes().to_vec()
    };
    let mut response = media_response(error.0, "text/plain; charset=utf-8", body);
    if error.0 == 405 {
        response
            .headers_mut()
            .insert("Allow", tauri::http::HeaderValue::from_static("GET, HEAD"));
    }
    response
}

const CHUNK_LIMIT: usize = 8 * 1024 * 1024;
const IMAGE_LIMIT: usize = 64 * 1024 * 1024;
fn complete_image_request(reference: &MediaRef, request: &Request<Vec<u8>>) -> bool {
    request.method() == "GET"
        && !request.headers().contains_key("Range")
        && matches!(
            reference.source.path(),
            "/transcode/thumb" | "/transcode/decrypt/thumb"
        )
}
fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[255, 216, 255]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        return Some("image/png");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        return Some("image/tiff");
    }
    if bytes.get(4..8) == Some(b"ftyp") {
        let brands = &bytes[8..bytes.len().min(64)];
        if brands
            .windows(4)
            .any(|brand| matches!(brand, b"avif" | b"avis"))
        {
            return Some("image/avif");
        }
        if brands.windows(4).any(|brand| {
            matches!(
                brand,
                b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1" | b"msf1"
            )
        }) {
            return Some("image/heif");
        }
    }
    None
}

fn guarded_source(base: &str, source: &str) -> Result<Url, &'static str> {
    if base.len() > 2048 || source.len() > 32768 || source.bytes().any(|b| b <= 0x20 || b == 0x7f) {
        return Err("媒体地址无效");
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
        return Err("NAS 地址无效");
    }
    let url = base.join(source).map_err(|_| "媒体地址无效")?;
    if url.scheme() != base.scheme()
        || url.host_str() != base.host_str()
        || url.port_or_known_default() != base.port_or_known_default()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("媒体地址不属于当前 NAS");
    }
    let mut path = url.path().to_owned();
    for _ in 0..4 {
        let decoded = percent_decode(&path, false);
        if decoded == path {
            break;
        }
        if decoded.split('/').any(|part| part == "." || part == "..")
            || decoded.bytes().any(|b| b < 0x20 || b == 0x7f || b == b'\\')
            || decoded.matches('/').count() != path.matches('/').count()
        {
            return Err("媒体路径无效");
        }
        path = decoded;
    }
    let lower = path.to_ascii_lowercase();
    if lower
        .split('/')
        .any(|p| p.ends_with(".m3u8") || p.ends_with(".m3u"))
    {
        return Err("媒体清单需要额外适配");
    }
    let exact = [
        "/transcode/thumb",
        "/transcode/decrypt/thumb",
        "/transcode/cover",
        "/transcode/play",
        "/transcode/audio/stream",
        "/v2/file/download",
        "/v2/file/decrypt/download",
    ];
    let prefixes = [
        "/play/",
        "/thumb/",
        "/zmusic/play/",
        "/zmusic/cover/",
        "/zvideo/play/",
        "/zvideo_static/",
        "/zmusic_static/",
        "/splay/",
    ];
    if !exact.contains(&path.as_str())
        && !prefixes
            .iter()
            .any(|p| path.starts_with(p) && path.len() > p.len())
    {
        return Err("此地址不是受支持的只读媒体入口");
    }
    Ok(url)
}

pub(crate) fn guarded_cookie(cookie: &str) -> Result<Vec<String>, &'static str> {
    if cookie.is_empty()
        || cookie.len() > 16384
        || cookie.bytes().any(|b| !(0x20..=0x7e).contains(&b))
    {
        return Err("NAS 媒体会话无效");
    }
    let mut secrets = Vec::new();
    for part in cookie.split(';') {
        let (name, value) = part.trim().split_once('=').ok_or("NAS 媒体会话无效")?;
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
            || value.is_empty()
        {
            return Err("NAS 媒体会话无效");
        }
        if name.to_ascii_lowercase().contains("token")
            || name.to_ascii_lowercase().contains("session")
            || value.len() >= 8
        {
            secrets.push(value.to_owned());
            let decoded = percent_decode(value, false);
            if decoded != value {
                secrets.push(decoded);
            }
        }
    }
    Ok(secrets)
}

fn bounded_range(raw: Option<&str>) -> Result<String, &'static str> {
    let raw = raw.unwrap_or("bytes=0-");
    let span = raw.strip_prefix("bytes=").ok_or("媒体范围无效")?;
    let (start, end) = span.split_once('-').ok_or("媒体范围无效")?;
    let number = |s: &str| -> Result<u64, &'static str> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return Err("媒体范围无效");
        }
        s.parse().map_err(|_| "媒体范围无效")
    };
    if start.is_empty() {
        let len = number(end)?;
        if len == 0 {
            return Err("媒体范围无效");
        }
        return Ok(format!("bytes=-{}", len.min(CHUNK_LIMIT as u64)));
    }
    let first = number(start)?;
    let cap = first
        .checked_add(CHUNK_LIMIT as u64 - 1)
        .ok_or("媒体范围无效")?;
    let last = if end.is_empty() {
        cap
    } else {
        number(end)?.min(cap)
    };
    if last < first {
        return Err("媒体范围无效");
    }
    Ok(format!("bytes={first}-{last}"))
}

fn percent_decode(raw: &str, plus: bool) -> String {
    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut offset = 0;
    while offset < bytes.len() {
        if bytes[offset] == b'%' && offset + 2 < bytes.len() {
            let high = (bytes[offset + 1] as char).to_digit(16);
            let low = (bytes[offset + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                decoded.push((high * 16 + low) as u8);
                offset += 3;
                continue;
            }
        }
        decoded.push(if plus && bytes[offset] == b'+' {
            b' '
        } else {
            bytes[offset]
        });
        offset += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn contains_secret(raw: &[u8], secrets: &[String]) -> bool {
    let mut variants = vec![String::from_utf8_lossy(raw).into_owned()];
    for _ in 0..4 {
        let mut next = Vec::new();
        for value in variants {
            if secrets
                .iter()
                .any(|secret| !secret.is_empty() && value.contains(secret))
            {
                return true;
            }
            for plus in [false, true] {
                let decoded = percent_decode(&value, plus);
                if decoded != value && !next.contains(&decoded) {
                    next.push(decoded);
                }
            }
        }
        variants = next;
    }
    false
}

fn passive_mime(mime: &str) -> bool {
    if ["json", "html", "xml", "svg", "javascript", "mpegurl"]
        .iter()
        .any(|part| mime.contains(part))
    {
        return false;
    }
    mime == "application/octet-stream"
        || ((mime.starts_with("audio/") || mime.starts_with("video/")) && !mime.contains("mpegurl"))
        || matches!(
            mime,
            "image/jpeg"
                | "image/png"
                | "image/gif"
                | "image/webp"
                | "image/bmp"
                | "image/avif"
                | "image/heic"
                | "image/heif"
                | "image/x-icon"
        )
}

fn unsafe_marker(body: &[u8]) -> bool {
    let body = body.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(body);
    let trimmed = String::from_utf8_lossy(body)
        .trim_start()
        .to_ascii_lowercase();
    trimmed.starts_with(['<', '{', '[']) || trimmed.starts_with("#extm3u")
}

fn textual_prefix(body: &[u8]) -> bool {
    let body = body.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(body);
    std::str::from_utf8(body).is_ok_and(|s| {
        s.chars()
            .all(|c| !c.is_control() || matches!(c, '\r' | '\n' | '\t'))
    })
}

fn classify_prefix(mime: &str, body: &[u8], secrets: &[String]) -> Result<String, &'static str> {
    let mime = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let body = body.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(body);
    if body.is_empty()
        || textual_prefix(body)
        || unsafe_marker(body)
        || contains_secret(body, secrets)
        || (!mime.is_empty() && !passive_mime(&mime))
    {
        return Err("NAS 返回的内容不是可直接播放的媒体");
    }
    Ok(if mime.is_empty() {
        "application/octet-stream".into()
    } else {
        mime
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };
    use std::time::{Duration, Instant};

    struct Server {
        base: String,
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }
    fn server(handler: impl Fn(&str) -> Vec<u8> + Send + 'static) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let thread = std::thread::spawn(move || {
            while !stopped.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        // macOS accepts inherit the listener's nonblocking
                        // mode. A fragmented header must wait for more bytes.
                        stream.set_nonblocking(false).unwrap();
                        // A speculative/abandoned connection is not an HTTP
                        // request. Only dispatch a complete header block.
                        let deadline = Instant::now() + Duration::from_secs(10);
                        let mut request = Vec::new();
                        let mut buffer = [0u8; 4096];
                        let mut complete = None;
                        while request.len() < 32768 {
                            let Some(remaining) = deadline.checked_duration_since(Instant::now())
                            else {
                                break;
                            };
                            stream.set_read_timeout(Some(remaining)).unwrap();
                            let read = match stream.read(&mut buffer) {
                                Ok(0) => break,
                                Ok(read) => read,
                                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                                    continue
                                }
                                Err(_) => break,
                            };
                            request.extend_from_slice(&buffer[..read]);
                            if let Some(end) =
                                request.windows(4).position(|part| part == b"\r\n\r\n")
                            {
                                complete = Some(end + 4);
                                break;
                            }
                        }
                        let Some(end) = complete else {
                            continue;
                        };
                        if end > 32768 {
                            continue;
                        }
                        request.truncate(end);
                        let Ok(request) = String::from_utf8(request) else {
                            continue;
                        };
                        let response = handler(&request.to_ascii_lowercase());
                        stream
                            .set_write_timeout(Some(Duration::from_secs(10)))
                            .unwrap();
                        let _ = stream.write_all(&response);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2))
                    }
                    Err(e) => panic!("synthetic server: {e}"),
                }
            }
        });
        Server {
            base,
            stop,
            thread: Some(thread),
        }
    }
    fn response(status: &str, mime: &str, range: Option<&str>, body: &[u8]) -> Vec<u8> {
        let range = range
            .map(|r| format!("Content-Range: {r}\r\n"))
            .unwrap_or_default();
        let mut value = format!("HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\n{range}Connection: close\r\n\r\n", body.len()).into_bytes();
        value.extend_from_slice(body);
        value
    }
    fn request(url: &str, range: Option<&str>) -> tauri::http::Request<Vec<u8>> {
        let mut request = tauri::http::Request::builder().uri(url);
        if let Some(range) = range {
            request = request.header("Range", range);
        }
        request.body(Vec::new()).unwrap()
    }

    #[test]
    fn file_download_reference_cannot_be_rendered_by_media_scheme() {
        let media = MediaState::default();
        let downloads = crate::download::DownloadState::default();
        let id = downloads
            .register(
                &media,
                "http://127.0.0.1:1",
                "/v2/file/download?path=%2Fa&webagent=v2&request_purpose=5&show_hidden=0",
                "device_id=synthetic; zenithtoken=synthetic",
                "file-only",
                "a",
                None,
            )
            .unwrap();
        let uri = format!("nas-media://localhost/{id}");
        let reply = tauri::async_runtime::block_on(media.serve(request(&uri, None)));
        assert_eq!(reply.status(), 401);
        assert!(!reply.body().windows(9).any(|bytes| bytes == b"synthetic"));
    }
    #[test]
    fn complete_image_preview_over_eight_mib_does_not_synthesize_a_partial_range() {
        let mut data = vec![0x55; 9 * 1024 * 1024];
        data[..3].copy_from_slice(&[255, 216, 255]);
        let original = data.clone();
        let upstream = server(move |request| {
            if request.contains("range:") {
                response(
                    "206 Partial Content",
                    "image/jpeg",
                    Some("bytes 0-8388607/9437184"),
                    &data[..8388608],
                )
            } else {
                response("200 OK", "image/jpeg", None, &data)
            }
        });
        let state = MediaState::default();
        for path in [
            "/transcode/thumb?file_path=a.jpg",
            "/transcode/decrypt/thumb?encrypted_path=E.synthetic&from=pub_album",
        ] {
            let uri = state
                .register(
                    &upstream.base,
                    path,
                    "zenithtoken=synthetic-secret",
                    "image-session",
                )
                .unwrap();
            let reply = tauri::async_runtime::block_on(state.serve(request(&uri, None)));
            assert_eq!(reply.status(), 200);
            assert_eq!(reply.body(), &original);
            assert!(!reply.headers().contains_key("Content-Range"));
        }
    }

    #[test]
    fn complete_image_preview_accepts_only_whole_content_ranges() {
        for (range, length, complete) in [
            ("bytes 0-9437183/9437184", 9437184, true),
            ("bytes 0-8388607/9437184", 8388608, false),
            ("bytes 1-3/4", 3, false),
            ("bytes 0-3/4", 3, false),
        ] {
            let mut data = vec![0x55; length];
            data[..3].copy_from_slice(&[255, 216, 255]);
            let upstream =
                server(move |_| response("206 Partial Content", "image/jpeg", Some(range), &data));
            let state = MediaState::default();
            let uri = state
                .register(
                    &upstream.base,
                    "/transcode/thumb",
                    "zenithtoken=synthetic-secret",
                    "image-session",
                )
                .unwrap();
            let reply = tauri::async_runtime::block_on(state.serve(request(&uri, None)));
            if complete {
                assert_eq!(reply.status(), 200);
                assert_eq!(reply.body().len(), length);
            } else {
                assert!(reply.status().is_client_error() || reply.status().is_server_error());
            }
        }
    }

    #[test]
    fn complete_image_preview_rejects_oversize_active_content_secrets_and_redirects() {
        for payload in [
            b"HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: 67108865\r\nConnection: close\r\n\r\n".to_vec(),
            response("200 OK", "image/jpeg", None, b"<html>login</html>"),
            response("200 OK", "image/png", None, b"{\"descriptor\":true}"),
            response("200 OK", "image/svg+xml", None, b"<svg/>"),
            response("200 OK", "video/mp4", None, b"\0\0\0\x18ftypisom\0\0\0\0isommp42"),
            response("200 OK", "image/jpeg", None, b"\xff\xd8\xffsynthetic-secret"),
            b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/capture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
        ] {
            let upstream = server(move |_| payload.clone());
            let state = MediaState::default();
            let uri = state.register(&upstream.base, "/transcode/decrypt/thumb", "zenithtoken=synthetic-secret", "image-session").unwrap();
            let reply = tauri::async_runtime::block_on(state.serve(request(&uri, None)));
            assert!(reply.status().is_client_error() || reply.status().is_server_error());
            assert!(!String::from_utf8_lossy(reply.body()).contains("synthetic"));
        }
    }

    #[test]
    fn complete_image_preview_enforces_body_cap_without_content_length() {
        let mut payload =
            b"HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nConnection: close\r\n\r\n".to_vec();
        payload.extend_from_slice(&[255, 216, 255]);
        payload.resize(payload.len() + 64 * 1024 * 1024, 0x55);
        let upstream = server(move |_| payload.clone());
        let state = MediaState::default();
        let uri = state
            .register(
                &upstream.base,
                "/transcode/thumb",
                "zenithtoken=synthetic-secret",
                "image-session",
            )
            .unwrap();
        let reply = tauri::async_runtime::block_on(state.serve(request(&uri, None)));
        assert_eq!(reply.status(), 413);
        assert!(String::from_utf8_lossy(reply.body()).contains("64 MiB"));
        assert!(reply.body().len() < 256);
    }

    #[test]
    fn complete_image_preview_cancelled_session_cannot_return_image_bytes() {
        let connected = Arc::new(AtomicBool::new(false));
        let observed = connected.clone();
        let upstream = server(move |_| {
            observed.store(true, Ordering::Release);
            std::thread::sleep(Duration::from_millis(350));
            response("200 OK", "image/jpeg", None, &[255, 216, 255, 1])
        });
        let state = MediaState::default();
        let uri = state
            .register(
                &upstream.base,
                "/transcode/thumb",
                "zenithtoken=synthetic-secret",
                "image-session",
            )
            .unwrap();
        tauri::async_runtime::block_on(async {
            let cloned = state.clone();
            let pending =
                tauri::async_runtime::spawn(async move { cloned.serve(request(&uri, None)).await });
            for _ in 0..100 {
                if connected.load(Ordering::Acquire) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            assert!(connected.load(Ordering::Acquire));
            state.clear("image-session").unwrap();
            assert_eq!(pending.await.unwrap().status(), 401);
        });
    }

    #[test]
    fn upstream_auth_expiry_emits_only_its_session_once_not_for_ttl_or_logout() {
        for status in ["401 Unauthorized", "403 Forbidden"] {
            let upstream =
                server(move |_| response(status, "text/plain", None, b"synthetic-secret"));
            let state = MediaState::default();
            let events = Arc::new(Mutex::new(Vec::<String>::new()));
            let seen = events.clone();
            state.set_auth_expired_notifier(Arc::new(move |id| {
                seen.lock().unwrap().push(id.to_owned());
            }));
            let uri = state
                .register(
                    &upstream.base,
                    "/transcode/thumb",
                    "zenithtoken=synthetic-secret",
                    "current-session",
                )
                .unwrap();
            assert_eq!(
                tauri::async_runtime::block_on(state.serve(request(&uri, None))).status(),
                401
            );
            assert_eq!(*events.lock().unwrap(), vec!["current-session".to_owned()]);
            assert_eq!(
                tauri::async_runtime::block_on(state.serve(request(&uri, None))).status(),
                401
            );
            assert_eq!(events.lock().unwrap().len(), 1);
            let logged_out = state
                .register(
                    &upstream.base,
                    "/transcode/thumb",
                    "zenithtoken=synthetic-secret",
                    "logout-session",
                )
                .unwrap();
            state.clear("logout-session").unwrap();
            assert_eq!(
                tauri::async_runtime::block_on(state.serve(request(&logged_out, None))).status(),
                401
            );
            let expired = state
                .register(
                    &upstream.base,
                    "/transcode/thumb",
                    "zenithtoken=synthetic-secret",
                    "ttl-session",
                )
                .unwrap();
            let id = expired.rsplit('/').next().unwrap();
            state
                .registry
                .lock()
                .unwrap()
                .refs
                .get_mut(id)
                .unwrap()
                .expires = Instant::now() - Duration::from_secs(1);
            assert_eq!(
                tauri::async_runtime::block_on(state.serve(request(&expired, None))).status(),
                401
            );
            assert_eq!(*events.lock().unwrap(), vec!["current-session".to_owned()]);
            assert!(!serde_json::to_string(&*events.lock().unwrap())
                .unwrap()
                .contains("synthetic"));
        }
    }

    #[test]
    fn fixture_discards_abandoned_connections_and_reassembles_fragmented_headers() {
        let accepted = Arc::new(AtomicUsize::new(0));
        let seen = accepted.clone();
        let upstream = server(move |request| {
            assert!(request.ends_with("\r\n\r\n"));
            assert!(request.contains("cookie: zenithtoken=synthetic-secret\r\n"));
            seen.fetch_add(1, Ordering::AcqRel);
            response("200 OK", "text/plain", None, b"accepted")
        });
        let address = upstream.base.strip_prefix("http://").unwrap();
        let empty = TcpStream::connect(address).unwrap();
        empty.shutdown(Shutdown::Both).unwrap();
        let mut partial = TcpStream::connect(address).unwrap();
        let _ = partial.write_all(b"GET /play/a HTTP/1.1\r\nCoo");
        partial.shutdown(Shutdown::Both).unwrap();
        let mut full = TcpStream::connect(address).unwrap();
        full.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        for fragment in [
            b"GET /play/a HTTP/1.1\r\nCoo".as_slice(),
            b"kie: zenithtoken=".as_slice(),
            b"synthetic-secret\r\nHost: localhost\r\n".as_slice(),
            b"\r\n".as_slice(),
        ] {
            full.write_all(fragment).unwrap();
            std::thread::sleep(Duration::from_millis(2));
        }
        let mut received = Vec::new();
        full.read_to_end(&mut received).unwrap();
        assert!(received.starts_with(b"HTTP/1.1 200 OK\r\n"));
        assert_eq!(accepted.load(Ordering::Acquire), 1);
    }

    #[test]
    fn native_refs_are_opaque_and_cleared_sessions_cannot_resurrect() {
        let state = MediaState::default();
        let uri = state
            .register(
                "http://nas.example:5055",
                "/play/a?token=synthetic-secret",
                "zenithtoken=synthetic-secret",
                "session-1",
            )
            .unwrap();
        assert!(!uri.contains("synthetic-secret"));
        assert!(!uri.contains('?'));
        assert!(uri.rsplit('/').next().unwrap().len() >= 32);
        state.clear("session-1").unwrap();
        assert!(state
            .register(
                "http://nas.example:5055",
                "/play/a",
                "zenithtoken=synthetic-secret",
                "session-1"
            )
            .is_err());
        assert_eq!(
            tauri::async_runtime::block_on(state.serve(request(&uri, None))).status(),
            401
        );
        state.clear("late-session").unwrap();
        assert!(state
            .register(
                "http://nas.example:5055",
                "/play/a",
                "zenithtoken=synthetic-secret",
                "late-session"
            )
            .is_err());
    }

    #[test]
    fn offset_ranges_verify_byte_zero_and_preserve_binary_range() {
        let reads = Arc::new(Mutex::new(Vec::new()));
        let seen = reads.clone();
        let data = b"\0\0\0\x18ftypisom\0\0\0\0isommp42ASCII-RANGE";
        let upstream = server(move |request| {
            seen.lock().unwrap().push(request.to_owned());
            assert!(request
                .contains("cookie: device_id=synthetic-device; zenithtoken=synthetic-secret\r\n"));
            assert!(!request.contains("authorization:"));
            if request.contains("range: bytes=0-511\r\n") {
                response(
                    "206 Partial Content",
                    "application/octet-stream",
                    Some("bytes 0-34/35"),
                    data,
                )
            } else {
                assert!(request.contains("range: bytes=24-8388631\r\n"));
                response(
                    "206 Partial Content",
                    "application/octet-stream",
                    Some("bytes 24-34/35"),
                    &data[24..],
                )
            }
        });
        let state = MediaState::default();
        let uri = state
            .register(
                &upstream.base,
                "/play/a",
                "device_id=synthetic-device; zenithtoken=synthetic-secret",
                "session-1",
            )
            .unwrap();
        let reply = tauri::async_runtime::block_on(state.serve(request(&uri, Some("bytes=24-"))));
        assert_eq!(
            reply.status(),
            206,
            "{}",
            String::from_utf8_lossy(reply.body())
        );
        assert_eq!(reply.headers()["Content-Range"], "bytes 24-34/35");
        assert_eq!(reply.body(), &data[24..]);
        assert_eq!(reads.lock().unwrap().len(), 2);
    }

    #[test]
    fn valid_pcm_wav_offsets_can_begin_with_descriptor_punctuation() {
        // Valid mono 8 kHz, 16-bit PCM WAV. Its three signed samples start
        // with '{', '<' and '['; these are audio bytes, not text descriptors.
        let data = b"RIFF\x2a\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x40\x1f\0\0\x80\x3e\0\0\x02\0\x10\0data\x06\0\0\0{\xff<\xff[\xff";
        assert_eq!(data.len(), 50);
        let upstream = server(move |request| {
            if request.contains("range: bytes=0-511\r\n") {
                response(
                    "206 Partial Content",
                    "audio/wav",
                    Some("bytes 0-49/50"),
                    data,
                )
            } else {
                let start = [44, 46, 48]
                    .into_iter()
                    .find(|start| request.contains(&format!("range: bytes={start}-")))
                    .unwrap();
                response(
                    "206 Partial Content",
                    "audio/wav",
                    Some(&format!("bytes {start}-49/50")),
                    &data[start..],
                )
            }
        });
        let state = MediaState::default();
        let uri = state
            .register(
                &upstream.base,
                "/play/pcm.wav",
                "zenithtoken=synthetic-secret",
                "session-1",
            )
            .unwrap();
        for start in [44, 46, 48] {
            let reply = tauri::async_runtime::block_on(
                state.serve(request(&uri, Some(&format!("bytes={start}-")))),
            );
            assert_eq!(reply.status(), 206, "valid PCM offset {start}");
            assert_eq!(reply.body(), &data[start..]);
            assert_eq!(
                reply.headers()["Content-Range"],
                format!("bytes {start}-49/50")
            );
        }
    }

    #[test]
    fn descriptor_byte_zero_blocks_offset_request_without_leaking_secrets() {
        let count = Arc::new(Mutex::new(0));
        let seen = count.clone();
        let upstream = server(move |request| {
            *seen.lock().unwrap() += 1;
            assert!(request.contains("range: bytes=0-511\r\n"));
            let body = b"#EXTM3U\n/play/segment.ts?token=synthetic%252Bsecret\n";
            response(
                "206 Partial Content",
                "application/octet-stream",
                Some("bytes 0-50/51"),
                body,
            )
        });
        let state = MediaState::default();
        let uri = state
            .register(
                &upstream.base,
                "/play/manifest",
                "zenithtoken=synthetic%2Bsecret",
                "session-1",
            )
            .unwrap();
        let reply = tauri::async_runtime::block_on(state.serve(request(&uri, Some("bytes=8-"))));
        assert!(reply.status().is_client_error() || reply.status().is_server_error());
        assert!(!String::from_utf8_lossy(reply.body()).contains("synthetic"));
        assert_eq!(*count.lock().unwrap(), 1);
    }

    #[test]
    fn redirects_and_oversized_full_responses_are_rejected() {
        for payload in [
            b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/play/leak\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".as_slice(),
            b"HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 999999999\r\nConnection: close\r\n\r\n".as_slice(),
        ] {
            let payload = payload.to_vec();
            let upstream = server(move |_| payload.clone());
            let state = MediaState::default();
            let uri = state.register(&upstream.base, "/play/a", "zenithtoken=synthetic-secret", "session-1").unwrap();
            let reply = tauri::async_runtime::block_on(state.serve(request(&uri, None)));
            assert!(reply.status().is_server_error());
            assert!(reply.body().len() < 256);
        }
    }

    #[test]
    fn logout_cancels_pending_native_reads() {
        let connected = Arc::new(AtomicBool::new(false));
        let observed = connected.clone();
        let upstream = server(move |_| {
            observed.store(true, Ordering::Release);
            std::thread::sleep(Duration::from_millis(350));
            response(
                "200 OK",
                "video/mp4",
                None,
                b"\0\0\0\x18ftypisom\0\0\0\0isommp42",
            )
        });
        let state = MediaState::default();
        let uri = state
            .register(
                &upstream.base,
                "/play/a",
                "zenithtoken=synthetic-secret",
                "session-1",
            )
            .unwrap();
        tauri::async_runtime::block_on(async {
            let cloned = state.clone();
            let pending =
                tauri::async_runtime::spawn(async move { cloned.serve(request(&uri, None)).await });
            for _ in 0..100 {
                if connected.load(Ordering::Acquire) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            assert!(connected.load(Ordering::Acquire));
            let start = Instant::now();
            state.clear("session-1").unwrap();
            assert_eq!(pending.await.unwrap().status(), 401);
            assert!(start.elapsed() < Duration::from_millis(200));
        });
    }

    #[test]
    fn native_requests_reject_mutation_headers_authority_and_expired_refs() {
        let state = MediaState::default();
        let uri = state
            .register(
                "http://nas.example:5055",
                "/play/a",
                "zenithtoken=synthetic-secret",
                "session-1",
            )
            .unwrap();
        for invalid in [
            Request::builder()
                .uri(&uri)
                .method("POST")
                .body(Vec::new())
                .unwrap(),
            Request::builder()
                .uri(&uri)
                .header("Cookie", "zenithtoken=other")
                .body(Vec::new())
                .unwrap(),
            Request::builder()
                .uri(&uri.replace("://localhost", "://other@localhost"))
                .body(Vec::new())
                .unwrap(),
        ] {
            let result = tauri::async_runtime::block_on(state.serve(invalid));
            assert!(result.status().is_client_error());
        }
        let id = uri.rsplit('/').next().unwrap();
        state
            .registry
            .lock()
            .unwrap()
            .refs
            .get_mut(id)
            .unwrap()
            .expires = Instant::now() - Duration::from_secs(1);
        assert_eq!(
            tauri::async_runtime::block_on(state.serve(request(&uri, None))).status(),
            401
        );
        assert_eq!(state.registry.lock().unwrap().sessions.len(), 0);
    }

    #[test]
    fn head_preserves_metadata_after_verification_and_drops_private_headers() {
        let upstream = server(|request| {
            let data = b"\0\0\0\x18ftypisom\0\0\0\0isommp42";
            if request.starts_with("get ") {
                response(
                    "206 Partial Content",
                    "video/mp4",
                    Some("bytes 0-23/24"),
                    data,
                )
            } else {
                assert!(request.starts_with("head "));
                b"HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 999999999\r\nAccept-Ranges: bytes\r\nETag: synthetic-secret\r\nSet-Cookie: zenithtoken=synthetic-secret\r\nX-Token: synthetic-secret\r\nConnection: close\r\n\r\n".to_vec()
            }
        });
        let state = MediaState::default();
        let uri = state
            .register(
                &upstream.base,
                "/play/a",
                "zenithtoken=synthetic-secret",
                "session-1",
            )
            .unwrap();
        let head = Request::builder()
            .uri(&uri)
            .method("HEAD")
            .body(Vec::new())
            .unwrap();
        let result = tauri::async_runtime::block_on(state.serve(head));
        assert_eq!(result.status(), 200);
        assert_eq!(result.headers()["Content-Length"], "999999999");
        assert!(result.body().is_empty());
        for header in ["ETag", "Set-Cookie", "X-Token"] {
            assert!(!result.headers().contains_key(header));
        }
    }

    #[test]
    fn verified_binary_source_does_not_admit_changed_descriptor_range() {
        for descriptor in [
            b"#EXTM3U\n/a.ts\n".as_slice(),
            b"<html>x</html>".as_slice(),
            b"{\"value\":1}".as_slice(),
        ] {
            let upstream = server(move |request| {
                if request.contains("range: bytes=0-511\r\n") {
                    response(
                        "206 Partial Content",
                        "video/mp4",
                        Some("bytes 0-23/24"),
                        b"\0\0\0\x18ftypisom\0\0\0\0isommp42",
                    )
                } else {
                    response(
                        "206 Partial Content",
                        "video/mp4",
                        Some(&format!(
                            "bytes 8-{}/{}",
                            7 + descriptor.len(),
                            8 + descriptor.len()
                        )),
                        descriptor,
                    )
                }
            });
            let state = MediaState::default();
            let uri = state
                .register(
                    &upstream.base,
                    "/play/a",
                    "zenithtoken=synthetic-secret",
                    "session-1",
                )
                .unwrap();
            let result =
                tauri::async_runtime::block_on(state.serve(request(&uri, Some("bytes=8-"))));
            assert_eq!(result.status(), 415);
        }
    }

    #[test]
    fn sources_are_bound_to_selected_nas_and_read_endpoints() {
        let base = "http://nas.example:5055";
        assert!(guarded_source(base, "/transcode/thumb?file_path=%2Fphotos%2Fa.jpg").is_ok());
        assert!(guarded_source(
            base,
            "/transcode/decrypt/thumb?encrypted_path=E.synthetic&from=pub_album"
        )
        .is_ok());
        assert!(guarded_source(base, "http://nas.example:5055/play/a.mp4?token=synthetic").is_ok());
        for source in [
            "https://nas.example:5055/play/a.mp4",
            "http://nas.example:5056/play/a.mp4",
            "http://other.example:5055/play/a.mp4",
            "http://user:password@nas.example:5055/play/a.mp4",
            "//other.example/play/a.mp4",
            "/v2/file/delete?path=x",
            "/transcode/decrypt/delete?path=x",
            "/transcode/decrypt/thumb/other",
            "http://other.example:5055/transcode/decrypt/thumb",
            "/transcode/audio/play?path=x",
            "/play/../setting/save",
            "/play/%2e%2e/setting/save",
            "/play/%2F..%2Fsetting/save",
            "/play/a.m3u8",
            "/play/%61.m3u8",
            "/play/a.mp4#fragment",
        ] {
            assert!(guarded_source(base, source).is_err(), "accepted {source}");
        }
        for base in [
            "file:///tmp",
            "http://user@nas.example:5055",
            "http://nas.example:5055/path",
            "http://nas.example:5055?x=1",
        ] {
            assert!(guarded_source(base, "/play/a").is_err());
        }
    }

    #[test]
    fn cookies_cannot_inject_headers_and_values_remain_private() {
        assert_eq!(
            guarded_cookie("nas_token=synthetic%2Bsecret; nas_id=42").unwrap()[0],
            "synthetic%2Bsecret"
        );
        for value in [
            "",
            "nas_token=x\r\nX-Test: yes",
            "nas_token=x\0",
            "no-equals",
            "nas_token=值",
        ] {
            assert!(guarded_cookie(value).is_err());
        }
    }

    #[test]
    fn ranges_have_a_single_bounded_chunk() {
        assert_eq!(bounded_range(None).unwrap(), "bytes=0-8388607");
        assert_eq!(
            bounded_range(Some("bytes=24-")).unwrap(),
            "bytes=24-8388631"
        );
        assert_eq!(bounded_range(Some("bytes=10-20")).unwrap(), "bytes=10-20");
        assert_eq!(
            bounded_range(Some("bytes=-999999999")).unwrap(),
            "bytes=-8388608"
        );
        for value in [
            "bytes=0-1,2-3",
            "items=1-2",
            "bytes=2-1",
            "bytes=-0",
            "bytes=18446744073709551615-",
            "bytes= 0-1",
        ] {
            assert!(bounded_range(Some(value)).is_err());
        }
    }

    #[test]
    fn prefix_classification_rejects_active_or_descriptor_content() {
        let secrets = vec!["synthetic+secret".into()];
        let binary = b"\0\0\0\x18ftypisom\0\0\0\0isommp42";
        assert_eq!(
            classify_prefix("application/octet-stream", binary, &secrets).unwrap(),
            "application/octet-stream"
        );
        for (mime, body) in [
            ("video/mp4", b"#EXTM3U\n/play/segment.ts".as_slice()),
            (
                "application/octet-stream",
                b"/play/segment.ts?token=synthetic%252Bsecret".as_slice(),
            ),
            ("image/jpeg", b"<html>login</html>".as_slice()),
            ("video/mp4", b"{\"url\":\"/play/a\"}".as_slice()),
            ("application/vnd.apple.mpegurl", binary.as_slice()),
            ("image/svg+xml", binary.as_slice()),
            ("video/descriptor+json", binary.as_slice()),
            ("audio/svg+xml", binary.as_slice()),
            ("application/octet-stream", b"ordinary text".as_slice()),
        ] {
            assert!(
                classify_prefix(mime, body, &secrets).is_err(),
                "accepted {mime}"
            );
        }
    }
}
