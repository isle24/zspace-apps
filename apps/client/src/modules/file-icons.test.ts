import { describe, expect, it } from "vitest";
import { fileExtension, fileIconFor } from "./file-icons";

/** 图标是 forwardRef 包装件，跨模块比较身份不可靠；按组件显示名断言。 */
const iconName = (name: string) => {
  const icon = fileIconFor(name) as { displayName?: string; render?: { name?: string } };
  return icon.displayName ?? icon.render?.name ?? "";
};

describe("file icons by extension", () => {
  it("reads extensions case-insensitively", () => {
    expect(fileExtension("Report.XLSX")).toBe("xlsx");
    expect(fileExtension("no-extension")).toBe("");
    expect(fileExtension(".hidden")).toBe("");
    expect(fileExtension("trailing.")).toBe("");
  });

  it("maps the types the NAS actually held", () => {
    expect(iconName("第二季度工作总结(1).xls")).toBe("FileXlsIcon");
    expect(iconName("合照-老照片修复.png")).toBe("FilePngIcon");
    expect(iconName("DuplicateCleaner_5.21.2.zip")).toBe("FileZipIcon");
    expect(iconName("IMG_20261007_101735.jpg")).toBe("FileImageIcon");
    expect(iconName("电影.strm")).toBe("FileVideoIcon");   // STRM 按视频处理
    expect(iconName("music.flac")).toBe("FileAudioIcon");
    expect(iconName("README")).toBe("FileTextIcon");       // 认不出来也不留空
  });

  it("gives different icons to different types instead of one generic glyph", () => {
    const names = ["a.jpg", "a.mp4", "a.mp3", "a.zip", "a.pdf", "a.js"].map(iconName);
    expect(new Set(names).size).toBe(names.length);
  });
});
