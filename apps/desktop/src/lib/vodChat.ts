/**
 * Pure scheduling for VOD chat replay.
 *
 * Every message carries `offset_seconds` (seconds into its VOD). A message is shown once the
 * player's media time passes it, so sync offsets, seeking and playback speed apply for free.
 * Chat is fetched in pages a little ahead of the playhead.
 */
import type { UnifiedChatMessage } from "@/composables/useUnifiedChat";

export type ReplayMessage = UnifiedChatMessage & { offset_seconds: number };

/** How far past the playhead chat is fetched. */
export const LOOKAHEAD_S = 45;
/** Chat loaded behind the playhead after a seek, so the panel isn't empty. */
export const BACKFILL_S = 20;
/** A playhead jump bigger than this (or any jump backwards) counts as a seek. */
export const SEEK_JUMP_S = 10;
/** Kick returns chat history in windows of about this length. */
export const KICK_WINDOW_S = 5;
/** Twitch page with no messages: assume a quiet stretch and skip ahead this much. */
export const TWITCH_EMPTY_STEP_S = 30;
/** Stay this far behind the newest second of a recording, where chat is still arriving. */
export const LIVE_EDGE_MARGIN_S = 10;
/** Messages kept behind the playhead before they are dropped. */
export const KEEP_BEHIND_S = 300;
export const MAX_VISIBLE = 150;

export function isSeek(last: number | null, now: number): boolean {
  return last !== null && (now < last - 1 || now > last + SEEK_JUMP_S);
}

/** Furthest media second worth fetching right now. */
export function fetchHorizon(time: number, liveEdgeS: number | null): number {
  const ahead = time + LOOKAHEAD_S;
  return liveEdgeS === null ? ahead : Math.min(ahead, liveEdgeS - LIVE_EDGE_MARGIN_S);
}

/** Offset to request next, or null when chat is already loaded far enough ahead. */
export function nextFetchOffset(
  fetchedUntil: number,
  time: number,
  liveEdgeS: number | null
): number | null {
  if (fetchedUntil >= fetchHorizon(time, liveEdgeS)) return null;
  return Math.max(0, Math.floor(fetchedUntil));
}

/**
 * Where the next request should start after a page arrived. Twitch pages are "messages from
 * this offset on", so continue from the last one; Kick pages are fixed time windows.
 */
export function advanceAfterFetch(
  platform: "twitch" | "kick",
  from: number,
  messages: Pick<ReplayMessage, "offset_seconds">[],
  liveEdgeS: number | null
): number {
  if (platform === "kick") return from + KICK_WINDOW_S;

  if (!messages.length) {
    const skipped = from + TWITCH_EMPTY_STEP_S;
    return liveEdgeS === null
      ? skipped
      : Math.max(from, Math.min(skipped, liveEdgeS - LIVE_EDGE_MARGIN_S));
  }

  const last = Math.max(...messages.map((m) => m.offset_seconds));
  // more than a page in one second would otherwise repeat forever
  return last > from ? last : from + 1;
}

/** Adds unseen messages, keeping the list sorted by offset. */
export function mergeMessages(
  existing: ReplayMessage[],
  incoming: ReplayMessage[],
  seen: Set<string>
): ReplayMessage[] {
  const fresh = incoming.filter((m) => !seen.has(m.id));
  if (!fresh.length) return existing;
  fresh.forEach((m) => seen.add(m.id));
  return [...existing, ...fresh].toSorted((a, b) => a.offset_seconds - b.offset_seconds);
}

export interface TrackView {
  messages: ReplayMessage[];
  time: number;
}

/** Messages already reached by their player, newest first (the chat list renders bottom-up). */
export function visibleMessages(tracks: TrackView[], max = MAX_VISIBLE): ReplayMessage[] {
  const shown: ReplayMessage[] = [];
  for (const track of tracks) {
    for (const m of track.messages) {
      if (m.offset_seconds > track.time) break;
      shown.push(m);
    }
  }
  return shown.toSorted((a, b) => b.timestamp_ms - a.timestamp_ms).slice(0, max);
}
