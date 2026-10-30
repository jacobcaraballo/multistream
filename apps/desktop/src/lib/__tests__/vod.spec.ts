import { describe, it, expect } from "vitest";
import {
  formatClock,
  formatSpan,
  isVodPlatform,
  parseVodUrl,
  stripEndlist,
  vodEndMs,
  vodErrorKey,
  vodsOverlap,
  type Vod,
} from "../vod";

const HOUR = 3_600_000;

const vod = (overrides: Partial<Vod> = {}): Vod => ({
  id: "1",
  platform: "twitch",
  channel: "a",
  displayName: "A",
  title: "",
  startedAt: 0,
  durationSeconds: 3600,
  isRecording: false,
  ...overrides,
});

describe("parseVodUrl", () => {
  it.each([
    ["https://www.twitch.tv/videos/2915065087", "2915065087"],
    ["twitch.tv/videos/2915065087?t=1h2m3s", "2915065087"],
    ["https://m.twitch.tv/videos/v2915065087", "2915065087"],
    ["https://www.twitch.tv/ibai/videos/2915065087", "2915065087"],
  ])("should extract the Twitch VOD id from %s", (input, id) => {
    // Act
    const result = parseVodUrl(input);

    // Assert
    expect(result).toEqual({ platform: "twitch", id });
  });

  it("should extract a Kick VOD uuid and lowercase it", () => {
    // Arrange
    const input = "https://kick.com/xqc/videos/6C3676A7-B79A-497B-BBED-A065C16606D1";

    // Act
    const result = parseVodUrl(input);

    // Assert
    expect(result).toEqual({ platform: "kick", id: "6c3676a7-b79a-497b-bbed-a065c16606d1" });
  });

  it.each([
    "https://www.twitch.tv/ibai",
    "https://www.twitch.tv/videos/",
    "https://www.twitch.tv/videos/abc",
    "https://kick.com/xqc",
    "https://kick.com/xqc/videos/not-a-uuid",
    "https://youtube.com/watch?v=dQw4w9WgXcQ",
    "ibai",
    "",
  ])("should return null for %s", (input) => {
    // Act / Assert
    expect(parseVodUrl(input)).toBeNull();
  });
});

describe("formatting helpers", () => {
  it("should format clock times with and without hours", () => {
    // Act / Assert
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(3725)).toBe("1:02:05");
    expect(formatClock(-5)).toBe("0:00");
  });

  it("should format compact spans", () => {
    // Act / Assert
    expect(formatSpan(42)).toBe("42s");
    expect(formatSpan(14 * 60)).toBe("14m");
    expect(formatSpan(2 * 3600 + 5 * 60)).toBe("2h 05m");
  });
});

describe("stripEndlist", () => {
  it("should drop a trailing ENDLIST tag only", () => {
    // Arrange
    const playlist = "#EXTM3U\n#EXTINF:10.000,\n554.ts\n#EXT-X-ENDLIST\n";

    // Act
    const result = stripEndlist(playlist);

    // Assert
    expect(result).toBe("#EXTM3U\n#EXTINF:10.000,\n554.ts\n");
  });

  it("should leave playlists without ENDLIST untouched", () => {
    // Arrange
    const playlist = "#EXTM3U\n#EXTINF:10.000,\n0.ts\n";

    // Act / Assert
    expect(stripEndlist(playlist)).toBe(playlist);
  });
});

describe("overlap helpers", () => {
  it("should extend recording VODs up to now", () => {
    // Arrange
    const recording = vod({ isRecording: true, durationSeconds: 60 });

    // Act / Assert
    expect(vodEndMs(recording, 5 * HOUR)).toBe(5 * HOUR);
    expect(vodEndMs(vod(), 5 * HOUR)).toBe(HOUR);
  });

  it("should detect overlapping and disjoint broadcasts", () => {
    // Arrange
    const a = vod({ startedAt: 0, durationSeconds: 7200 });
    const b = vod({ id: "2", startedAt: HOUR, durationSeconds: 7200 });
    const c = vod({ id: "3", startedAt: 3 * HOUR, durationSeconds: 600 });

    // Act / Assert
    expect(vodsOverlap(a, b, 10 * HOUR)).toBe(true);
    expect(vodsOverlap(a, c, 10 * HOUR)).toBe(false);
  });

  it("should treat back-to-back broadcasts as not overlapping", () => {
    // Arrange
    const a = vod({ startedAt: 0, durationSeconds: 3600 });
    const b = vod({ id: "2", startedAt: HOUR });

    // Act / Assert
    expect(vodsOverlap(a, b, 10 * HOUR)).toBe(false);
  });
});

describe("vodErrorKey", () => {
  it("should map backend error strings to i18n keys", () => {
    // Act / Assert
    expect(vodErrorKey("Restricted: Twitch VOD")).toBe("vods.errors.restricted");
    expect(vodErrorKey("Not found: Twitch channel")).toBe("vods.errors.notFound");
    expect(vodErrorKey(new Error("HTTP error: timeout"))).toBe("vods.errors.generic");
  });
});

describe("isVodPlatform", () => {
  it("should only accept platforms with VOD support", () => {
    // Act / Assert
    expect(isVodPlatform("twitch")).toBe(true);
    expect(isVodPlatform("kick")).toBe(true);
    expect(isVodPlatform("youtube")).toBe(false);
    expect(isVodPlatform("custom")).toBe(false);
  });
});
