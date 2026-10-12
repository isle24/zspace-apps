import { useId, useLayoutEffect, useRef, useState } from "react";
import { FolderPlus } from "@phosphor-icons/react";
import { api, type Item } from "../api/client";
import { OfficialNasError } from "../api/official-nas";

const uncertainMessage = "请求已中断，文件夹可能已创建，请先刷新查看。";

function unavailableReason(parent: Item | undefined, section: string, connected: boolean) {
  if (!connected) return "请先连接 NAS 后再新建。";
  if (section === "recent") return "最近访问不能作为新建位置，请先打开一个普通文件夹。";
  if (!parent) return "请先打开一个普通文件夹后再新建。";
  const path = parent.path;
  // This is an availability hint. The SDK independently validates and reads
  // back the authoritative parent before dispatching any mutation.
  if (!path || !["directory", "folder", "root"].includes(parent.kind || "") || parent.metadata?.encrypted_path ||
    !path.startsWith("/") || /[\\\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(path) || path.length > 8192 ||
    new TextEncoder().encode(path).length > 8192 ||
    (path !== "/" && path.slice(1).split("/").some(part => !part || part === "." || part === "..")))
    return "此位置不支持新建，请打开一个普通文件夹。";
  return "";
}

function safeFailure(error: unknown) {
  if (error instanceof OfficialNasError) {
    if (error.mayHaveCreated) return uncertainMessage;
    if (error.code === "DIRECTORY_CONFLICT") return "同名文件夹已存在，请刷新查看。";
    if (error.code === "INVALID_DIRECTORY_NAME") return "请输入有效的文件夹名称（最多 255 字节）。";
    if (error.code === "INVALID_DIRECTORY_PARENT") return "NAS 未确认当前普通文件夹，请刷新查看。";
    if (error.code === "NO_SESSION" || error.code === "SESSION_EXPIRED") return "NAS 会话已失效，请重新连接。";
  }
  return "文件夹请求未完成，请检查连接后重试。";
}

// Files keys this component by session, parent and section. Synchronous cleanup
// fences completions on close/navigation even before passive effects flush.
export function DirectoryCreate({ parent, section, connected, sessionId, onRefresh }: {
  parent?: Item; section: string; connected: boolean; sessionId: string; onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState("");
  const lifetime = useRef<{ alive: boolean; operation?: AbortController }>({ alive: false });
  const launcher = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef(false);
  const feedbackId = useId();
  const reason = unavailableReason(parent, section, connected);
  useLayoutEffect(() => {
    lifetime.current.alive = true;
    return () => {
      lifetime.current.alive = false;
      lifetime.current.operation?.abort();
      lifetime.current.operation = undefined;
    };
  }, []);
  function current(controller?: AbortController) {
    return lifetime.current.alive && api.nasSession === sessionId &&
      (!controller || (lifetime.current.operation === controller && !controller.signal.aborted));
  }
  useLayoutEffect(() => {
    if (!open) {
      if (restoreFocus.current && current() && !reason && launcher.current?.isConnected)
        launcher.current.focus();
      restoreFocus.current = false;
      return;
    }
    const modal = dialog.current!;
    // Native top-layer modality excludes background pointer and focus access.
    // Always enter it via showModal, never a nonmodal `open` attribute.
    modal.showModal();
    nameInput.current?.focus();
    return () => { if (modal.open) modal.close(); };
  }, [open]);
  useLayoutEffect(() => {
    const modal = dialog.current;
    if (!open || !modal) return;
    const active = document.activeElement;
    if (!modal.contains(active) || (active instanceof HTMLInputElement && active.disabled) ||
      (active instanceof HTMLButtonElement && active.disabled))
      modal.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open, pending, uncertain]);
  function cancel() {
    if (uncertain) setNotice(uncertainMessage);
    if (lifetime.current.operation) {
      lifetime.current.operation.abort();
      lifetime.current.operation = undefined;
      setNotice(uncertainMessage);
    }
    setPending(false);
    restoreFocus.current = true;
    setOpen(false);
  }
  function refresh() {
    if (!current()) return;
    restoreFocus.current = true;
    setOpen(false);
    setNotice("");
    onRefresh();
  }
  async function submit() {
    if (reason || !parent || !name.trim() || uncertain || lifetime.current.operation || !current()) return;
    const controller = new AbortController();
    lifetime.current.operation = controller;
    setPending(true);
    setError("");
    setConflict(false);
    setNotice("");
    try {
      const result = await api.createDirectory(parent, name, { signal: controller.signal });
      if (!current(controller)) return;
      if (result.sessionId !== sessionId || result.outcome !== "directory-ready") {
        setError(uncertainMessage);
        setUncertain(true);
        return;
      }
      restoreFocus.current = true;
      setOpen(false);
      setNotice("文件夹已就绪");
      onRefresh();
    } catch (failure) {
      if (!current(controller)) return;
      setError(safeFailure(failure));
      setUncertain(failure instanceof OfficialNasError && failure.mayHaveCreated);
      setConflict(failure instanceof OfficialNasError && failure.code === "DIRECTORY_CONFLICT");
    } finally {
      if (current(controller)) {
        lifetime.current.operation = undefined;
        setPending(false);
      }
    }
  }
  return <div className="directory-create-action">
    <button ref={launcher} className="secondary" disabled={!!reason || open || api.nasSession !== sessionId} aria-describedby={feedbackId} onClick={() => {
      if (!current()) return;
      // The native dialog's previously focused node must be this launcher,
      // never an unrelated old background row. It stays disabled while open.
      launcher.current?.focus();
      setName(""); setError(""); setUncertain(false); setConflict(false); setOpen(true);
    }}><FolderPlus />新建文件夹</button>
    <small id={feedbackId} role="status">{reason || notice}</small>
    {open && <dialog ref={dialog} className="install-wizard directory-create-dialog" aria-modal="true" aria-label="新建文件夹" onCancel={event => {
      event.preventDefault(); cancel();
    }} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
      if (event.key === "Tab") {
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("*")).filter(control =>
          (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) && !control.disabled);
        const index = controls.indexOf(document.activeElement as HTMLElement);
        event.preventDefault();
        const next = index < 0 ? (event.shiftKey ? controls.length - 1 : 0)
          : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
        controls[next]?.focus();
      }
    }}>
        <header><h2>新建文件夹</h2><button type="button" className="secondary" onClick={cancel}>取消</button></header>
        <form onSubmit={event => { event.preventDefault(); void submit(); }}>
          <div className="directory-create-parent"><span>新建位置</span><strong>{parent?.name}</strong><code>{parent?.path}</code></div>
          <label>文件夹名称<input ref={nameInput} value={name} disabled={pending || uncertain} onChange={event => setName(event.target.value)} /></label>
          <p className="directory-create-hint">保留输入的名称；同名冲突时请刷新查看。</p>
          {pending && <p role="status">正在确认文件夹，请稍候…</p>}
          {error && <p className="directory-create-error" role="alert">{error}</p>}
          <footer>{conflict && !uncertain && <button type="button" className="secondary" onClick={refresh}>刷新查看</button>}{uncertain
            ? <button type="button" className="primary" onClick={refresh}>刷新查看</button>
            : <button type="submit" className="primary" disabled={pending || !name.trim()}>{pending ? "处理中…" : "确认新建"}</button>}
          </footer>
        </form>
    </dialog>}
  </div>;
}
