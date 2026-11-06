import { describe, it, expect } from "vitest";
import { chapterBreaks, chapterIndexAt, type VodChapter } from "../vodChapters";

const chapters: VodChapter[] = [
  { startS: 0, durationS: 4647, title: "Just Chatting" },
  { startS: 4647, durationS: 2237, title: "Games + Demos" },
  { startS: 6884, title: "Minecraft" },
];

describe("chapterIndexAt", () => {
  it("should find the chapter playing at a moment", () => {
    // Act / Assert
    expect(chapterIndexAt(chapters, 0)).toBe(0);
    expect(chapterIndexAt(chapters, 4646.9)).toBe(0);
    expect(chapterIndexAt(chapters, 4647)).toBe(1);
    expect(chapterIndexAt(chapters, 99_999)).toBe(2);
  });

  it("should report no chapter before the first starts or without chapters", () => {
    // Act / Assert
    expect(chapterIndexAt([{ startS: 30, title: "Late" }], 10)).toBe(-1);
    expect(chapterIndexAt([], 10)).toBe(-1);
  });
});

describe("chapterBreaks", () => {
  it("should break the bar at each later chapter within the VOD", () => {
    // Act / Assert
    expect(chapterBreaks(chapters, 14_068)).toEqual([4647, 6884]);
    expect(chapterBreaks(chapters, 5000)).toEqual([4647]);
  });
});
