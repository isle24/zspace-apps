import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { readMonitor, ResourceWidget, sumServiceIo } from "./ResourceWidget";

afterEach(cleanup);

/**
 * 真实报文夹具：字段名与结构取自 2026-10-11 在极空间 Z425 上抓到的
 * POST /system/recent 响应（只保留形状，数值做了脱敏/改写）。
 * SDK 的 api.read() 返回 { items, total, values }，values 是清洗后的原始报文——
 * 这里就是按这个形状喂进去的，曾经因为只读顶层 list 导致挂件全是「—」。
 */
const collection = {
  items: [],
  values: {
    list: [
      {
        cpu: { name: "Intel Core Ultra 5 225H", temp: 75, used: 0.1 },
        memory: { total: 25769803776, used: 0.59, extra: -1 },
        net_speed: { download1s: 19707, upload1s: 167605 },
        speeds: [{ iface: "eth1", download1s: 19707, upload1s: 167605 }],
        uptime: "1562379",
        disks: [
          { dev: "sde", rps: 1024, wps: 2048, temp: 39 },
          { dev: "sdd", rps: 0, wps: 512, temp: 35 },
        ],
        fan: { ctr: 8, speed: 1225 },
        cpu_fan: { ctr: 8, speed: 4223 },
      },
    ],
  },
};

describe("real /system/recent payload (measured on the device)", () => {
  it("reads the numbers out of the SDK collection wrapper", () => {
    expect(readMonitor(collection)).toEqual({
      cpu: 10,           // used: 0.1 -> 10%
      memory: 59,        // used: 0.59 -> 59%
      up: 167605,
      down: 19707,
      read: 1024,        // disks[].rps 求和
      write: 2560,       // disks[].wps 求和
      uptimeSeconds: 1562379,
    });
  });

  it("still accepts a bare payload as well as the wrapper", () => {
    const bare = { list: collection.values.list };
    expect(readMonitor(bare).cpu).toBe(10);
    expect(readMonitor({ data: { list: collection.values.list } }).memory).toBe(59);
  });

  it("renders those numbers instead of dashes", () => {
    const view = render(<ResourceWidget connected monitor={readMonitor(collection)} />);
    const pill = view.getByRole("button", { name: "展开资源监控" });
    // 实测渲染结果：R1.0KB/s W2.5KB/s ↑163.7KB/s ↓19.2KB/s CPU10% RAM59%
    expect(pill).toHaveTextContent("10%");
    expect(pill).toHaveTextContent("59%");
    expect(pill).toHaveTextContent("163.7KB/s"); // 167605 B/s
    expect(pill).toHaveTextContent("19.2KB/s");  // 19707 B/s
    expect(pill).toHaveTextContent("1.0KB/s");   // read 1024
    expect(pill).toHaveTextContent("2.5KB/s");   // write 2560
    fireEvent.click(pill);
    const panel = view.getByRole("region", { name: "资源监控详情" });
    // 面板里数值与单位之间是真实空格（胶囊里靠 CSS 间距）
    expect(panel).toHaveTextContent("R 1.0 KB/s");
    expect(panel).toHaveTextContent("W 2.5 KB/s");
    expect(panel).toHaveTextContent("10%");
    expect(panel).toHaveTextContent("59%");
  });
});

describe("service io payload from /manager/services", () => {
  it("reads the list through the collection wrapper too", () => {
    const wrapped = { items: [], values: { list: [{ io: { read_ps: 100, write_ps: 200 } }] } };
    expect(sumServiceIo(wrapped)).toEqual({ read: 100, write: 200 });
  });
});
