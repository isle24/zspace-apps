import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StorageView, SystemOverview } from "./SystemOverview";
import { api } from "../api/client";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  api.logoutNas();
});

/** 真实报文夹具：取自 2026-10-11 极空间 Z425 的抓包（数值做了脱敏/改写）。 */
const recent = {
  items: [],
  values: {
    list: [
      {
        basic: { name: "Z425-OWBA", nasid: "Z00000000000" },
        hard: { model: "Z425", cpu: "Intel Core Ultra processors 125H, 14核" },
        cpu: { name: "Intel Core Ultra 5 225H", temp: 74, used: 0.1 },
        memory: { total: 25769803776, used: 0.59 },
        cpu_fan: { state: 0, ctr: 8, speed: 4284 },
        uptime: "1562319",
        disks: [
          { dev: "sde", total: 7975792017408, used: 1780500811776, temp: 39, state: 0 },
          { dev: "sdd", total: 4000787030016, used: 1000000000000, temp: 35, state: 0 },
        ],
      },
    ],
  },
};

const home = {
  items: [],
  values: { color: "al_c_gray", product: "z425", total: 41901774630912, used: 26141117722624, myused: 1073741824, user_cnt: 17 },
};

function signedIn(responses: Record<string, unknown>) {
  vi.spyOn(api, "read").mockImplementation(async (operation: string) => responses[operation] as never);
  // SystemOverview 只读取，不依赖真实会话；但需要 connected=true
  return render(<SystemOverview connected />);
}

describe("control panel uses real fields instead of a JSON dump", () => {
  it("renders device, live load, capacity and per-disk figures", async () => {
    signedIn({ "system.monitor": recent, "system.overview": home });
    expect(await screen.findByText("Z425-OWBA")).toBeInTheDocument();
    expect(screen.getByText(/Z425 · Z00000000000/)).toBeInTheDocument();
    expect(screen.getByText("10%")).toBeInTheDocument();          // cpu.used 0.1
    expect(screen.getByText("59%")).toBeInTheDocument();          // memory.used 0.59
    expect(screen.getByText("4284 rpm")).toBeInTheDocument();     // cpu_fan.speed
    expect(screen.getByText("18 天 1 小时")).toBeInTheDocument(); // uptime 1562319s = 18d1h
    expect(screen.getByText("17 个")).toBeInTheDocument();        // user_cnt
    expect(screen.getByText("sde")).toBeInTheDocument();
    expect(screen.getByText("39°C")).toBeInTheDocument();
    // 不应再出现原始 JSON 的键名
    expect(screen.queryByText("user_cnt")).not.toBeInTheDocument();
    expect(screen.queryByText("myused")).not.toBeInTheDocument();
    expect(screen.queryByText("al_c_gray")).not.toBeInTheDocument();
  });

  it("shows dashes rather than inventing numbers when the device omits fields", async () => {
    signedIn({ "system.monitor": { items: [], values: { list: [{ basic: { name: "mini" } }] } }, "system.overview": { items: [], values: {} } });
    expect(await screen.findByText("mini")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(2);
  });

  it("explains an unrecognised payload instead of dumping it", async () => {
    signedIn({ "system.monitor": { items: [], values: { unexpected: 1 } }, "system.overview": { items: [], values: {} } });
    expect(await screen.findByText("设备没有返回可识别的概览数据")).toBeInTheDocument();
  });
});

describe("storage view uses the parsed pool model", () => {
  const poolsFixture = {
    items: [
      { id: "7", name: "nvme11", kind: "storage", size: 2048,
        metadata: { id: 7, name: "nvme11", protocol: "protnvme", pool_type: "single", status: "ok",
          total_size: 2048, free_size: 1024,
          disk_list: [{ sn: "d1", dev_type: "NVME", pos: 1, total_size: 2048 }] } },
    ],
    values: { sp_ver: "v3", esp_ver: "v2" },
  };

  it("renders pools with type, protocol, usage and disks", async () => {
    vi.spyOn(api, "read").mockResolvedValue(poolsFixture as never);
    render(<StorageView connected />);
    expect(await screen.findByText("nvme11")).toBeInTheDocument();
    expect(screen.getByText(/单盘 · NVMe/)).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();       // total_size 2048
    // free_size 1024 与 used = total - free 都是 1.0 KB，两处都该出现
    expect(screen.getAllByText("1.0 KB").length).toBe(2);
    expect(screen.getByText("M.2 NVMe")).toBeInTheDocument();
    expect(screen.getByText(/位置 1 · 2.0 KB/)).toBeInTheDocument();
    expect(screen.queryByText("pool_list")).not.toBeInTheDocument(); // 不再出现原始字段名
  });

  it("explains an unknown or empty storage shape instead of dumping it", async () => {
    vi.spyOn(api, "read").mockResolvedValue({ items: [], values: { sp_ver: "v4" } } as never);
    render(<StorageView connected />);
    expect(await screen.findByText("没有读到存储池")).toBeInTheDocument();
    expect(screen.getByText(/版本 v4/)).toBeInTheDocument();
  });
});
