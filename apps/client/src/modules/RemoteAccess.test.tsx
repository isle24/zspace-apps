import { describe, expect, it } from "vitest";
import { ispLabel, nodeLabel, readSpeed } from "./RemoteAccess";

/** 真机实测响应（2026-10-12，GET /zrps/api/speed/query） */
const real = {
  values: {
    code: "200",
    data: {
      direction: "",
      finish: "true",
      id: "",
      ip: "171.222.188.41",
      isp: "ctcc",
      saddr: "180.119.170.156",
      snode: "yz-cu-dev",
    },
  },
};

describe("remote access status", () => {
  it("reads the measured payload", () => {
    const speed = readSpeed(real);
    expect(speed.publicAddress).toBe("180.119.170.156");
    expect(speed.clientAddress).toBe("171.222.188.41");
    expect(speed.isp).toBe("中国电信");
    expect(speed.node).toBe("扬州 · 联通");
    expect(speed.finished).toBe(true);
  });

  it("never invents values the device left out", () => {
    const speed = readSpeed({ values: { data: {} } });
    expect(speed.publicAddress).toBeUndefined();
    expect(speed.clientAddress).toBeUndefined();
    expect(speed.isp).toBeUndefined();
    expect(speed.finished).toBeUndefined();
    expect(readSpeed(undefined).publicAddress).toBeUndefined();
  });

  it("treats finish as a string flag rather than truthiness", () => {
    expect(readSpeed({ values: { data: { finish: "false" } } }).finished).toBe(false);
    expect(readSpeed({ values: { data: { finish: "1" } } }).finished).toBe(true);
    expect(readSpeed({ values: { data: { finish: "" } } }).finished).toBeUndefined();
  });
});

describe("isp and node labels", () => {
  it("maps the codes the device sends and passes unknown ones through", () => {
    expect(ispLabel("ctcc")).toBe("中国电信");
    expect(ispLabel("CUCC")).toBe("中国联通");
    expect(ispLabel("cmcc")).toBe("中国移动");
    expect(ispLabel("weird")).toBe("weird");
    expect(ispLabel(undefined)).toBeUndefined();
  });

  it("only translates node names it actually recognises", () => {
    expect(nodeLabel("yz-cu-dev")).toBe("扬州 · 联通");
    expect(nodeLabel("bj-ct")).toBe("北京 · 电信");
    expect(nodeLabel("some-other-node")).toBe("some-other-node");
    expect(nodeLabel(undefined)).toBeUndefined();
  });
});
