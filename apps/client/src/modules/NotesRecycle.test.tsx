import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api/client";
import { NotesWindow } from "./NotesWindow";
import { RecycleWindow } from "./RecycleWindow";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("opens an existing Markdown note and saves only after explicit click", async () => {
  vi.spyOn(api, "read").mockResolvedValue({ items: [{ id: "9", name: "工作便签", metadata: { note_type: 2 } }], total: 1 });
  vi.spyOn(api, "note").mockResolvedValue({ id: "9", title: "工作便签", body: "原内容", noteType: 2, classifyId: 0 });
  const save = vi.spyOn(api, "saveNote").mockResolvedValue({ id: "9", title: "工作便签", body: "编辑后", noteType: 2, classifyId: 0 });
  render(<NotesWindow connected />);
  fireEvent.click(await screen.findByRole("button", { name: /工作便签/ }));
  fireEvent.change(await screen.findByRole("textbox", { name: "便签内容" }), { target: { value: "编辑后" } });
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "保存便签" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ id: "9", title: "工作便签", body: "编辑后", expectedBody: "原内容", expectedTitle: "工作便签" }));
  expect(await screen.findByText("便签已保存。" )).toBeInTheDocument();
});
it("leaves rich text content intact when editing its title", async () => {
  vi.spyOn(api, "read").mockResolvedValue({ items: [{ id: "9", name: "富文本", metadata: { note_type: 0 } }], total: 1 });
  vi.spyOn(api, "note").mockResolvedValue({ id: "9", title: "富文本", body: "<h1>富文本</h1><p>Rich <b>content</b></p>", noteType: 0, classifyId: 0 });
  render(<NotesWindow connected />); fireEvent.click(await screen.findByRole("button", { name: /富文本/ }));
  expect(await screen.findByText(/Rich content/)).toBeInTheDocument(); expect(screen.queryByRole("textbox", { name: "便签内容" })).not.toBeInTheDocument();
});
it("reads the bin and confirms the selected restore, never auto clears the bin", async () => {
  const read = vi.spyOn(api, "read").mockResolvedValue({ items: [{ id: "review", path: "/.recycle/my/review", name: "测试.txt", size: 20 }], total: 1 });
  const act = vi.spyOn(api, "recycleAction").mockResolvedValue({ accepted: true });
  render(<RecycleWindow connected />);
  expect(await screen.findByText("测试.txt")).toBeInTheDocument(); expect(read).toHaveBeenCalledWith("recycle.list", { scope: "personal", page: 1, pageSize: 20 });
  fireEvent.click(screen.getByRole("button", { name: "恢复 测试.txt" })); expect(act).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));
  await waitFor(() => expect(act).toHaveBeenCalledWith({ scope: "personal", path: "/.recycle/my/review", action: "restore", page: 1 })); expect(screen.queryByRole("button", { name: "清空回收站" })).not.toBeInTheDocument();
});
