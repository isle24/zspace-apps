/*
 * 远程访问（对齐极空间「远程访问」界面）。
 *
 * 用户截图里的真实形态：一个**局域网服务入口列表** —— 彩色磁贴 + 首字母圆标 + 名称，
 * 顶部「新建」，拖动排序，右键编辑/删除；新建弹窗有 备注 / 颜色 / 地址 / 代理模式 /
 * 发送快捷方式到桌面。
 *
 * 数据存在本机（见 shortcuts.ts），**不写进 NAS**；设备真实的中转测速状态放在
 * 下方一张折叠卡片里（那是设备数据，但并不是这个界面的主体）。
 */
import { useEffect, useRef, useState } from "react";
import { DotsThree, Plus, Question, X } from "@phosphor-icons/react";
import {
  SHORTCUT_COLORS,
  newShortcutId,
  parseAddress,
  readShortcuts,
  shortcutLetter,
  writeShortcuts,
  type Shortcut,
} from "./shortcuts";
import { RemoteRelayCard } from "./RemoteAccess";

type Draft = {
  id?: string;
  name: string;
  note: string;
  host: string;
  scheme: "http://" | "https://";
  color: string;
  onDesktop: boolean;
};

const emptyDraft = (): Draft => ({
  name: "",
  note: "",
  host: "",
  scheme: "http://",
  color: SHORTCUT_COLORS[2],
  onDesktop: false,
});

export function RemoteShortcuts() {
  const [rows, setRows] = useState<Shortcut[]>(() => readShortcuts());
  const [draft, setDraft] = useState<Draft>();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number }>();
  const [formError, setFormError] = useState("");
  const dragFrom = useRef<number | null>(null);

  useEffect(() => {
    writeShortcuts(rows);
  }, [rows]);

  const open = (row: Shortcut) => {
    // 客户端里由系统浏览器打开；网页里新标签页打开。
    window.open(row.url, "_blank", "noopener,noreferrer");
  };

  const save = () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setFormError("请填写名称");
      return;
    }
    const { url, error } = parseAddress(`${draft.scheme}${draft.host.replace(/^https?:\/\//i, "")}`);
    if (!url) {
      setFormError(error || "地址不正确");
      return;
    }
    setRows((list) => {
      if (draft.id) {
        return list.map((row) =>
          row.id === draft.id
            ? { ...row, name, note: draft.note.trim(), url, color: draft.color, onDesktop: draft.onDesktop }
            : row,
        );
      }
      return [
        ...list,
        {
          id: newShortcutId(),
          name,
          note: draft.note.trim(),
          url,
          color: draft.color,
          proxy: false,
          onDesktop: draft.onDesktop,
        },
      ];
    });
    setDraft(undefined);
    setFormError("");
  };

  const remove = (id: string) => setRows((list) => list.filter((row) => row.id !== id));

  const reorder = (from: number, to: number) => {
    setRows((list) => {
      if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
      const next = [...list];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  return (
    <div className="remote-shortcuts">
      <div className="shortcut-head">
        <p>拖动改变顺序，鼠标右键点击编辑或删除。</p>
        <button className="shortcut-new" onClick={() => { setDraft(emptyDraft()); setFormError(""); }}>
          <Plus weight="bold" /> 新建
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="settings-empty">
          还没有入口。点右上角「新建」，把路由器、EMBY、qBittorrent 这类局域网地址加进来。
        </p>
      ) : (
        <div className="shortcut-grid" onDragOver={(event) => event.preventDefault()}>
          {rows.map((row, index) => (
            <div
              key={row.id}
              className="shortcut-tile"
              style={{ background: row.color }}
              draggable
              onDragStart={() => (dragFrom.current = index)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (dragFrom.current !== null) reorder(dragFrom.current, index);
                dragFrom.current = null;
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ id: row.id, x: event.clientX, y: event.clientY });
              }}
              onDoubleClick={() => open(row)}
            >
              <span className="shortcut-avatar" aria-hidden="true">{shortcutLetter(row.name)}</span>
              <span className="shortcut-name">
                <strong>{row.name}</strong>
                {row.note && <small>{row.note}</small>}
              </span>
              <button
                className="shortcut-more"
                aria-label={`${row.name} 的更多操作`}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenu({ id: row.id, x: event.clientX, y: event.clientY });
                }}
              >
                <DotsThree weight="bold" />
              </button>
              <button className="shortcut-open" onClick={() => open(row)} aria-label={`打开 ${row.name}`} />
            </div>
          ))}
        </div>
      )}

      <RemoteRelayCard />

      {menu && (
        <>
          <div className="shortcut-scrim" onClick={() => setMenu(undefined)} />
          <div className="shortcut-menu" style={{ left: menu.x, top: menu.y }} role="menu">
            <button
              onClick={() => {
                const row = rows.find((item) => item.id === menu.id);
                if (row)
                  setDraft({
                    id: row.id,
                    name: row.name,
                    note: row.note,
                    host: row.url.replace(/^https?:\/\//i, ""),
                    scheme: row.url.startsWith("https://") ? "https://" : "http://",
                    color: row.color,
                    onDesktop: row.onDesktop,
                  });
                setMenu(undefined);
              }}
            >
              编辑
            </button>
            <button
              onClick={() => {
                remove(menu.id);
                setMenu(undefined);
              }}
            >
              删除
            </button>
          </div>
        </>
      )}

      {draft && (
        <div className="shortcut-modal-scrim" role="dialog" aria-label="新建入口" aria-modal="true">
          <div className="shortcut-modal">
            <header>
              <h2>{draft.id ? "编辑" : "新建"}</h2>
              <button className="icon-button" aria-label="关闭" onClick={() => setDraft(undefined)}>
                <X />
              </button>
            </header>

            <label className="shortcut-field">
              <span className="shortcut-preview" style={{ background: draft.color }}>
                <span className="shortcut-avatar">{shortcutLetter(draft.name || "?")}</span>
                <strong>{draft.name || "名称"}</strong>
              </span>
            </label>

            <label className="shortcut-field">
              <span className="shortcut-label">名称</span>
              <input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="例如 EMBY"
              />
            </label>

            <label className="shortcut-field">
              <span className="shortcut-label">备注</span>
              <span className="shortcut-inline">
                <input
                  value={draft.note}
                  onChange={(event) => setDraft({ ...draft, note: event.target.value })}
                  placeholder="请输入链接的备注名称"
                />
                <span className="shortcut-colors" role="group" aria-label="磁贴颜色">
                  {SHORTCUT_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      aria-label={`颜色 ${color}`}
                      aria-pressed={draft.color === color}
                      className={draft.color === color ? "active" : ""}
                      style={{ background: color }}
                      onClick={() => setDraft({ ...draft, color })}
                    />
                  ))}
                </span>
              </span>
            </label>

            <label className="shortcut-field">
              <span className="shortcut-label">地址</span>
              <span className="shortcut-inline">
                <select
                  value={draft.scheme}
                  onChange={(event) => setDraft({ ...draft, scheme: event.target.value as Draft["scheme"] })}
                  aria-label="协议"
                >
                  <option value="http://">http://</option>
                  <option value="https://">https://</option>
                </select>
                <input
                  value={draft.host}
                  onChange={(event) => setDraft({ ...draft, host: event.target.value })}
                  placeholder="例如：127.0.0.1:5244/path"
                />
                <Question className="shortcut-help" />
              </span>
            </label>

            <label className="shortcut-check">
              <input
                type="checkbox"
                checked={false}
                disabled
                title="这个客户端没有服务端中转能力，代理模式无法实现"
              />
              代理模式
              <small>（本客户端没有中转服务，无法代理）</small>
            </label>
            <label className="shortcut-check">
              <input
                type="checkbox"
                checked={draft.onDesktop}
                onChange={(event) => setDraft({ ...draft, onDesktop: event.target.checked })}
              />
              发送快捷方式到桌面
            </label>

            <div className="shortcut-notes">
              <strong>注意</strong>
              <p>支持局域网 IP 地址。名称与地址只保存在这台设备上，不会同步到 NAS。</p>
              <p>需要跳转的链接请填写跳转后的地址，例如部分华硕路由器最终地址是 https://IP:8443。</p>
            </div>

            {formError && (
              <p className="shortcut-error" role="alert">
                {formError}
              </p>
            )}

            <footer>
              <button className="shortcut-cancel" onClick={() => setDraft(undefined)}>
                取消
              </button>
              <button className="shortcut-confirm" onClick={save}>
                确定
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
