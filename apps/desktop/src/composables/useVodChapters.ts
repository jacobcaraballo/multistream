import { invoke } from "@tauri-apps/api/core";
import type { Vod } from "@/lib/vod";
import type { VodChapter } from "@/lib/vodChapters";

// a recording keeps adding chapters as the streamer switches games
export const CHAPTERS_RECORDING_TTL_MS = 5 * 60_000;

interface Entry {
  chapters: VodChapter[];
  fetchedAt: number;
  recording: boolean;
}

const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<VodChapter[]>>();

const keyOf = (vod: Pick<Vod, "platform" | "id">) => `${vod.platform}:${vod.id}`;

/**
 * @brief A VOD's chapters (Twitch game changes), fetched once and shared by every tile showing it
 *
 * Resolves to an empty list when there are none (one game all along, Kick) or the request fails.
 * Recordings are fetched again after a while, since they grow new chapters.
 */
export function loadVodChapters(
  vod: Pick<Vod, "platform" | "id" | "isRecording">
): Promise<VodChapter[]> {
  const key = keyOf(vod);
  const cached = cache.get(key);
  const fresh =
    cached && (!cached.recording || Date.now() - cached.fetchedAt < CHAPTERS_RECORDING_TTL_MS);
  if (cached && fresh) return Promise.resolve(cached.chapters);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const request = invoke<VodChapter[]>("vod_chapters", { platform: vod.platform, id: vod.id })
    .then((list) => (Array.isArray(list) ? list : []))
    .catch(() => cached?.chapters ?? [])
    .then((chapters) => {
      cache.set(key, { chapters, fetchedAt: Date.now(), recording: !!vod.isRecording });
      pending.delete(key);
      return chapters;
    });
  pending.set(key, request);
  return request;
}

/** Test helper: forget every cached list. */
export function __test_resetVodChapters() {
  cache.clear();
  pending.clear();
}
