import { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardText, LinkSimple, Warning } from "@phosphor-icons/react";
import { api, type Item } from "../api/client";

/**
 * 添加离线下载任务。
 *
 * 交互与协议判定完全照官方实现（官方 76237 chunk 的 creatTask）：
 *   1. 先取 `/downloader/get/protocols`，失败则用同一份兜底列表；
 *   2. 输入框按**换行**拆成多条，逐条校验协议前缀；
 *   3. 磁力链接（magnet:）与 http/ftp 走同一个提交接口，参数是 `{uri, dir}`；
 *   4. NAS 返回 code 1000 表示已有相同任务，要如实告诉用户而不是假装成功。
 *
 * 剪切板监听是官方没有的增强：打开开关后每 1.5 秒读一次剪切板，
 * 只有内容像受支持的链接时才填入（浏览器要求页面处于聚焦状态，被拒绝时静默跳过）。
 */

type Status = { tone: "idle" | "ok" | "error"; text: string };

const fallbackProtocols = ["http", "https", "ftp", "ftps", "sftp", "magnet"];
const looksLikeLink = (value: string, protocols: string[]) =>
  protocols.some((protocol) => new RegExp(`^${protocol}:`, "i").test(value.trim()));

/**
 * 浏览器能不能读剪切板。
 * 实测：部署在 http://<nas>:18436（非安全上下文）时 `navigator.clipboard` 是 undefined，
 * 任何 readText 调用都会抛错；https / localhost / 原生客户端才可用。
 */
export function clipboardSupport(): { available: boolean; reason: string } {
  const reason =
    "浏览器只在 HTTPS 或 localhost 下允许读取剪切板；当前是 http:// 访问。请用 ⌘V 直接粘贴，" +
    "或改用桌面客户端。";
  if (typeof navigator === "undefined" || typeof window === "undefined") return { available: false, reason };
  if (!window.isSecureContext) return { available: false, reason };
  if (typeof navigator.clipboard?.readText !== "function") return { available: false, reason };
  return { available: true, reason: "" };
}

export function DownloadCreate({
  connected, dir, onDirChange, onDone,
}: {
  connected: boolean;
  dir: string;
  onDirChange: (value: string) => void;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [watch, setWatch] = useState(false);
  /**
   * 剪切板 API 只在**安全上下文**里存在：实测这个部署是 http://（isSecureContext=false），
   * `navigator.clipboard` 直接是 undefined —— 这时"自动监听"开关只会静默空转，
   * 等于给用户一个永远不可能生效的开关。所以先探测，再如实说明。
   */
  const clipboard = clipboardSupport();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ tone: "idle", text: "" });
  const [protocols, setProtocols] = useState<string[]>(fallbackProtocols);
  const lastClipboard = useRef("");
  const launcher = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open || !connected) return;
    let alive = true;
    api
      .downloadProtocols()
      .then((list) => {
        if (alive && list.length) setProtocols(list);
      })
      .catch(() => {
        /* 取不到就用官方同款兜底列表 */
      });
    return () => {
      alive = false;
    };
  }, [open, connected]);

  // 剪切板监听：只在面板打开且开关有效时轮询
  useEffect(() => {
    if (!open || !watch || !clipboard.available) return;
    let alive = true;
    const timer = window.setInterval(async () => {
      try {
        const value = (await navigator.clipboard.readText()).trim();
        if (!alive || !value || value === lastClipboard.current) return;
        lastClipboard.current = value;
        if (looksLikeLink(value, protocols)) {
          setText((current) => {
            const lines = current.split("\n").map((line) => line.trim()).filter(Boolean);
            if (lines.includes(value)) return current;
            return [...lines, value].join("\n");
          });
          setStatus({ tone: "ok", text: "已从剪切板捕捉到链接" });
        }
      } catch {
        /* 无焦点或未授权：静默等待下一次 */
      }
    }, 1500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [open, watch, protocols, clipboard.available]);

  const lines = useMemo(
    () => text.split("\n").map((line) => line.trim()).filter(Boolean),
    [text],
  );
  const valid = lines.filter((line) => looksLikeLink(line, protocols));
  const invalid = lines.filter((line) => !looksLikeLink(line, protocols));

  async function paste() {
    if (!clipboard.available) {
      setStatus({ tone: "error", text: clipboard.reason });
      input.current?.focus();
      return;
    }
    try {
      const value = (await navigator.clipboard.readText()).trim();
      if (!value) {
        setStatus({ tone: "error", text: "剪切板是空的" });
        return;
      }
      setText((current) => (current.trim() ? `${current.trim()}\n${value}` : value));
      setStatus({ tone: "ok", text: "已粘贴剪切板内容" });
    } catch {
      setStatus({ tone: "error", text: "浏览器不允许读取剪切板，请手动粘贴（⌘V）" });
      input.current?.focus();
    }
  }

  async function submit() {
    if (!valid.length) {
      setStatus({ tone: "error", text: "请先填入下载链接（http/https/ftp/sftp/magnet）" });
      return;
    }
    setBusy(true);
    setStatus({ tone: "idle", text: "" });
    let added = 0;
    const failures: string[] = [];
    for (const line of valid) {
      try {
        await api.addDownloadLink(line, dir.trim() || undefined);
        added += 1;
      } catch (error) {
        const typed = error as { code?: string; message?: string };
        // 官方行为：code 1000 = 已存在相同任务
        if (String(typed.code) === "1000") failures.push("已有相同任务");
        else failures.push(typed.message || "任务未提交");
      }
    }
    setBusy(false);
    if (failures.length === 0) {
      setStatus({ tone: "ok", text: `已提交 ${added} 个任务` });
      setText("");
      onDone();
    } else {
      setStatus({
        tone: "error",
        text: `成功 ${added} 个，失败 ${failures.length} 个：${failures[0]}`,
      });
      if (added > 0) onDone();
    }
  }

  return (
    <>
      <button
        ref={launcher}
        className="primary"
        disabled={!connected}
        onClick={() => {
          setOpen(true);
          setStatus({ tone: "idle", text: "" });
        }}
      >
        <LinkSimple />
        添加下载
      </button>
      <dialog
        open={open}
        className="download-dialog"
        aria-label="添加下载任务"
        onCancel={() => setOpen(false)}
      >
        <h2>添加下载任务</h2>
        <p className="muted">
          每行一个链接，支持 {protocols.join(" / ")}；磁力链接直接粘贴即可。
        </p>
        <label>
          <span>下载链接</span>
          <textarea
            ref={input}
            rows={5}
            value={text}
            placeholder={"https://example.com/file.iso\nmagnet:?xt=urn:btih:..."}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <label>
          <span>保存目录</span>
          <input
            value={dir}
            placeholder="留空使用设备默认目录"
            onChange={(event) => onDirChange(event.target.value)}
          />
        </label>
        <div className="download-dialog-actions">
          <button className="secondary" onClick={paste} disabled={!clipboard.available}>
            <ClipboardText />
            读取剪切板
          </button>
          <label className={`download-watch${clipboard.available ? "" : " unavailable"}`}>
            <input
              type="checkbox"
              checked={watch}
              disabled={!clipboard.available}
              onChange={(event) => setWatch(event.target.checked)}
            />
            自动监听剪切板
          </label>
        </div>
        {!clipboard.available && (
          <p className="download-warning" role="status">
            <Warning weight="duotone" aria-hidden="true" />
            {clipboard.reason}
          </p>
        )}
        {invalid.length > 0 && (
          <p className="download-warning" role="alert">
            <Warning weight="duotone" aria-hidden="true" />
            {invalid.length} 行不是受支持的链接格式，提交时会跳过。
          </p>
        )}
        {status.text && (
          <p
            className={`download-status ${status.tone}`}
            role={status.tone === "error" ? "alert" : "status"}
          >
            {status.text}
          </p>
        )}
        <footer>
          <button
            className="secondary"
            onClick={() => {
              setOpen(false);
              launcher.current?.focus();
            }}
          >
            取消
          </button>
          <button className="primary" disabled={busy || !valid.length} onClick={submit}>
            {busy ? "提交中…" : `开始下载${valid.length > 1 ? `（${valid.length}）` : ""}`}
          </button>
        </footer>
      </dialog>
    </>
  );
}

/** 供下载中心顶部统计使用：把任务列表压成计数。 */
export function downloadSummary(items: Item[]) {
  const running = items.filter((item) => item.metadata?.status === "loading" || item.metadata?.progress !== undefined);
  return { total: items.length, running: running.length };
}
