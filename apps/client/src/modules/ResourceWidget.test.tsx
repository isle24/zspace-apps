import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  ResourceWidget,
  formatBytes,
  formatPercent,
  formatRate,
  formatUptime,
  pick,
  readMonitor,
  sumServiceIo,
} from "./ResourceWidget";

// 与其他测试文件一致：每个用例后清理 DOM，避免跨用例重复元素
afterEach(cleanup);

describe("resource widget formatting", () => {
  it("formats rates with the fnOS units and never invents a value", () => {
    expect(formatRate(null)).toEqual({ value: "—", unit: "" });
    expect(formatRate(-1)).toEqual({ value: "—", unit: "" });
    expect(formatRate(0)).toEqual({ value: "0", unit: "B/s" });
    expect(formatRate(512)).toEqual({ value: "512", unit: "B/s" });
    expect(formatRate(1536)).toEqual({ value: "1.5", unit: "KB/s" });
    expect(formatRate(1024 * 1024 * 3.5)).toEqual({ value: "3.5", unit: "MB/s" });
    expect(formatRate(1024 ** 3 * 2)).toEqual({ value: "2.0", unit: "GB/s" });
  });

  it("formats percent, bytes and uptime honestly for missing input", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(33.4)).toBe("33%");
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(1024 ** 3 * 1.5)).toBe("1.50 GB");
    expect(formatBytes(1024 ** 2 * 47)).toBe("47.0 MB");
    expect(formatUptime(null)).toBe("—");
    expect(formatUptime(0)).toBe("0 天 0 时 0 分 0 秒");
    expect(formatUptime(86400 + 3600 + 60 + 1)).toBe("1 天 1 时 1 分 1 秒");
  });

  it("reads only the confirmed candidate field names and coerces numeric strings", () => {
    expect(pick(undefined, ["cpu"])).toBeNull();
    expect(pick({}, ["cpu"])).toBeNull();
    expect(pick({ cpu: 12 }, ["cpu", "cpu_usage"])).toBe(12);
    expect(pick({ cpu_usage: "37" }, ["cpu", "cpu_usage"])).toBe(37);
    expect(pick({ cpu: "not-a-number" }, ["cpu"])).toBeNull();
    expect(pick({ other: 5 }, ["cpu"])).toBeNull();
  });
});

describe("resource widget rendering", () => {
  it("shows dashes for every metric while disconnected", () => {
    const view = render(<ResourceWidget connected={false} />);
    const pill = view.getByRole("button", { name: "展开资源监控" });
    expect(pill).toHaveTextContent("R");
    expect(pill).toHaveTextContent("W");
    expect(pill).toHaveTextContent("CPU");
    expect(pill).toHaveTextContent("RAM");
    // 未连接时不得出现任何编造的数值或单位
    expect(pill).not.toHaveTextContent("B/s");
    expect(pill.textContent?.match(/—/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("renders real values when the official fields are present", () => {
    const view = render(
      <ResourceWidget
        connected
        values={{ cpu: 33, memory: 42, net_up: 1536, net_down: 3.4 * 1024 ** 2 }}
        hostName="my-nas"
        uptimeSeconds={3661}
      />,
    );
    const pill = view.getByRole("button", { name: "展开资源监控" });
    expect(pill).toHaveTextContent("33%");
    expect(pill).toHaveTextContent("42%");
    expect(pill).toHaveTextContent("1.5");
    expect(pill).toHaveTextContent("KB/s");
    expect(pill).toHaveTextContent("3.4");
    expect(pill).toHaveTextContent("MB/s");
  });

  it("opens the detail panel with the four fnOS cards", () => {
    const view = render(<ResourceWidget connected values={{ cpu: 1, memory: 2 }} hostName="my-nas" />);
    fireEvent.click(view.getByRole("button", { name: "展开资源监控" }));
    expect(view.getByRole("region", { name: "资源监控详情" })).toBeInTheDocument();
    for (const title of ["运行状态", "网络", "存储读写", "存储空间"]) {
      expect(view.getByText(title)).toBeInTheDocument();
    }
    expect(view.getByText("my-nas")).toBeInTheDocument();
  });

  it("reports an empty storage section instead of inventing capacity", () => {
    const view = render(<ResourceWidget connected pools={[]} />);
    fireEvent.click(view.getByRole("button", { name: "展开资源监控" }));
    expect(view.getByText("尚未读取到存储空间")).toBeInTheDocument();
  });
});

describe("official /system/recent monitor mapping", () => {
  it("maps the fields the official desktop widget reads", () => {
    // 形状取自官方前端 ZP.monitor() → POST /system/recent 的 list[0]
    const sample = readMonitor({
      list: [
        {
          cpu: { used: 0.33, temp: 45 },
          memory: { used: 0.42, total: 8 * 1024 ** 3 },
          net_speed: { download1s: 3.4 * 1024 ** 2, upload1s: 1536 },
        },
      ],
    });
    expect(sample).toMatchObject({ cpu: 33, memory: 42, up: 1536, down: 3.4 * 1024 ** 2 });
  });

  it("sums the per-interface speeds array when present", () => {
    const sample = readMonitor({
      list: [{ speeds: [{ download1s: 100, upload1s: 10 }, { download1s: 200, upload1s: 20 }] }],
    });
    expect(sample.up).toBe(30);
    expect(sample.down).toBe(300);
  });

  it("returns nulls for a missing or malformed payload instead of guessing", () => {
    const empty = {
      cpu: null, memory: null, up: null, down: null, read: null, write: null, uptimeSeconds: null,
    };
    for (const payload of [undefined, null, {}, { list: [] }, { list: [{}] }, { list: "x" }]) {
      expect(readMonitor(payload)).toEqual(empty);
    }
  });

  it("accepts an already-percent value and rejects negatives", () => {
    expect(readMonitor({ list: [{ cpu: { used: 33 } }] }).cpu).toBe(33);
    expect(readMonitor({ list: [{ cpu: { used: -1 } }] }).cpu).toBeNull();
  });
});

describe("device read/write from the official service IO sum", () => {
  it("sums io.read_ps / io.write_ps across services", () => {
    // 形状取自官方监控页：/manager/services 的条目带 io:{read_ps,write_ps}
    const io = sumServiceIo({
      data: {
        list: [
          { app_name: "a", io: { read_ps: 1024, write_ps: 2048 } },
          { app_name: "b", io: { read_ps: 512, write_ps: 0 } },
        ],
      },
    });
    expect(io).toEqual({ read: 1536, write: 2048 });
  });

  it("also accepts an already-mapped ior/iow shape and a bare list", () => {
    expect(sumServiceIo({ list: [{ ior: 100, iow: 200 }, { ior: 1, iow: 2 }] })).toEqual({
      read: 101,
      write: 202,
    });
  });

  it("does not double count nested processes and reports null when nothing is readable", () => {
    const io = sumServiceIo({
      list: [
        { io: { read_ps: 100, write_ps: 50 }, processes: [{ io: { read_ps: 999, write_ps: 999 } }] },
      ],
    });
    expect(io).toEqual({ read: 100, write: 50 });
    for (const payload of [undefined, null, {}, { data: {} }, { list: [] }, { list: [{}] }]) {
      expect(sumServiceIo(payload)).toEqual({ read: null, write: null });
    }
  });

  it("renders the summed rates in the pill", () => {
    const view = render(
      <ResourceWidget connected monitor={readMonitor({ list: [{}] })} io={{ read: 1536, write: 2048 }} />,
    );
    const pill = view.getByRole("button", { name: "展开资源监控" });
    expect(pill).toHaveTextContent("1.5");
    expect(pill).toHaveTextContent("2.0");
    expect(pill).toHaveTextContent("KB/s");
  });
});

it("provides an accessible move handle and constrains restored position",()=>{
 localStorage.setItem("space-resource-position",JSON.stringify({x:99999,y:-50}));
 const view=render(<ResourceWidget connected={false}/>);expect(view.getByRole("button",{name:"拖动资源监控"})).toBeInTheDocument();
 const root=view.container.querySelector(".resource-widget") as HTMLElement;expect(parseFloat(root.style.left)).toBeLessThanOrEqual(window.innerWidth);expect(parseFloat(root.style.top)).toBeGreaterThanOrEqual(8);
 localStorage.removeItem("space-resource-position");
});
