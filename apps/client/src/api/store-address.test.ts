import { expect, it } from "vitest";
import { normalizeStoreAddress } from "./store-address";
it("accepts only credential-free http endpoints and keeps the setting independent from NAS", () => {
  expect(normalizeStoreAddress(" https://store.example.test:9443/ ")).toBe(
    "https://store.example.test:9443",
  );
  expect(normalizeStoreAddress("")).toBe("");
  expect(() =>
    normalizeStoreAddress("https://name:password@store.example.test"),
  ).toThrow();
  expect(() => normalizeStoreAddress("javascript:alert(1)")).toThrow();
  expect(() =>
    normalizeStoreAddress("https://store.test/?token=secret"),
  ).toThrow();
});
