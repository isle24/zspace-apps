import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { StandaloneStore } from "./StandaloneStore";
import { api } from "./api/client";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  api.storeSession = "";
});
it("browses with an independent store session without a NAS account or NAS requests", async () => {
  api.storeSession="b".repeat(48);
  const fetcher = vi.fn(
    async (input: string) =>
      new Response(
        JSON.stringify({
          ok: true,
          data: String(input).endsWith("/status")
            ? { configured: true, engineMode: "sshbind", engineReady: true }
            : {
                items: [
                  {
                    id: "synthetic",
                    name: "Standalone app",
                    category: "media",
                    description: "Fixture",
                    version: "1",
                    installable: false,
                  },
                ],
              },
        }),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  render(<StandaloneStore />);
  expect(await screen.findByText("Standalone app")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "管理员已登录" }),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("设备地址")).not.toBeInTheDocument();
  expect(
    fetcher.mock.calls.every(([url]) => String(url).includes("/api/store/")),
  ).toBe(true);
});
