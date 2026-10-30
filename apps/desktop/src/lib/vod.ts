import type { Platform } from "@/composables/useStreams";

export const VOD_PLATFORMS = ["twitch", "kick"] as const;
export type VodPlatform = (typeof VOD_PLATFORMS)[number];

/** Mirrors the Rust `vod::types::Vod` IPC struct. */
export interface Vod {
  id: string;
  platform: VodPlatform;
  channel: string;
  displayName: string;
  title: string;
  /** Broadcast start as epoch milliseconds. */
  startedAt: number;
  durationSeconds: number;
  isRecording: boolean;
  thumbnailUrl?: string;
  category?: string;
  viewCount?: number;
}

export interface VodPage {
  vods: Vod[];
  cursor?: string;
}

export interface VodRef {
  platform: VodPlatform;
  id: string;
}

export const isVodPlatform = (platform: Platform | string): platform is VodPlatform =>
  (VOD_PLATFORMS as readonly string[]).includes(platform);

const KICK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extracts a VOD reference from a Twitch (`twitch.tv/videos/123`) or
 * Kick (`kick.com/<channel>/videos/<uuid>`) link. Returns null for anything else.
 */
export function parseVodUrl(input: string): VodRef | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const parts = url.pathname.split("/").filter(Boolean);

  if (host === "twitch.tv") {
    const idx = parts.indexOf("videos");
    const id = idx >= 0 ? parts[idx + 1]?.replace(/^v/, "") : undefined;
    return id && /^\d+$/.test(id) ? { platform: "twitch", id } : null;
  }

  if (host === "kick.com") {
    const idx = parts.indexOf("videos");
    const id = idx >= 0 ? parts[idx + 1] : undefined;
    return id && KICK_UUID.test(id) ? { platform: "kick", id: id.toLowerCase() } : null;
  }

  return null;
}

export function vodWatchUrl(vod: Vod): string {
  return vod.platform === "twitch"
    ? `https://www.twitch.tv/videos/${vod.id}`
    : `https://kick.com/${vod.channel}/videos/${vod.id}`;
}

/** `3725` → `1:02:05`, `65` → `1:05`. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Compact human span for overlays: `2h 05m`, `14m`, `42s`. */
export function formatSpan(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** End of a VOD's coverage; recordings are treated as reaching `nowMs`. */
export function vodEndMs(vod: Vod, nowMs: number): number {
  const end = vod.startedAt + vod.durationSeconds * 1000;
  return vod.isRecording ? Math.max(end, nowMs) : end;
}

export function vodsOverlap(a: Vod, b: Vod, nowMs: number): boolean {
  return a.startedAt < vodEndMs(b, nowMs) && b.startedAt < vodEndMs(a, nowMs);
}

export const isSameVod = (a: Pick<Vod, "platform" | "id">, b: Pick<Vod, "platform" | "id">) =>
  a.platform === b.platform && a.id === b.id;

export function stripEndlist(playlist: string): string {
  return playlist.replace(/#EXT-X-ENDLIST\s*$/, "");
}

export function vodErrorKey(err: unknown): string {
  const msg = String(err);
  if (msg.includes("Restricted")) return "vods.errors.restricted";
  if (msg.includes("Not found")) return "vods.errors.notFound";
  return "vods.errors.generic";
}
