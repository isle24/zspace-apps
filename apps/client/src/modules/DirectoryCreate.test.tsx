import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DirectoryCreate } from "./DirectoryCreate";
import { installMissingDialogMethods } from "./directory-dialog-test";
import { api, type DirectoryCreation, type Item } from "../api/client";
import { OfficialNasError } from "../api/official-nas";

installMissingDialogMethods();
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const parent: Item = { id: "parent", name: "当前目录", kind: "directory", path: "/actual/parent" };
const ready: DirectoryCreation = { sessionId: "focus-session", outcome: "directory-ready", item: { id: "child", name: "资料", path: "/actual/parent/资料", kind: "directory" } };
function surface(sessionId = "focus-session", actualParent = parent, refresh = vi.fn()) {
  return <><button>背景前方</button><DirectoryCreate key={`${sessionId}:${actualParent.path}`} parent={actualParent} section="all" connected sessionId={sessionId} onRefresh={refresh} /><button>背景后方</button></>;
}
function open() {
  vi.spyOn(api, "nasSession", "get").mockReturnValue("focus-session");
  const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
  const view = render(surface());
  const launcher = screen.getByRole("button", { name: "新建文件夹" });
  launcher.focus();
  fireEvent.click(launcher);
  return { view, launcher, showModal, dialog: screen.getByRole("dialog", { name: "新建文件夹" }), input: screen.getByRole("textbox", { name: "文件夹名称" }) };
}
function tab(target: HTMLElement, shiftKey = false) {
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
  fireEvent(target, event);
  expect(event.defaultPrevented).toBe(true);
}
it("opens through the native modal API and explicitly cycles enabled controls in both directions", () => {
  const { dialog, input, showModal } = open();
  expect(dialog.tagName).toBe("DIALOG");
  expect(showModal).toHaveBeenCalledOnce();
  expect(dialog).toHaveAttribute("open");
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: "资料" } });
  const cancel = screen.getByRole("button", { name: "取消" });
  const submit = screen.getByRole("button", { name: "确认新建" });
  tab(input); expect(submit).toHaveFocus();
  tab(submit); expect(cancel).toHaveFocus();
  tab(cancel, true); expect(submit).toHaveFocus();
  tab(submit, true); expect(input).toHaveFocus();
});
it("keeps focus on enabled cancel while pending and restores the surviving launcher on Escape", () => {
  const create = vi.spyOn(api, "createDirectory").mockImplementation(() => new Promise(() => {}));
  const { launcher, input, dialog } = open();
  fireEvent.change(input, { target: { value: "资料" } });
  fireEvent.submit(dialog.querySelector("form")!);
  const cancel = screen.getByRole("button", { name: "取消" });
  expect(input).toBeDisabled();
  expect(cancel).toHaveFocus();
  tab(cancel); expect(cancel).toHaveFocus();
  tab(cancel, true); expect(cancel).toHaveFocus();
  fireEvent.keyDown(cancel, { key: "Escape" });
  expect(create.mock.calls[0][2]?.signal?.aborted).toBe(true);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(launcher).toHaveFocus();
});
it("moves disabled-name focus to an enabled uncertain action and cycles without reaching background controls", async () => {
  vi.spyOn(api, "createDirectory").mockRejectedValue(new OfficialNasError("hidden", "DIRECTORY_UNVERIFIED", 502, true));
  const { launcher, input, dialog } = open();
  fireEvent.change(input, { target: { value: "资料" } });
  fireEvent.submit(dialog.querySelector("form")!);
  await screen.findByRole("alert");
  const cancel = screen.getByRole("button", { name: "取消" });
  const refresh = screen.getByRole("button", { name: "刷新查看" });
  expect(input).toBeDisabled();
  expect(cancel).toHaveFocus();
  tab(cancel); expect(refresh).toHaveFocus();
  tab(refresh); expect(cancel).toHaveFocus();
  tab(cancel, true); expect(refresh).toHaveFocus();
  fireEvent.click(refresh);
  expect(launcher).toHaveFocus();
});
it.each(["cancel", "native-cancel", "success"])("restores the current launcher on %s without leaving a native modal open", async close => {
  vi.spyOn(api, "createDirectory").mockResolvedValue(ready);
  const closeModal = vi.spyOn(HTMLDialogElement.prototype, "close");
  const { launcher, dialog, input } = open();
  if (close === "cancel") fireEvent.click(screen.getByRole("button", { name: "取消" }));
  if (close === "native-cancel") {
    const event = new Event("cancel", { cancelable: true });
    fireEvent(dialog, event);
    expect(event.defaultPrevented).toBe(true);
  }
  if (close === "success") {
    fireEvent.change(input, { target: { value: "资料" } });
    await act(async () => { fireEvent.submit(dialog.querySelector("form")!); });
    expect(screen.getByText("文件夹已就绪")).toBeInTheDocument();
  }
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(closeModal).toHaveBeenCalledOnce();
  expect(launcher).toHaveFocus();
});
it.each(["unmount", "parent", "session"])("does not restore invalid background focus after %s removes the modal", async change => {
  let complete!: (value: DirectoryCreation) => void;
  const create = vi.spyOn(api, "createDirectory").mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const closeModal = vi.spyOn(HTMLDialogElement.prototype, "close");
  const { launcher, view, input, dialog } = open();
  fireEvent.change(input, { target: { value: "资料" } });
  fireEvent.submit(dialog.querySelector("form")!);
  const launcherFocus = vi.spyOn(launcher, "focus");
  const background = screen.getByRole("button", { name: "背景后方" });
  const backgroundFocus = vi.spyOn(background, "focus");
  if (change === "unmount") view.unmount();
  if (change === "parent") view.rerender(surface("focus-session", { ...parent, path: "/different/parent" }));
  if (change === "session") {
    vi.spyOn(api, "nasSession", "get").mockReturnValue("replacement-session");
    view.rerender(surface("replacement-session"));
  }
  await act(async () => { complete(ready); });
  expect(create.mock.calls[0][2]?.signal?.aborted).toBe(true);
  expect(launcherFocus).not.toHaveBeenCalled();
  expect(backgroundFocus).not.toHaveBeenCalled();
  expect(closeModal).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("keeps the old launcher disabled if the live session changes before a dismissal rerender", () => {
  const { launcher } = open();
  const focus = vi.spyOn(launcher, "focus");
  vi.spyOn(api, "nasSession", "get").mockReturnValue("replacement-before-render");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(launcher).toBeDisabled();
  expect(focus).not.toHaveBeenCalled();
});
