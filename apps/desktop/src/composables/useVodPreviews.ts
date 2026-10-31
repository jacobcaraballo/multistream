import { invoke } from "@tauri-apps/api/core";
import type { Vod } from "@/lib/vod";
import type { VodPreviews } from "@/lib/vodPreviews";

// Twitch publishes a storyboard a few minutes after a broadcast ends, so "none" is retried
export const PREVIEW_RETRY_MS = 5 * 60_000;

interface Entry {
  previews: VodPreviews | null;
  fetchedAt: number;
}

const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<VodPreviews | null>>();

const keyOf = (vod: Pick<Vod, "platform" | "id">) => `${vod.platform}:${vod.id}`;

/**
 * @brief Seek-bar thumbnails of a VOD, fetched once and shared by every bar showing it
 *
 * Resolves to null when the platform has none (yet) or the request fails.
 */
export function loadVodPreviews(vod: Pick<Vod, "platform" | "id">): Promise<VodPreviews | null> {
  const key = keyOf(vod);
  const cached = cache.get(key);
  if (cached && (cached.previews || Date.now() - cached.fetchedAt < PREVIEW_RETRY_MS)) {
    return Promise.resolve(cached.previews);
  }
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const request = invoke<VodPreviews | null>("vod_previews", {
    platform: vod.platform,
    id: vod.id,
  })
    .catch(() => null)
    .then((previews) => {
      cache.set(key, { previews: previews ?? null, fetchedAt: Date.now() });
      pending.delete(key);
      return previews ?? null;
    });
  pending.set(key, request);
  return request;
}

/** Test helper: forget every cached descriptor. */
export function __test_resetVodPreviews() {
  cache.clear();
  pending.clear();
}
