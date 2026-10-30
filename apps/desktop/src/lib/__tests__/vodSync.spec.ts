import { describe, it, expect } from "vitest";
import {
  HARD_SEEK_S,
  LIVE_EDGE_BUFFER_MS,
  MAX_RATE_NUDGE,
  classifyPhase,
  clampPosition,
  anyRangesOverlap,
  computeTimeline,
  isHoldingClock,
  latestPlayablePosition,
  mediaTarget,
  planCorrection,
  positionForMediaTime,
  type VodRange,
} from "../vodSync";

const range = (id: string, startMs: number, endMs: number, isRecording = false): VodRange => ({
  id,
  startMs,
  endMs,
  isRecording,
});

describe("media time mapping", () => {
  it("should map timeline positions to media seconds and back", () => {
    // Arrange
    const startMs = 1_000_000;

    // Act
    const target = mediaTarget(1_090_000, startMs, 1.5);
    const back = positionForMediaTime(target, startMs, 1.5);

    // Assert
    expect(target).toBe(91.5);
    expect(back).toBe(1_090_000);
  });
});

describe("classifyPhase", () => {
  it("should report before, active and after for a finished VOD", () => {
    // Act / Assert
    expect(classifyPhase(-1, 100, false, "ready")).toBe("before");
    expect(classifyPhase(50, 100, false, "ready")).toBe("active");
    expect(classifyPhase(100.4, 100, false, "ready")).toBe("active");
    expect(classifyPhase(101, 100, false, "ready")).toBe("after");
  });

  it("should wait instead of ending when the VOD is still recording", () => {
    // Act / Assert
    expect(classifyPhase(130, 100, true, "ready")).toBe("waiting");
  });

  it("should only report loading for in-range players", () => {
    // Act / Assert
    expect(classifyPhase(10, 100, false, "loading")).toBe("loading");
    expect(classifyPhase(-10, 100, false, "loading")).toBe("before");
  });

  it("should prioritise errors", () => {
    // Act / Assert
    expect(classifyPhase(10, 100, false, "error")).toBe("error");
  });
});

describe("planCorrection", () => {
  it("should pause and pre-seek while the clock is stopped", () => {
    // Act
    const plan = planCorrection(10, 12, false, false);

    // Assert
    expect(plan).toEqual({ seekTo: 12, rate: 1, play: false, pause: true });
  });

  it("should not seek a stopped player that is already on target", () => {
    // Act
    const plan = planCorrection(12.1, 12, false, true);

    // Assert
    expect(plan).toEqual({ seekTo: null, rate: 1, play: false, pause: false });
  });

  it("should hard-seek on large drift while running", () => {
    // Act
    const plan = planCorrection(10, 10 + HARD_SEEK_S + 1, true, false);

    // Assert
    expect(plan.seekTo).toBe(10 + HARD_SEEK_S + 1);
    expect(plan.rate).toBe(1);
  });

  it("should slow down a player that runs ahead and speed up one that lags", () => {
    // Act
    const ahead = planCorrection(10.5, 10, true, false);
    const behind = planCorrection(9.5, 10, true, false);

    // Assert
    expect(ahead.rate).toBeLessThan(1);
    expect(behind.rate).toBeGreaterThan(1);
    expect(ahead.seekTo).toBeNull();
    expect(Math.abs(1 - ahead.rate)).toBeLessThanOrEqual(MAX_RATE_NUDGE);
  });

  it("should leave a well-synced player alone", () => {
    // Act
    const plan = planCorrection(10.05, 10, true, false);

    // Assert
    expect(plan).toEqual({ seekTo: null, rate: 1, play: false, pause: false });
  });

  it("should restart a paused player on target when the clock runs", () => {
    // Act
    const plan = planCorrection(9, 10, true, true);

    // Assert
    expect(plan).toEqual({ seekTo: 10, rate: 1, play: true, pause: false });
  });
});

describe("isHoldingClock", () => {
  it("should hold while seeking or starving for data", () => {
    // Act / Assert
    expect(isHoldingClock(true, 4, 10, 100, false)).toBe(true);
    expect(isHoldingClock(false, 2, 10, 100, false)).toBe(true);
    expect(isHoldingClock(false, 3, 10, 100, false)).toBe(false);
  });

  it("should not hold at the very end of a finished VOD", () => {
    // Act / Assert
    expect(isHoldingClock(false, 2, 99.5, 100, false)).toBe(false);
  });

  it("should hold at the live edge of a recording VOD until more arrives", () => {
    // Act / Assert
    expect(isHoldingClock(false, 2, 99.5, 100, true)).toBe(true);
  });
});

describe("computeTimeline", () => {
  it("should return null without ranges", () => {
    // Act / Assert
    expect(computeTimeline([])).toBeNull();
  });

  it("should span all ranges and compute the shared overlap", () => {
    // Arrange
    const ranges = [range("a", 0, 100), range("b", 40, 160)];

    // Act
    const timeline = computeTimeline(ranges);

    // Assert
    expect(timeline).toEqual({ startMs: 0, endMs: 160, overlap: { startMs: 40, endMs: 100 } });
  });

  it("should report no overlap for disjoint ranges or a single VOD", () => {
    // Act / Assert
    expect(computeTimeline([range("a", 0, 10), range("b", 20, 30)])?.overlap).toBeNull();
    expect(computeTimeline([range("a", 0, 10)])?.overlap).toBeNull();
  });
});

describe("anyRangesOverlap", () => {
  it("should detect a partial overlap even when the whole set has none", () => {
    // Arrange
    const ranges = [range("old", 0, 10), range("a", 100, 200), range("b", 150, 250)];

    // Act / Assert
    expect(computeTimeline(ranges)?.overlap).toBeNull();
    expect(anyRangesOverlap(ranges)).toBe(true);
  });

  it("should be false for disjoint or touching ranges", () => {
    // Act / Assert
    expect(anyRangesOverlap([range("a", 0, 10), range("b", 10, 20)])).toBe(false);
    expect(anyRangesOverlap([range("a", 0, 10)])).toBe(false);
  });
});

describe("latestPlayablePosition", () => {
  it("should be null when nothing is recording", () => {
    // Act / Assert
    expect(latestPlayablePosition([range("a", 0, 100)])).toBeNull();
  });

  it("should land behind the slowest recording edge", () => {
    // Arrange
    const ranges = [
      range("a", 0, 10 * 60_000, true),
      range("b", 60_000, 9 * 60_000, true),
      range("c", 0, 20 * 60_000),
    ];

    // Act
    const latest = latestPlayablePosition(ranges);

    // Assert
    expect(latest).toBe(9 * 60_000 - LIVE_EDGE_BUFFER_MS);
  });

  it("should never go before the latest recording start", () => {
    // Arrange
    const ranges = [range("a", 0, 10_000, true)];

    // Act / Assert
    expect(latestPlayablePosition(ranges)).toBe(0);
  });
});

describe("clampPosition", () => {
  it("should keep positions inside the timeline", () => {
    // Arrange
    const timeline = { startMs: 10, endMs: 20, overlap: null };

    // Act / Assert
    expect(clampPosition(5, timeline)).toBe(10);
    expect(clampPosition(15, timeline)).toBe(15);
    expect(clampPosition(25, timeline)).toBe(20);
    expect(clampPosition(25, null)).toBe(25);
  });
});
