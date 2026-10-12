import { describe, expect, it } from "vitest";
import { activeLine, lrcTime, parseLrc, readLyrics } from "./Lyrics";

/** 真机实测歌词（GET /zmusic/api/v2/song/info/lyrics） */
const real = `[ti:Oops!]
[ar:Marie Ulven]
[00:00.000] 作词 : Marie Ulven
[00:01.000] 作曲 : Marie Ulven
[00:29.078] When I see you with her
[00:32.690] It only gets worse
[00:36.100] Oops!`;

describe("LRC parsing", () => {
  it("reads timestamps, text and metadata from the measured payload", () => {
    const lyric = parseLrc(real);
    expect(lyric.meta.ti).toBe("Oops!");
    expect(lyric.meta.ar).toBe("Marie Ulven");
    expect(lyric.lines.filter((line) => line.time >= 0).map((line) => line.text)).toEqual([
      "作词 : Marie Ulven",
      "作曲 : Marie Ulven",
      "When I see you with her",
      "It only gets worse",
      "Oops!",
    ]);
    expect(lyric.lines[2].time).toBeCloseTo(29.078, 3);
  });

  it("handles seconds-only stamps, multiple stamps per line and untimed text", () => {
    const lyric = parseLrc(`[00:05]第一句\n[00:10][00:20]重复句\n此歌曲为没有填词的纯音乐，请您欣赏`);
    expect(lyric.lines.map((line) => [line.time, line.text])).toEqual([
      [-1, "此歌曲为没有填词的纯音乐，请您欣赏"],
      [5, "第一句"],
      [10, "重复句"],
      [20, "重复句"],
    ]);
  });

  it("time parsing: mm:ss(.fff)", () => {
    expect(lrcTime("01", "02")).toBe(62);
    expect(lrcTime("1", "02", "5")).toBe(62.5);
    expect(lrcTime("1", "02", "345")).toBeCloseTo(62.345, 3);
    expect(lrcTime("bad", "02")).toBe(0);
  });

  it("empty or junk input yields an empty lyric instead of throwing", () => {
    expect(parseLrc(undefined).lines).toEqual([]);
    expect(parseLrc("").lines).toEqual([]);
    expect(parseLrc("没有时间戳也没有方括号").lines).toEqual([{ time: -1, text: "没有时间戳也没有方括号" }]);
  });
});

describe("active line", () => {
  const lines = parseLrc(`[00:10]A\n[00:20]B\n[00:30]C`).lines;
  it("picks the last line already reached", () => {
    expect(activeLine(lines, 0)).toBe(0);   // 还没开始 → 第一行
    expect(activeLine(lines, 10)).toBe(0);
    expect(activeLine(lines, 19.9)).toBe(0);
    expect(activeLine(lines, 25)).toBe(1);
    expect(activeLine(lines, 999)).toBe(2);
    expect(activeLine([], 10)).toBe(-1);
  });
});

describe("reading the payload", () => {
  it("takes song_lyrics out of the envelope and tolerates shapes without it", () => {
    expect(readLyrics({ values: { song_lyrics: "[00:01]x" } })).toBe("[00:01]x");
    expect(readLyrics({ values: { data: { song_lyrics: "y" } } })).toBe("y");
    expect(readLyrics({ song_lyrics: "z" })).toBe("z");
    expect(readLyrics({})).toBe("");
    expect(readLyrics(undefined)).toBe("");
    expect(readLyrics({ values: { song_lyrics: 42 } })).toBe("");   // 不是字符串就当没有
  });
});
