import { afterEach, describe, expect, it, vi } from "vitest";
import { clock } from "./Player";
import { readResume, resumeKey, writeResume } from "./VideoChrome";
import type { Item } from "../api/client";

const film: Item = { id: "c1", name: "演示影片", path: "/movies/demo.strm", kind: "video" };

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("video resume position", () => {
  it("keys progress by the file path so films never share a position", () => {
    expect(resumeKey(film)).toBe("space-desktop:resume:/movies/demo.strm");
    expect(resumeKey({ ...film, id: "other" })).toBe(resumeKey(film));
    expect(resumeKey({ id: "c2", name: "另一部", path: "/movies/other.mkv", kind: "video" }))
      .not.toBe(resumeKey(film));
  });

  it("round-trips a position and treats junk as absent", () => {
    expect(readResume(film)).toBe(0);          // 没存过就是 0，不猜
    writeResume(film, 623.7);
    expect(readResume(film)).toBe(623);        // 只存整秒
    writeResume(film, 0);
    expect(readResume(film)).toBe(0);
    localStorage.setItem(resumeKey(film), "not-a-number");
    expect(readResume(film)).toBe(0);
    localStorage.setItem(resumeKey(film), "-5");
    expect(readResume(film)).toBe(0);
  });

  it("survives a browser that refuses storage", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => writeResume(film, 100)).not.toThrow();
    setItem.mockRestore();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readResume(film)).toBe(0);
  });
});

describe("the clock used by the control bar", () => {
  it("formats minutes and hours the way players do", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(75)).toBe("1:15");
    expect(clock(6368)).toBe("1:46:08");
  });
});
