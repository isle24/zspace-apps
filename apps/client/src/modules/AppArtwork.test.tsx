import { afterEach, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { AppArtwork } from "./AppArtwork";
afterEach(cleanup);
it("uses bundled project artwork for supported apps without making third-party image requests", () => {
  const { container } = render(<AppArtwork appId="uptime-kuma" icon="https://outside.test/private.svg" />);
  const image = container.querySelector("img");
  expect(image?.getAttribute("src")).toBe("/app-icons/uptime-kuma.svg");
  expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(image?.getAttribute("alt")).toBe("");
});
it("does not turn unverified catalog artwork into a network URL", () => {
  const { container } = render(<AppArtwork appId="unknown" icon="https://outside.test/private.svg" />);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg")).not.toBeNull();
});

it("ships the artwork files it references, so the catalog cannot render broken images", () => {
  // 回归：曾经删掉这两个 logo 但保留了映射，商店卡片出现破图
  for (const file of ["uptime-kuma.svg", "navidrome.png"]) {
    expect(existsSync(resolve(process.cwd(), "public/app-icons", file)), `missing ${file}`).toBe(true);
  }
});

it("falls back to a glyph when the artwork file fails to load", () => {
  const { container } = render(<AppArtwork appId="navidrome" icon="music" />);
  const image = container.querySelector("img");
  expect(image).not.toBeNull();
  fireEvent.error(image!);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg")).not.toBeNull();
});
