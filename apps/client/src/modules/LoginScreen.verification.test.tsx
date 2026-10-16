import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LoginScreen } from "./LoginScreen";
import { api } from "../api/client";
import { OfficialNasError, OfficialNasVerificationRequired } from "../api/official-nas";

const baseUrl = "http://nas.test:5055", username = "synthetic-user", password = "synthetic-password";
const session = { sessionId: "session", baseUrl, user: { username } };
let onLogin = vi.fn();
function renderLogin() { return render(<LoginScreen onLogin={onLogin} onPreview={vi.fn()} onStore={vi.fn()} saved={{ baseUrl, username, password, autoLogin: false }} />); }
async function start() { renderLogin(); fireEvent.click(screen.getByRole("button", { name: "登录" })); await screen.findByRole("button", { name: "发送验证码" }); }
beforeEach(() => {
  onLogin = vi.fn();
  vi.spyOn(api, "login").mockRejectedValue(new OfficialNasVerificationRequired({ id: "challenge", expiresAt: Date.now() + 300_000 }));
  vi.spyOn(api, "sendLoginVerificationCode").mockResolvedValue({ retryAt: Date.now() + 60_000 });
  vi.spyOn(api, "completeLoginVerification").mockResolvedValue(session);
  vi.spyOn(api, "cancelLoginVerification").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("offers an explicit send action, then checks the code with the entered password and logs in", async () => {
  await start();
  expect(api.sendLoginVerificationCode).not.toHaveBeenCalled();
  expect(screen.getByLabelText("密码")).toHaveValue(password);
  expect(screen.getByRole("button", { name: "验证并登录" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
  await waitFor(() => expect(api.sendLoginVerificationCode).toHaveBeenCalledWith("challenge", baseUrl, username));
  const code = screen.getByLabelText("短信验证码");
  fireEvent.change(code, { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "验证并登录" }));
  await waitFor(() => expect(api.completeLoginVerification).toHaveBeenCalledWith("challenge", { baseUrl, username, password, code: "123456" }));
  await waitFor(() => expect(onLogin).toHaveBeenCalledWith(session, ""));
  expect(screen.getByLabelText("密码")).toHaveValue("");
});
it("clears verification when account or device changes and ignores stale replies", async () => {
  let resolve!: (value: { retryAt: number }) => void;
  vi.mocked(api.sendLoginVerificationCode).mockImplementation(() => new Promise(done => { resolve = done; }));
  await start(); fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
  fireEvent.change(screen.getByLabelText("账号"), { target: { value: "other-user" } });
  expect(screen.queryByLabelText("短信验证码")).not.toBeInTheDocument();
  await act(async () => { resolve({ retryAt: Date.now() + 60_000 }); });
  expect(screen.queryByLabelText("短信验证码")).not.toBeInTheDocument();
  expect(api.cancelLoginVerification).toHaveBeenCalled(); expect(onLogin).not.toHaveBeenCalled();
});
it("preserves the challenge and password after an incorrect code and allows retry", async () => {
  vi.mocked(api.completeLoginVerification).mockRejectedValueOnce(new OfficialNasError("验证码校验未完成，请重试", "VERIFICATION_FAILED", 400));
  await start(); fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "验证并登录" })).toBeDisabled());
  fireEvent.change(screen.getByLabelText("短信验证码"), { target: { value: "1234" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "验证并登录" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "验证并登录" }));
  await screen.findByText("验证码校验未完成，请重试");
  expect(screen.getByLabelText("密码")).toHaveValue(password);
  fireEvent.click(screen.getByRole("button", { name: "验证并登录" }));
  await waitFor(() => expect(onLogin).toHaveBeenCalled());
});
it("cancels verification explicitly and discards a late login response after editing credentials", async () => {
  await start(); fireEvent.click(screen.getByRole("button", { name: "取消验证" }));
  expect(screen.queryByLabelText("短信验证码")).not.toBeInTheDocument();
  let resolve!: (value: typeof session) => void;
  vi.mocked(api.login).mockImplementation(() => new Promise(done => { resolve = done; }));
  fireEvent.click(screen.getByRole("button", { name: "登录" }));
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "changed-password" } });
  await act(async () => { resolve(session); });
  expect(onLogin).not.toHaveBeenCalled();
});
