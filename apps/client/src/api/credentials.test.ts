import { expect, it, vi } from "vitest";
import { restoreCredentials } from "./credentials";
it("restores remembered credentials without logging in by default", async () => {
  const login = vi.fn();
  const credentials = {
    baseUrl: "http://synthetic.invalid",
    username: "fixture",
    password: "fixture-only",
    autoLogin: false,
  };
  const result = await restoreCredentials(JSON.stringify(credentials), login);
  expect(result.credentials).toEqual(credentials);
  expect(login).not.toHaveBeenCalled();
});
it("gets a fresh opaque session only for explicitly enabled automatic login", async () => {
  const login = vi.fn().mockResolvedValue({
    sessionId: "fresh-after-restart",
    baseUrl: "http://synthetic.invalid",
    user: { id: "u" },
  });
  const result = await restoreCredentials(
    JSON.stringify({
      baseUrl: "http://synthetic.invalid",
      username: "fixture",
      password: "fixture-only",
      autoLogin: true,
    }),
    login,
  );
  expect(login).toHaveBeenCalledWith(
    "http://synthetic.invalid",
    "fixture",
    "fixture-only",
  );
  expect(result.session?.sessionId).toBe("fresh-after-restart");
});
it("rejects stale stored gateway sessions rather than pretending logged in", async () => {
  const login = vi.fn();
  await expect(
    restoreCredentials(JSON.stringify({ sessionId: "old" }), login),
  ).rejects.toThrow("保存");
  expect(login).not.toHaveBeenCalled();
});
it("failure to delete remembered credentials is a warning, not a failed login", async () => {
  const { saveLoginPreference } = await import("./credentials");
  const warning = await saveLoginPreference(
    false,
    {
      baseUrl: "http://synthetic.invalid",
      username: "fixture",
      password: "fixture-only",
      autoLogin: false,
    },
    vi.fn().mockRejectedValue(new Error("vault unavailable")),
  );
  expect(warning).toContain("凭据");
});
