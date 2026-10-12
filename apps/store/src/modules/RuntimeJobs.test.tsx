import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { RuntimeJobs } from "./RuntimeJobs";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  api.storeSession = "";
});
it("renders controller-shaped durable success, failure, attention and lifecycle stages in Chinese", async () => {
  api.storeSession = "test";
  const entries = [
    ["validate", "running", "执行中", "核对操作计划"],
    ["stop-source", "running", "执行中", "停止原代次服务"],
    ["prepare-copy", "running", "执行中", "准备新数据副本"],
    ["launch-verify", "running", "执行中", "启动并核验服务"],
    ["switch-generation", "running", "执行中", "切换应用代次"],
    ["complete", "succeeded", "已完成", "操作完成"],
    ["needs-attention", "needs_attention", "需处理", "需要检查"],
    ["queued", "queued", "排队中", "等待执行"],
    ["needs-attention", "failed", "失败", "需要检查"],
  ];
  vi.spyOn(api, "store").mockResolvedValue({
    items: entries.map(([stage, status], index) => ({
      id: `job${index}`,
      appId: `app${index}`,
      instanceId: `i${index}`,
      status,
      stage,
      stages: [{ name: stage, status, at: "now" }],
    })),
  });
  vi.spyOn(api, "streamStore").mockImplementation(
    async (_op, _cb, signal) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve()),
      ),
  );
  render(<RuntimeJobs />);
  for (const [index, [, , statusLabel, stageLabel]] of entries.entries()) {
    const heading = await screen.findByRole("heading", {
      name: `app${index} · ${statusLabel}`,
    });
    const card = heading.closest("article")!;
    expect(within(card).getByText(stageLabel)).toBeInTheDocument();
    expect(
      within(card).getByText(`${stageLabel} · ${statusLabel} · now`),
    ).toBeInTheDocument();
  }
});
it("offers retry only for failed recognized v2 jobs and directs attention to inspection", async () => {
  api.storeSession = "test";
  const onRetry = vi.fn(), onInspect = vi.fn();
  const failed = { id: "failed", planId: "old-plan", kind: "update", appId: "immich", instanceId: "i", status: "failed", stage: "failed" };
  vi.spyOn(api, "store").mockResolvedValue({ items: [
    failed,
    ...["queued", "running", "succeeded", "needs_attention"].map(status => ({ ...failed, id: status, status })),
    { ...failed, id: "legacy", kind: "kuma-retry" },
    { ...failed, id: "unknown", planId: undefined },
  ] });
  vi.spyOn(api, "streamStore").mockImplementation(async (_op, _cb, signal) => new Promise(resolve => signal.addEventListener("abort", () => resolve())));
  render(<RuntimeJobs onRetry={onRetry} onInspect={onInspect} />);
  const retry = await screen.findByRole("button", { name: "生成重试计划" });
  expect(screen.getAllByRole("button", { name: "生成重试计划" })).toHaveLength(1);
  retry.click();
  expect(onRetry).toHaveBeenCalledWith(failed);
  const inspect = screen.getByRole("button", { name: "检查当前应用代次" });
  inspect.click();
  expect(onInspect).toHaveBeenCalledWith("i");
  expect(screen.getByText(/需先检查当前应用代次/)).toBeInTheDocument();
});
