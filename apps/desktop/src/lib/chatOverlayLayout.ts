/** Where a dragged chat overlay sits in its tile, and the sides/corners it can pin to. */

export type HorizontalAnchor = "l" | "c" | "r";
export type VerticalAnchor = "t" | "c" | "b";

export interface ChatOverlayPosition {
  /** Right and bottom edge of the overlay as fractions of the tile (used on an unpinned axis). */
  right: number;
  bottom: number;
  /** Pinned to the left / centre / right (and top / centre / bottom) of the tile. */
  ax?: HorizontalAnchor;
  ay?: VerticalAnchor;
}

/** Font sizes the A−/A+ buttons step through. */
export const FONT_SCALES = [0.85, 1, 1.15, 1.3, 1.5, 1.75, 2] as const;
export const DEFAULT_FONT_SCALE = 1;

/** Pixels from an edge (or the centre line) within which a drag snaps to it. */
export const SNAP_PX = 22;
const SIDE_GAP_PX = 8;
// pinned to the top, below a player's title bar; pinned to the bottom, above its controls
const TOP_GAP_PX = 48;

export interface Geometry {
  tileWidth: number;
  tileHeight: number;
  boxWidth: number;
  boxHeight: number;
  /** Distance of the default (unmoved) overlay from the tile's bottom. */
  bottomGap: number;
}

/** Pins `pos` to the nearest side, corner or centre line when it is dragged close to one. */
export function snapPosition(pos: ChatOverlayPosition, g: Geometry): ChatOverlayPosition {
  const rightPx = pos.right * g.tileWidth;
  const leftPx = g.tileWidth - rightPx - g.boxWidth;
  const bottomPx = pos.bottom * g.tileHeight;
  const topPx = g.tileHeight - bottomPx - g.boxHeight;

  let ax: HorizontalAnchor | undefined;
  if (leftPx <= SNAP_PX) ax = "l";
  else if (rightPx <= SNAP_PX) ax = "r";
  else if (Math.abs(leftPx - rightPx) <= SNAP_PX) ax = "c";

  let ay: VerticalAnchor | undefined;
  if (topPx <= TOP_GAP_PX + SNAP_PX) ay = "t";
  else if (bottomPx <= g.bottomGap + SNAP_PX) ay = "b";
  else if (Math.abs(topPx - bottomPx) <= SNAP_PX) ay = "c";

  return { right: pos.right, bottom: pos.bottom, ...(ax && { ax }), ...(ay && { ay }) };
}

/** Inline style that places the overlay: pinned axes use fixed gaps, free ones the fractions. */
export function placementStyle(pos: ChatOverlayPosition, bottomGap: number) {
  const style: Record<string, string> = {};
  const moves: string[] = [];

  if (pos.ax === "l") style.left = `${SIDE_GAP_PX}px`;
  else if (pos.ax === "r") style.right = `${SIDE_GAP_PX}px`;
  else if (pos.ax === "c") {
    style.left = "50%";
    moves.push("translateX(-50%)");
  } else style.right = `${pos.right * 100}%`;

  if (pos.ay === "t") style.top = `${TOP_GAP_PX}px`;
  else if (pos.ay === "b") style.bottom = `${bottomGap}px`;
  else if (pos.ay === "c") {
    style.top = "50%";
    moves.push("translateY(-50%)");
  } else style.bottom = `${pos.bottom * 100}%`;

  if (moves.length) style.transform = moves.join(" ");
  return style;
}

/** The next size up (1) or down (-1) from `scale`, staying within the available steps. */
export function stepFontScale(scale: number, direction: 1 | -1): number {
  let nearest = 0;
  FONT_SCALES.forEach((s, i) => {
    if (Math.abs(s - scale) < Math.abs(FONT_SCALES[nearest]! - scale)) nearest = i;
  });
  const next = Math.min(FONT_SCALES.length - 1, Math.max(0, nearest + direction));
  return FONT_SCALES[next]!;
}

/** A stored font scale clamped to the supported range; anything unusable is the default. */
export function normalizeFontScale(value: unknown): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_FONT_SCALE;
  return Math.min(FONT_SCALES[FONT_SCALES.length - 1]!, Math.max(FONT_SCALES[0]!, n));
}
