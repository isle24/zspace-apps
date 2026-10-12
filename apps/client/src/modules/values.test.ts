import { describe, expect, it } from "vitest";
import { asLooseText, asNumber, asRecord, asText } from "./values";

/**
 * 这组用例的重点是**两个变体的差别**。
 * 合并重复实现时我把它们当成同一个，结果设置页里数字被当成 undefined，
 * 被 SystemNetwork 的用例抓住。差别写进测试，免得下次再合并回去。
 */
describe("设备返回值解析", () => {
  it("asRecord 只认对象，数组与 null 都不算", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([])).toBeUndefined();
    expect(asRecord(null)).toBeUndefined();
    expect(asRecord("x")).toBeUndefined();
  });

  it("asText 只认非空字符串", () => {
    expect(asText("  hi ")).toBe("hi");
    expect(asText("   ")).toBeUndefined();
    expect(asText(1)).toBeUndefined();
  });

  it("asLooseText 额外接受有限数字（设备常把设置值给成数字）", () => {
    expect(asLooseText("hi")).toBe("hi");
    expect(asLooseText(1)).toBe("1");
    expect(asLooseText(0)).toBe("0");
    expect(asLooseText(Number.NaN)).toBeUndefined();
    expect(asLooseText(Number.POSITIVE_INFINITY)).toBeUndefined();
    // 差别就在这里
    expect(asText(1)).toBeUndefined();
    expect(asLooseText(1)).toBe("1");
  });

  it("asNumber 接受有限数字与数字字符串", () => {
    expect(asNumber(3)).toBe(3);
    expect(asNumber("3.5")).toBe(3.5);
    expect(asNumber("abc")).toBeUndefined();
    expect(asNumber(Number.NaN)).toBeUndefined();
  });
});
