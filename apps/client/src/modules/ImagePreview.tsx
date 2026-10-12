import { useEffect, useState } from "react";
import { api, isNative, type Item } from "../api/client";
import { OfficialNasError, supportsImagePreview } from "../api/official-nas";

const imageByteLimit = 64 * 1024 * 1024;
class ImageReadError extends Error {}
const imageFailure = "图片加载失败，请重试或选择其他图片";
// Signature checks prevent active/descriptor bodies from becoming image Blob URLs.
// Actual decoding remains the browser's responsibility and has its own error state.
function imageMime(bytes: Uint8Array): string | undefined {
  const starts = (...prefix: number[]) => prefix.every((value, index) => bytes[index] === value);
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (starts(255, 216, 255)) return "image/jpeg";
  if (starts(137, 80, 78, 71, 13, 10, 26, 10)) return "image/png";
  if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (starts(66, 77)) return "image/bmp";
  if (starts(73, 73, 42, 0) || starts(77, 77, 0, 42)) return "image/tiff";
  if (ascii(4, 8) === "ftyp") {
    const brands = ascii(8, Math.min(64, bytes.length));
    if (/avif|avis/.test(brands)) return "image/avif";
    if (/heic|heix|hevc|hevx|mif1|msf1/.test(brands)) return "image/heif";
  }
}
async function browserImage(source: string, signal: AbortSignal, current: () => boolean): Promise<Blob> {
  const response = await api.fetchMedia(source, { signal });
  const mime = (response.headers.get("Content-Type") || "").split(";", 1)[0].trim().toLowerCase();
  const rawLength = response.headers.get("Content-Length");
  const declared = rawLength === null ? undefined : Number(rawLength);
  const rawRange = response.headers.get("Content-Range");
  const range = rawRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  const rangeTotal = range ? Number(range[3]) : undefined;
  const wholeRange = !!range && Number(range[1]) === 0 && Number(range[2]) + 1 === rangeTotal;
  const overLimit = (declared !== undefined && declared > imageByteLimit) || (rangeTotal !== undefined && rangeTotal > imageByteLimit);
  if (!current() || ![200, 206].includes(response.status) || !response.body ||
    (rawLength !== null && (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(declared))) ||
    ((response.status === 206 || rawRange !== null) && !wholeRange) ||
    (mime && !/^image\/(jpeg|png|gif|webp|bmp|tiff|avif|hei[cf])$/.test(mime) && mime !== "application/octet-stream") ||
    overLimit) {
    await response.body?.cancel().catch(() => {});
    throw new ImageReadError(overLimit ? "图片加载失败：预览超过 64 MiB，请选择其他图片" : imageFailure);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (!current() || signal.aborted) throw new ImageReadError(imageFailure);
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > imageByteLimit) throw new ImageReadError("图片加载失败：预览超过 64 MiB，请选择其他图片");
      chunks.push(new Uint8Array(value));
    }
    if (!current() || signal.aborted) throw new ImageReadError(imageFailure);
    if ((declared !== undefined && declared !== length) || (rangeTotal !== undefined && rangeTotal !== length)) throw new ImageReadError("图片加载失败：NAS 未返回完整图片，请重试");
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const type = imageMime(bytes);
    if (!type) throw new ImageReadError(imageFailure);
    return new Blob([bytes.buffer], { type });
  } catch (reason) {
    await reader.cancel().catch(() => {});
    throw reason;
  } finally { reader.releaseLock(); }
}

/** One viewer for Files and Photos; a new file/session cannot keep an old image. */
export function ImagePreview({ item, preferOriginal = false }: { item: Item; preferOriginal?: boolean }) {
  const session = api.nasSession;
  const identity = JSON.stringify([
    session, item.id, item.path, item.name, item.size,
    item.metadata?.encrypted_path, item.metadata?.from,
    item.metadata?.up, item.metadata?.updated_at, preferOriginal,
  ]);
  return <PreviewContent key={identity} item={item} session={session} preferOriginal={preferOriginal} />;
}
function PreviewContent({ item, session, preferOriginal }: { item: Item; session: string; preferOriginal: boolean }) {
  const [revision, setRevision] = useState(0);
  const [source, setSource] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [fallback, setFallback] = useState(false);
  const original = preferOriginal && !fallback;
  const supported = supportsImagePreview(item);
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    const current = () => alive && session === api.nasSession;
    setSource(undefined);
    setLoaded(false);
    setError("");
    if (!supported || !session) return;
    (original ? api.imageOriginal(item) : api.imagePreview(item)).then(async value => {
      if (!current()) return;
      if (isNative()) { setSource(value); return; }
      const blob = await browserImage(value, controller.signal, current);
      if (!current()) return;
      objectUrl = URL.createObjectURL(blob);
      setSource(objectUrl);
    }).catch(reason => {
      if (!alive) return;
      setSource(undefined);
      if (original && current() && !(reason instanceof OfficialNasError && ["SESSION_EXPIRED", "REQUEST_CANCELLED"].includes(reason.code))) {
        setFallback(true);
        return;
      }
      setError(session !== api.nasSession ? "NAS 会话已改变，请重新打开图片" :
        reason instanceof OfficialNasError || reason instanceof ImageReadError ? reason.message : imageFailure);
    });
    return () => {
      alive = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [session, supported, item.path, item.name, item.size, item.metadata?.encrypted_path, item.metadata?.from, item.metadata?.up, item.metadata?.updated_at, revision, original]);
  if (!supported) return <div className="image-preview"><p>此项目缺少图片路径或暂不支持预览</p></div>;
  if (!session) return <div className="image-preview"><p>请先连接 NAS</p></div>;
  return (
    <div className="image-preview">
      {preferOriginal && fallback && <div className="image-preview-quality"><span>原图暂不可用，显示预览</span><button className="secondary" onClick={() => { setFallback(false); setRevision(value => value + 1); }}>重试原图</button></div>}
      {error ? <div className="image-preview-error" role="alert">
        <p>{error}</p>
        <button className="secondary" onClick={() => setRevision(value => value + 1)}>重试图片</button>
      </div> : <>
        {!loaded && <div className="image-preview-loading" role="status"><span className="spinner" /><p>正在加载图片</p></div>}
        {source && <img key={revision} src={source} alt={item.name} referrerPolicy="no-referrer"
          className={loaded ? "loaded" : "pending"}
          onLoad={() => { if (session === api.nasSession) setLoaded(true); }}
          onError={() => {
            if (session === api.nasSession) {
              setSource(undefined);
              setLoaded(false);
              if (original) { setFallback(true); return; }
              setError("图片加载失败，请重试或选择其他图片");
            }
          }} />}
      </>}
    </div>
  );
}
