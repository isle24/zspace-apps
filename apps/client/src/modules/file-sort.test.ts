import { describe, expect, it } from "vitest";
import { nextSort, sortItems } from "./file-sort";
import type { Item } from "../api/client";

const items: Item[] = [
  { id: "1", name: "张三.txt", path: "/a", kind: "file", size: 300, metadata: { modify_time: 3000 } },
  { id: "2", name: "李四.txt", path: "/b", kind: "file", size: 100, metadata: { modify_time: 1000 } },
  { id: "3", name: "王五.txt", path: "/c", kind: "file", size: 200, metadata: { modify_time: 2000 } },
  { id: "4", name: "无大小.txt", path: "/d", kind: "file" },
];

describe("file sorting", () => {
  it("sorts names with Chinese collation, not code points", () => {
    // 拼音顺序：li < wang < wu < zhang；按码点排会得到完全不同的结果
    expect(sortItems(items, "name", "asc").map((item) => item.name))
      .toEqual(["李四.txt", "王五.txt", "无大小.txt", "张三.txt"]);
    expect(sortItems(items, "name", "desc").map((item) => item.name)[0]).toBe("张三.txt");
  });

  it("sorts sizes and times in both directions", () => {
    expect(sortItems(items, "size", "desc").slice(0, 3).map((item) => item.size)).toEqual([300, 200, 100]);
    expect(sortItems(items, "size", "asc").slice(0, 3).map((item) => item.size)).toEqual([100, 200, 300]);
    expect(sortItems(items, "time", "desc").slice(0, 3).map((item) => item.metadata?.modify_time)).toEqual([3000, 2000, 1000]);
  });

  it("always sinks items the device gave no value for", () => {
    expect(sortItems(items, "size", "asc").at(-1)?.name).toBe("无大小.txt");
    expect(sortItems(items, "size", "desc").at(-1)?.name).toBe("无大小.txt");
    expect(sortItems(items, "time", "desc").at(-1)?.name).toBe("无大小.txt");
  });

  it("does not mutate the input array", () => {
    const before = items.map((item) => item.name);
    sortItems(items, "size", "desc");
    expect(items.map((item) => item.name)).toEqual(before);
  });
});

describe("sort toggling", () => {
  it("flips direction on the same column and picks a sensible default on a new one", () => {
    expect(nextSort({ key: "name", dir: "asc" }, "name")).toEqual({ key: "name", dir: "desc" });
    expect(nextSort({ key: "name", dir: "desc" }, "name")).toEqual({ key: "name", dir: "asc" });
    expect(nextSort({ key: "name", dir: "asc" }, "size")).toEqual({ key: "size", dir: "desc" });
    expect(nextSort({ key: "size", dir: "desc" }, "time")).toEqual({ key: "time", dir: "desc" });
    expect(nextSort({ key: "size", dir: "desc" }, "name")).toEqual({ key: "name", dir: "asc" });
  });
});
