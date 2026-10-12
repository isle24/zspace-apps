import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { RuntimePlanReview } from "./RuntimePlanReview";
import type { RuntimePlan } from "./runtime-types";
const retry: RuntimePlan = {
  id: "retry-plan", kind: "install", appId: "immich", instanceId: "fresh-instance",
  generationId: "fresh-generation", retryOfJobId: "failed-job", retryOfPlanId: "failed-plan",
  targetVersion: "3.3.1", dataPath: "/data/fresh-directory", hostPort: 2283,
  expiresAt: new Date(Date.now() + 60000).toISOString(), images: [], recipe: { services: [] },
};
beforeEach(() => { api.storeSession = "review-session"; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); api.storeSession = ""; });
it("labels the fresh install retry instance and preserves the failed provenance", () => {
  render(<RuntimePlanReview plans={[retry]} onClose={vi.fn()} onSubmitted={vi.fn()} />);
  expect(screen.getByText("新实例").nextElementSibling).toHaveTextContent("fresh-instance");
  expect(screen.getByText("失败任务").nextElementSibling).toHaveTextContent("failed-job");
  expect(screen.getByText("失败计划").nextElementSibling).toHaveTextContent("failed-plan");
  expect(screen.getByText("数据目录").nextElementSibling).toHaveTextContent("/data/fresh-directory");
});
it("allocates a fresh execution request id per retry review and blocks duplicate confirmations", async () => {
  const submitted = vi.fn();
  let finish!: (value: unknown) => void;
  vi.spyOn(api, "store").mockImplementation(async () => new Promise(resolve => { finish = resolve; }));
  const show = (id: string) => render(<RuntimePlanReview plans={[{ ...retry, id }]} onClose={vi.fn()} onSubmitted={submitted} />);
  const first = show("retry-one");
  fireEvent.click(screen.getByRole("checkbox", { name: /已核对/ }));
  const execute = screen.getByRole("button", { name: "确认执行" });
  fireEvent.click(execute);
  fireEvent.click(execute);
  expect(api.store).toHaveBeenCalledTimes(1);
  const firstBody = vi.mocked(api.store).mock.calls[0][1] as { requestId: string };
  finish({ id: "job-one" });
  await waitFor(() => expect(submitted).toHaveBeenCalledTimes(1));
  first.unmount();
  show("retry-two");
  expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /已核对/ }));
  fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
  expect(api.store).toHaveBeenCalledTimes(2);
  const secondBody = vi.mocked(api.store).mock.calls[1][1] as { requestId: string };
  expect(secondBody.requestId).not.toBe(firstBody.requestId);
  finish({ id: "job-two" });
  await waitFor(() => expect(submitted).toHaveBeenCalledTimes(2));
});
