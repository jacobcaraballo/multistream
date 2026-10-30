/**
 * Pure timing math for synchronized VOD playback.
 *
 * All VODs share one wall-clock timeline (epoch ms). A player's media time for a
 * timeline position is `(position - startMs) / 1000 + offset`, where `startMs` is the
 * wall-clock time of media t=0 (from EXT-X-PROGRAM-DATE-TIME when available) and
 * `offset` is a user-tunable nudge to compensate for per-broadcaster ingest delay.
 */

export type VodPhase = "loading" | "before" | "active" | "after" | "waiting" | "error";

export interface VodRange {
  id: string;
  startMs: number;
  endMs: number;
  isRecording: boolean;
}

export interface Timeline {
  startMs: number;
  endMs: number;
  overlap: { startMs: number; endMs: number } | null;
}

export interface Correction {
  seekTo: number | null;
  /** Multiplier applied on top of the shared playback speed. */
  rate: number;
  play: boolean;
  pause: boolean;
}

/** Seconds past the available end before a finished VOD counts as over. */
export const END_GRACE_S = 0.5;
/** When the clock is stopped, re-seek players that drifted further than this. */
export const PAUSED_TOLERANCE_S = 0.25;
/** While playing, drift beyond this is fixed with a hard seek. */
export const HARD_SEEK_S = 2;
/** While playing, drift beyond this is corrected by nudging playbackRate. */
export const SOFT_DRIFT_S = 0.12;
export const MAX_RATE_NUDGE = 0.1;
export const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
/** How far behind the newest recorded second "jump to latest" lands. */
export const LIVE_EDGE_BUFFER_MS = 30_000;

export function mediaTarget(positionMs: number, startMs: number, offsetS = 0): number {
  return (positionMs - startMs) / 1000 + offsetS;
}

export function positionForMediaTime(mediaS: number, startMs: number, offsetS = 0): number {
  return startMs + (mediaS - offsetS) * 1000;
}

export function classifyPhase(
  target: number,
  availableEndS: number,
  isRecording: boolean,
  status: "loading" | "ready" | "error"
): VodPhase {
  if (status === "error") return "error";
  if (target < 0) return "before";
  if (target > availableEndS + END_GRACE_S) return isRecording ? "waiting" : "after";
  if (status === "loading") return "loading";
  return "active";
}

export function planCorrection(
  currentTime: number,
  target: number,
  clockRunning: boolean,
  paused: boolean
): Correction {
  const drift = currentTime - target;

  if (!clockRunning) {
    return {
      seekTo: Math.abs(drift) > PAUSED_TOLERANCE_S ? target : null,
      rate: 1,
      play: false,
      pause: !paused,
    };
  }

  if (Math.abs(drift) > HARD_SEEK_S) {
    return { seekTo: target, rate: 1, play: paused, pause: false };
  }

  // a paused player is restarted exactly on target instead of being rate-corrected
  if (paused) {
    return {
      seekTo: Math.abs(drift) > PAUSED_TOLERANCE_S ? target : null,
      rate: 1,
      play: true,
      pause: false,
    };
  }

  if (Math.abs(drift) > SOFT_DRIFT_S) {
    const rate = 1 - Math.max(-MAX_RATE_NUDGE, Math.min(MAX_RATE_NUDGE, drift * 0.5));
    return { seekTo: null, rate, play: false, pause: false };
  }

  return { seekTo: null, rate: 1, play: false, pause: false };
}

/**
 * A player holds the shared clock while it cannot render the target frame yet.
 * The very end of a finished VOD never has "future data", so it must not hold the clock.
 */
export function isHoldingClock(
  seeking: boolean,
  readyState: number,
  target: number,
  availableEndS: number,
  isRecording: boolean
): boolean {
  if (seeking) return true;
  const HAVE_FUTURE_DATA = 3;
  if (readyState >= HAVE_FUTURE_DATA) return false;
  const atFinishedEnd = !isRecording && target >= availableEndS - 1;
  return !atFinishedEnd;
}

export function computeTimeline(ranges: VodRange[]): Timeline | null {
  if (!ranges.length) return null;

  let startMs = Infinity;
  let endMs = -Infinity;
  let latestStart = -Infinity;
  let earliestEnd = Infinity;

  for (const r of ranges) {
    startMs = Math.min(startMs, r.startMs);
    endMs = Math.max(endMs, r.endMs);
    latestStart = Math.max(latestStart, r.startMs);
    earliestEnd = Math.min(earliestEnd, r.endMs);
  }

  const overlap =
    ranges.length > 1 && latestStart < earliestEnd
      ? { startMs: latestStart, endMs: earliestEnd }
      : null;

  return { startMs, endMs, overlap };
}

export function anyRangesOverlap(ranges: VodRange[]): boolean {
  return ranges.some((a, i) =>
    ranges.slice(i + 1).some((b) => a.startMs < b.endMs && b.startMs < a.endMs)
  );
}

/** Newest point every recording VOD can play, minus a buffer so playback doesn't stall at the edge. */
export function latestPlayablePosition(ranges: VodRange[]): number | null {
  const recording = ranges.filter((r) => r.isRecording);
  if (!recording.length) return null;
  const edge = Math.min(...recording.map((r) => r.endMs));
  const start = Math.max(...recording.map((r) => r.startMs));
  return Math.max(start, edge - LIVE_EDGE_BUFFER_MS);
}

/** Next preset speed up or down from `current`, staying on the preset list. */
export function nextPlaybackSpeed(current: number, direction: 1 | -1): number {
  const speeds: readonly number[] = PLAYBACK_SPEEDS;
  if (direction === 1)
    return speeds.find((s) => s > current) ?? speeds[speeds.length - 1] ?? current;
  return speeds.findLast((s) => s < current) ?? speeds[0] ?? current;
}

export function clampPosition(positionMs: number, timeline: Timeline | null): number {
  if (!timeline) return positionMs;
  return Math.min(Math.max(positionMs, timeline.startMs), timeline.endMs);
}
