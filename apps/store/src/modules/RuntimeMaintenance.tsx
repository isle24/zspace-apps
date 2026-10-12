import { useEffect, useRef, useState } from "react";
import { api, message } from "../api/client";
import { createId } from "../api/id";

type MaintenanceRecord = {
  id: string;
  requestId: string;
  purpose: "store-update";
  status: "quiesced" | "resumed";
  createdAt: string;
  resumedAt?: string;
};
type MaintenanceView = {
  state: "ready" | "quiesced";
  current?: MaintenanceRecord;
};
type Intent =
  | { kind: "pause"; requestId: string }
  | { kind: "resume"; id: string };
function validCreatedAt(value: unknown) {
  if (typeof value !== "string") return false;
  // Maintenance writes use time.Now().UTC(): RFC3339Nano with a Z suffix.
  // Check the calendar directly; Date.parse normalizes nonexistent dates.
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!parts) return false;
  const [, year, month, day, hour, minute, second, fraction] = parts;
  const y = Number(year), m = Number(month), d = Number(day);
  const days = [
    31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
  ];
  const zeroTime = y === 1 && m === 1 && d === 1 &&
    Number(hour) === 0 && Number(minute) === 0 && Number(second) === 0 &&
    !/[1-9]/.test(fraction || "");
  return m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1] &&
    Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59 && !zeroTime;
}
function verifiedView(value: MaintenanceView) {
  const record = value?.current;
  if (value?.state === "ready" && !("current" in value)) return value;
  if (
    value?.state === "quiesced" &&
    record?.status === "quiesced" &&
    record.purpose === "store-update" &&
    typeof record.id === "string" &&
    /^[A-Fa-f0-9]{48}$/.test(record.id) &&
    typeof record.requestId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(record.requestId) &&
    validCreatedAt(record.createdAt) &&
    !("resumedAt" in record)
  )
    return value;
  throw new Error("维护状态无法核验，请重新读取");
}

export function RuntimeMaintenance() {
  const [view, setView] = useState<MaintenanceView>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const serial = useRef(0);
  const locked = useRef(false);
  const scope = useRef<ReturnType<typeof api.captureStoreScope> | undefined>(undefined);
  const intent = useRef<Intent | undefined>(undefined);
  const current = (ticket: number) => {
    const now = api.captureStoreScope();
    return (
      mounted.current &&
      ticket === serial.current &&
      !!api.storeSession &&
      scope.current?.generation === now.generation &&
      scope.current?.storeAddress === now.storeAddress
    );
  };
  async function load(adopt = false) {
    if (locked.current || !mounted.current) return;
    if (adopt) scope.current = api.captureStoreScope();
    const ticket = ++serial.current;
    if (!current(ticket)) return;
    locked.current = true;
    setLoading(true);
    setError("");
    setView(undefined);
    try {
      const result = await api.store<MaintenanceView>("v2/maintenance");
      if (!current(ticket)) return;
      setView(verifiedView(result));
      intent.current = undefined;
      setConfirmed(false);
    } catch (e) {
      if (current(ticket)) setError(message(e));
    } finally {
      if (current(ticket)) {
        locked.current = false;
        setLoading(false);
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    scope.current = api.captureStoreScope();
    const clear = () => {
      const now = api.captureStoreScope();
      if (
        scope.current?.generation === now.generation &&
        scope.current?.storeAddress === now.storeAddress
      )
        return;
      serial.current++;
      scope.current = undefined;
      intent.current = undefined;
      locked.current = false;
      setView(undefined);
      setConfirmed(false);
      setBusy(false);
      setLoading(false);
      setError(
        api.storeSession
          ? "服务或会话已改变，请重新读取维护状态"
          : "请先登录商店管理员，再读取维护状态",
      );
    };
    window.addEventListener("space-store-session", clear);
    window.addEventListener("space-store-address", clear);
    if (api.storeSession) void load();
    else {
      setLoading(false);
      setError("请先登录商店管理员，再读取维护状态");
    }
    return () => {
      mounted.current = false;
      serial.current++;
      scope.current = undefined;
      intent.current = undefined;
      locked.current = false;
      window.removeEventListener("space-store-session", clear);
      window.removeEventListener("space-store-address", clear);
    };
  }, []);
  async function change() {
    if (locked.current || !view || !current(serial.current)) return;
    if (!intent.current) {
      if (view.state === "ready") {
        if (!confirmed) return;
        intent.current = { kind: "pause", requestId: createId() };
      } else intent.current = { kind: "resume", id: view.current!.id };
    }
    const action = intent.current;
    const ticket = ++serial.current;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await api.store<MaintenanceRecord>(
        action.kind === "pause"
          ? "v2/maintenance/quiesce"
          : `v2/maintenance/${action.id}/resume`,
        action.kind === "pause" ? { requestId: action.requestId } : {},
      );
      if (!current(ticket)) return;
      // A POST may replay history. Only the fresh view determines current state.
      setView(undefined);
      setLoading(true);
      const result = await api.store<MaintenanceView>("v2/maintenance");
      if (!current(ticket)) return;
      setView(verifiedView(result));
      intent.current = undefined;
      setConfirmed(false);
    } catch (e) {
      if (current(ticket)) setError(message(e));
    } finally {
      if (current(ticket)) {
        locked.current = false;
        setBusy(false);
        setLoading(false);
      }
    }
  }
  return (
    <section className="runtime-card" aria-labelledby="runtime-maintenance-title">
      <h3 id="runtime-maintenance-title">商店维护</h3>
      <p className="hint">
        暂停接收新操作后，现有应用继续运行。仅在没有待处理任务时可以暂停。
      </p>
      <p className="hint">
        此处只管理维护状态；软件版本切换仍须独立审核流程。
      </p>
      {loading && <p role="status">正在读取维护状态…</p>}
      {error && <p role="alert">{error}</p>}
      {view && (
        <>
          <p role="status">
            {view.state === "ready" ? "正在接收新操作" : "已暂停接收新操作"}
          </p>
          {view.current && (
            <dl className="data-values">
              <div><dt>当前维护记录</dt><dd>{view.current.id}</dd></div>
              <div><dt>暂停时间</dt><dd>{view.current.createdAt}</dd></div>
            </dl>
          )}
          {view.state === "ready" && (
            <label className="check-field">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              我已确认暂停接收新操作，现有应用继续运行
            </label>
          )}
          <button
            className="primary"
            disabled={busy || (view.state === "ready" && !confirmed)}
            onClick={() => void change()}
          >
            {busy ? "处理中…" : view.state === "ready" ? "暂停接收新操作" : "恢复接收操作"}
          </button>
        </>
      )}
      <button
        disabled={loading || busy || !api.storeSession}
        onClick={() => void load(true)}
      >
        重新读取维护状态
      </button>
    </section>
  );
}
