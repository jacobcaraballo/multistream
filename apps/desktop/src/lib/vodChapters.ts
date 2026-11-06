/** A stretch of a VOD spent on one game (Twitch chapters), as `vod_chapters` returns it. */
export interface VodChapter {
  startS: number;
  /** Missing while the chapter is still running on a live recording. */
  durationS?: number;
  title: string;
  imageUrl?: string;
}

/** Index of the chapter playing at media second `s`, or -1 before the first one starts. */
export function chapterIndexAt(chapters: readonly VodChapter[], s: number): number {
  let index = -1;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i]!.startS <= s + 0.001) index = i;
    else break;
  }
  return index;
}

/** Chapter starts after the first, where the seek bar draws a break. */
export function chapterBreaks(chapters: readonly VodChapter[], lengthS: number): number[] {
  return chapters.map((c) => c.startS).filter((s) => s > 0 && s < lengthS);
}
