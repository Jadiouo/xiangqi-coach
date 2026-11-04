import { describe, expect, it } from "vitest";
import { playedCountText } from "./played-count-text";

const base = { played: 1, counted: 0, assisted: 0, manual: false, reviewing: false };

describe("playedCountText", () => {
  it("says nothing before any game was played", () => {
    expect(playedCountText({ ...base, played: 0 })).toBe("");
  });
  it("says how many games were played and counted", () => {
    expect(playedCountText({ ...base, played: 3, counted: 2 })).toBe("已下 3 盤，2 盤已計入");
  });
  it("sets the background note apart in brackets, not glued to the count", () => {
    expect(playedCountText({ ...base, reviewing: true })).toBe("已下 1 盤，0 盤已計入（背景覆盤中…）");
  });
  it("adds the assisted games as their own sentence, then the note", () => {
    expect(playedCountText({ ...base, played: 0, assisted: 1 })).toBe("已下 0 盤，0 盤已計入。另有 1 盤開了即時勝率，不計入");
    expect(playedCountText({ ...base, assisted: 2, reviewing: true })).toBe("已下 1 盤，0 盤已計入。另有 2 盤開了即時勝率，不計入（背景覆盤中…）");
  });
  it("with a level chosen by hand shows no counted figure and no background note", () => {
    expect(playedCountText({ ...base, played: 2, counted: 1, manual: true, reviewing: true })).toBe("已下 2 盤。程度是你指定的，不另外計入");
    expect(playedCountText({ ...base, manual: true, assisted: 1 })).toBe("已下 1 盤。程度是你指定的，不另外計入。另有 1 盤開了即時勝率，不計入");
  });
});
