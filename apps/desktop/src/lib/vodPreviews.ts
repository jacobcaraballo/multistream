/**
 * Seek-bar preview thumbnails (backend command `vod_previews`).
 *
 * Twitch storyboards are grid sprite sheets for finished VODs. Kick (AWS IVS) writes a full frame
 * every 60 seconds, also while a broadcast is still recording.
 */

export type VodPreviews =
  | {
      kind: "sprites";
      interval: number;
      count: number;
      cols: number;
      rows: number;
      width: number;
      height: number;
      images: string[];
    }
  | { kind: "frames"; urlPrefix: string; interval: number; first: number; last?: number };

export type PreviewFrame =
  | {
      kind: "sprite";
      url: string;
      x: number;
      y: number;
      width: number;
      height: number;
      sheetWidth: number;
    }
  | { kind: "image"; url: string };

/**
 * The thumbnail for media second `mediaS`, or null when there is none. `availableS` caps a
 * recording's frames at what has been written so far.
 */
export function previewAt(
  previews: VodPreviews,
  mediaS: number,
  availableS?: number
): PreviewFrame | null {
  if (!Number.isFinite(mediaS)) return null;
  const t = Math.max(0, mediaS);

  if (previews.kind === "sprites") {
    const { interval, count, cols, rows, width, height, images } = previews;
    const index = Math.min(Math.floor(t / interval), count - 1);
    const perImage = cols * rows;
    const url = images[Math.floor(index / perImage)];
    if (!url) return null;
    const cell = index % perImage;
    return {
      kind: "sprite",
      url,
      x: (cell % cols) * width,
      y: Math.floor(cell / cols) * height,
      width,
      height,
      sheetWidth: cols * width,
    };
  }

  const { urlPrefix, interval, first, last } = previews;
  const newest =
    last ??
    (availableS !== undefined ? Math.floor(availableS / interval) : Number.POSITIVE_INFINITY);
  if (newest < first) return null;
  const n = Math.min(Math.max(Math.round(t / interval), first), newest);
  return { kind: "image", url: `${urlPrefix}${n}.jpg` };
}
