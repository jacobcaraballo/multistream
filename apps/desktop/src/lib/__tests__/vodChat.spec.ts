import { describe, it, expect } from "vitest";
import {
  KICK_WINDOW_S,
  LIVE_EDGE_MARGIN_S,
  LOOKAHEAD_S,
  TWITCH_EMPTY_STEP_S,
  advanceAfterFetch,
  fetchHorizon,
  isSeek,
  mergeMessages,
  nextFetchOffset,
  visibleMessages,
  type ReplayMessage,
} from "../vodChat";

const msg = (id: string, offset: number, timestamp = offset * 1000): ReplayMessage => ({
  id,
  channel: "ch",
  username: "u",
  display_name: "U",
  message: "hi",
  timestamp_ms: timestamp,
  offset_seconds: offset,
  color: null,
  badges: [],
  emotes: null,
  platform: "twitch",
});

describe("isSeek", () => {
  it("should treat backwards and large forward jumps as seeks", () => {
    // Act / Assert
    expect(isSeek(null, 100)).toBe(false);
    expect(isSeek(100, 100.5)).toBe(false);
    expect(isSeek(100, 105)).toBe(false);
    expect(isSeek(100, 98)).toBe(true);
    expect(isSeek(100, 130)).toBe(true);
  });
});

describe("fetch scheduling", () => {
  it("should fetch until the lookahead window is covered", () => {
    // Act / Assert
    expect(nextFetchOffset(100, 100, null)).toBe(100);
    expect(nextFetchOffset(100 + LOOKAHEAD_S, 100, null)).toBeNull();
  });

  it("should stay behind the live edge of a recording", () => {
    // Arrange
    const edge = 120;

    // Act / Assert
    expect(fetchHorizon(100, edge)).toBe(edge - LIVE_EDGE_MARGIN_S);
    expect(nextFetchOffset(edge - LIVE_EDGE_MARGIN_S, 100, edge)).toBeNull();
  });

  it("should continue Twitch paging from the last message received", () => {
    // Act / Assert
    expect(advanceAfterFetch("twitch", 100, [msg("a", 95), msg("b", 140)], null)).toBe(140);
  });

  it("should still make progress when a whole page shares one second", () => {
    // Act / Assert
    expect(advanceAfterFetch("twitch", 100, [msg("a", 100), msg("b", 100)], null)).toBe(101);
  });

  it("should skip ahead over a quiet Twitch stretch, but not past a recording's edge", () => {
    // Act / Assert
    expect(advanceAfterFetch("twitch", 100, [], null)).toBe(100 + TWITCH_EMPTY_STEP_S);
    expect(advanceAfterFetch("twitch", 100, [], 115)).toBe(115 - LIVE_EDGE_MARGIN_S);
    expect(advanceAfterFetch("twitch", 100, [], 105)).toBe(100);
  });

  it("should step Kick by its fixed history window", () => {
    // Act / Assert
    expect(advanceAfterFetch("kick", 100, [msg("a", 101)], null)).toBe(100 + KICK_WINDOW_S);
  });
});

describe("mergeMessages", () => {
  it("should add only unseen messages and keep offset order", () => {
    // Arrange
    const seen = new Set<string>();
    const first = mergeMessages([], [msg("b", 20), msg("a", 10)], seen);

    // Act
    const merged = mergeMessages(first, [msg("a", 10), msg("c", 15)], seen);

    // Assert
    expect(merged.map((m) => m.id)).toEqual(["a", "c", "b"]);
  });

  it("should return the same array when nothing is new", () => {
    // Arrange
    const seen = new Set<string>(["a"]);
    const existing = [msg("a", 10)];

    // Act / Assert
    expect(mergeMessages(existing, [msg("a", 10)], seen)).toBe(existing);
  });
});

describe("visibleMessages", () => {
  it("should only show messages each player has reached, newest first", () => {
    // Arrange
    const tracks = [
      { messages: [msg("a1", 10, 1000), msg("a2", 20, 3000)], time: 15 },
      { messages: [msg("b1", 5, 2000), msg("b2", 6, 4000)], time: 30 },
    ];

    // Act
    const shown = visibleMessages(tracks);

    // Assert
    expect(shown.map((m) => m.id)).toEqual(["b2", "b1", "a1"]);
  });

  it("should cap how many messages are shown", () => {
    // Arrange
    const messages = Array.from({ length: 10 }, (_, i) => msg(`m${i}`, i));

    // Act
    const shown = visibleMessages([{ messages, time: 100 }], 3);

    // Assert
    expect(shown.map((m) => m.id)).toEqual(["m9", "m8", "m7"]);
  });
});
