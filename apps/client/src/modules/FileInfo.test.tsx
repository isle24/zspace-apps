import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FileInfo, fileKindLabel } from "./FileInfo";
import { DataValues } from "./common";
import { OfficialNas } from "../api/official-nas";
import { officialFixture, officialJson } from "../api/direct-test-fixture";

afterEach(cleanup);

const actualInfo = { name: "returned.txt", path: "/actual/returned.txt", size: 2048, is_dir: false, unknown_debug: "unknown-metadata-must-not-leak" };
async function normalizedInfo(data: unknown) {
  const nas = new OfficialNas(officialFixture(() => officialJson({ code: 200, data })));
  await nas.login("http://synthetic.invalid:5055", "fixture", "synthetic-only");
  return nas.read("files.info", { path: actualInfo.path });
}

it.each([
  ["direct", actualInfo],
  ["list", { list: [actualInfo] }],
  ["info", { info: actualInfo }],
  ["empty list then info", { list: [], info: actualInfo, name: "outer-row-must-not-leak" }],
  ["nonempty list before info", { list: [actualInfo], info: { name: "other-wrapper-must-not-leak" } }],
  ["info before direct", { info: actualInfo, name: "outer-row-must-not-leak", path: "/outer-row.txt" }],
])("renders the actual SDK-normalized %s file details with the established response priority", async (_shape, data) => {
  const result = await normalizedInfo(data);
  expect(result.items[0]).toMatchObject({ name: actualInfo.name, path: actualInfo.path, metadata: actualInfo });
  render(<><FileInfo data={result} /><DataValues data={{ name: "设备甲", version: "1.0" }} /></>);
  expect(screen.getByText("文件名称")).toBeInTheDocument();
  expect(screen.getByText(actualInfo.name)).toBeInTheDocument();
  expect(screen.getByText(actualInfo.path)).toBeInTheDocument();
  expect(screen.getByText("2.0 KB")).toBeInTheDocument();
  expect(screen.getByText("文件")).toBeInTheDocument();
  expect(screen.getByText("设备名称")).toBeInTheDocument();
  expect(screen.getByText("系统版本")).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/unknown-metadata|outer-row|other-wrapper/);
});

it.each([null, "invalid-info-must-not-leak", [actualInfo]])("keeps a safe fallback for nonobject info %j from the actual SDK", async info => {
  const result = await normalizedInfo({ info });
  expect(result.items).toEqual([]);
  render(<FileInfo data={result} />);
  expect(screen.getByText("设备尚未返回可识别的文件详情。")).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/invalid-info|returned.txt/);
});

it("preserves the SDK's direct-row fallback when info is not an object", async () => {
  const result = await normalizedInfo({ ...actualInfo, info: "invalid-info-must-not-leak" });
  expect(result.items[0]).toMatchObject({ name: actualInfo.name, path: actualInfo.path });
  render(<FileInfo data={result} />);
  expect(screen.getByText(actualInfo.name)).toBeInTheDocument();
  expect(screen.getByText(actualInfo.path)).toBeInTheDocument();
  expect(screen.queryByText("invalid-info-must-not-leak")).not.toBeInTheDocument();
});

it.each(["__proto__", "constructor", "toString"])("omits the own JSON field %s while preserving known file and device details", key => {
  // JSON can carry these own keys without changing the object's prototype.
  const values = JSON.parse(`{"name":"资料.txt","size":2048,"${key}":"unknown-field-must-not-leak"}`);
  expect(Object.hasOwn(values, key)).toBe(true);
  expect(() => render(<><FileInfo data={{ values }} /><DataValues data={{ name: "设备甲", version: "1.0" }} /></>)).not.toThrow();
  expect(screen.getByText("文件名称")).toBeInTheDocument();
  expect(screen.getByText("资料.txt")).toBeInTheDocument();
  expect(screen.getByText("2.0 KB")).toBeInTheDocument();
  expect(screen.getByText("设备名称")).toBeInTheDocument();
  expect(screen.getByText("系统版本")).toBeInTheDocument();
  expect(screen.queryByText("unknown-field-must-not-leak")).not.toBeInTheDocument();
});

it.each(["__proto__", "constructor", "toString"])("treats inherited-name kind %s as unknown in the actual details renderer", kind => {
  expect(() => render(<FileInfo data={{ values: { name: "资料.txt", kind } }} />)).not.toThrow();
  expect(screen.getByText("其他")).toBeInTheDocument();
  expect(fileKindLabel(kind)).toBe("其他");
});
