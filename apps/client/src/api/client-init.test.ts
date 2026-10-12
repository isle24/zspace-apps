import { afterEach, beforeEach, expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));

import { Gateway } from "./client";
beforeEach(() => {
  localStorage.clear();
  bridge.invoke.mockReset();
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke: bridge.invoke });
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});
it("ignores a delayed native service result after an external service was selected", async () => {
  let finish: (url: string) => void = () => {};
  bridge.invoke.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { items: [] } })),
    );
  const client = new Gateway(fetcher);
  const stale = client.store("catalog", undefined, true);
  const result = stale.catch((e) => e);
  await vi.waitFor(() => expect(bridge.invoke).toHaveBeenCalledTimes(1));
  await client.setStoreAddress("https://store.example.test");
  await client.store("catalog", undefined, true);
  finish("http://127.0.0.1:19999");
  await result;
  expect(client.base).toBe("https://store.example.test");
  expect(
    fetcher.mock.calls.every(([url]) =>
      String(url).startsWith("https://store.example.test"),
    ),
  ).toBe(true);
});
it("shares one native initialization promise for simultaneous shop requests", async () => {
  let finish: (url: string) => void = () => {};
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  bridge.invoke.mockImplementation(() => pending);
  const client = new Gateway(
    vi.fn(async () => new Response(JSON.stringify({ ok: true, data: {} }))),
  );
  const a = client.store("status", undefined, true),
    b = client.store("catalog", undefined, true);
  await vi.waitFor(() =>
    expect(bridge.invoke.mock.calls.length).toBeGreaterThan(0),
  );
  finish("http://127.0.0.1:19999");
  await Promise.all([a, b]);
  expect(bridge.invoke).toHaveBeenCalledTimes(1);
});
