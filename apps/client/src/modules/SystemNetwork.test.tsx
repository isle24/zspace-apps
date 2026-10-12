import { describe, expect, it } from "vitest";
import { linkSpeed, readInterfaces } from "./SystemNetwork";

/** 真机实测的一段响应（2026-10-12，/network-settings/v1/interface/list） */
const real = {
  values: {
    code: 200,
    data: {
      list: [
        {
          name: "kvmbr0", link_name: "kvmbr0", mtu: 1500, duplex: true, speed: 10000, type: "bridge",
          mac: "f6:14:ae:83:ab:dc", status: "up", ipv4_method: "static", ipv4_address: "192.168.3.56",
          ipv4_netmask: "255.255.255.0", ipv4_gateway: "192.168.3.1", ipv4_dns_method: "static",
          ipv4_dns1: "114.114.114.114", ipv4_dns2: "223.5.5.5", ipv6_gateway: "fe80::fa20:a9ff:fea7:a20",
          metric: 100,
        },
        { name: "eth0", speed: 1000, type: "ethernet", status: "down", mac: "aa:bb:cc:dd:ee:ff" },
      ],
    },
  },
};

describe("network interface cards", () => {
  it("reads the measured shape into display rows", () => {
    const cards = readInterfaces(real);
    expect(cards).toHaveLength(2);
    const [a, b] = cards;
    expect(a.name).toBe("kvmbr0");
    expect(a.type).toBe("网桥");
    expect(a.status).toBe("up");
    expect(a.speed).toBe("10 Gbps");
    expect(a.mac).toBe("f6:14:ae:83:ab:dc");
    expect(a.ipv4).toContain("192.168.3.56 / 255.255.255.0");
    expect(a.ipv4).toContain("网关：192.168.3.1");
    expect(a.ipv4).toContain("获取方式：静态");
    expect(a.dns).toEqual(["114.114.114.114", "223.5.5.5"]);
    expect(a.ipv6).toEqual(["网关：fe80::fa20:a9ff:fea7:a20"]);
    expect(b.speed).toBe("1 Gbps");   // 1000 Mbps 及以上统一显示 Gbps
  });

  it("never invents fields the device left out", () => {
    const [b] = readInterfaces(real).slice(1);
    expect(b.ipv4).toEqual([]);      // 没给地址就没有行
    expect(b.dns).toEqual([]);
    expect(b.ipv6).toEqual([]);
    expect(b.mtu).toBeUndefined();
  });

  it("handles a missing or empty payload", () => {
    expect(readInterfaces(undefined)).toEqual([]);
    expect(readInterfaces({ values: { data: { list: [] } } })).toEqual([]);
    expect(readInterfaces({ values: { data: {} } })).toEqual([]);
  });
});

describe("link speed formatting", () => {
  it("uses Gbps above 1000 and keeps Mbps below", () => {
    expect(linkSpeed(10000)).toBe("10 Gbps");
    expect(linkSpeed(2500)).toBe("2.5 Gbps");
    expect(linkSpeed(1000)).toBe("1 Gbps");
    expect(linkSpeed(100)).toBe("100 Mbps");
    expect(linkSpeed(0)).toBeUndefined();
    expect(linkSpeed(undefined)).toBeUndefined();
  });
});

describe("settings flattening", () => {
  it("turns nested device settings into one row per key path", async () => {
    const { flattenSettings } = await import("./SystemNetwork");
    const rows = flattenSettings({
      show_hidden: 1,
      share: { number: 20, can_share: "all", nested: { deep: { deeper: 1 } } },
      list: [1, 2],
      empty: [],
      flag: true,
    });
    const map = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    expect(map["show_hidden"]).toBe("1");
    expect(map["share.number"]).toBe("20");
    expect(map["share.can_share"]).toBe("all");
    expect(map["flag"]).toBe("开启");
    expect(map["list[0]"]).toBe("1");
    expect(map["empty"]).toBe("空");
    // 超过 3 层如实说明，不展开也不编造
    expect(map["share.nested.deep"]).toBe("层级过深，未展开");
  });
});
