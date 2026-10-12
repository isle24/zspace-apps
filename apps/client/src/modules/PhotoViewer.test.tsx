import { describe, expect, it } from "vitest";
import { clampZoom, photoFacts } from "./PhotoViewer";
import type { Item } from "../api/client";

const photo = (metadata: Record<string, unknown> = {}, size?: number): Item => ({
  id: "p1",
  name: "IMG_0001.jpg",
  path: "/photos/IMG_0001.jpg",
  kind: "photo",
  size,
  metadata,
});

describe("viewer zoom limits", () => {
  it("clamps to 1x..6x and rejects junk", () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0.2)).toBe(1);
    expect(clampZoom(3.456)).toBe(3.46);
    expect(clampZoom(99)).toBe(6);
    expect(clampZoom(Number.NaN)).toBe(1);
  });
});

describe("photo facts come from the device only", () => {
  it("shows date, dimensions and size when present", () => {
    expect(photoFacts(photo({ date: "2026-09-25T15:10:04", width: 4032, height: 3024 }, 4_194_304)))
      .toEqual(["2026-09-25 15:10:04", "4032 × 3024", "4.0 MB"]);
    expect(photoFacts(photo({ width: 800, height: 600 }, 2048))).toEqual(["800 × 600", "2 KB"]);
  });

  it("omits anything the device did not return", () => {
    expect(photoFacts(photo())).toEqual([]);
    expect(photoFacts(photo({ width: 0, height: 0 }))).toEqual([]);
    expect(photoFacts(photo({ date: "" }))).toEqual([]);
  });
});
