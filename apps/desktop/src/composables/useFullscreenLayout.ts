import { computed, ref, watch } from "vue";
import { createSharedComposable, useStorage, useWindowSize } from "@vueuse/core";
import { useStreams, type Stream } from "./useStreams";
import { useFocusedStream } from "./useFocusedStream";
import { useImmersiveMode } from "./useImmersiveMode";
import { usePreferences } from "./usePreferences";
import { isTauri } from "./useUpdater";

/** A PiP window as fractions of the viewport: left and top edge, and width (height follows). */
export interface PipRect {
  x: number;
  y: number;
  w: number;
}

export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Height of the drag bar above a PiP's video. */
export const PIP_BAR_PX = 24;
export const PIP_MARGIN_PX = 16;
const PIP_GAP_PX = 12;
const DEFAULT_PIP_WIDTH = 0.26;
const MAX_PIP_WIDTH = 0.7;
const MIN_PIP_WIDTH_PX = 320;
// Twitch pauses embedded players smaller than 400x300, so a Twitch embed stays 300px tall
const MIN_TWITCH_EMBED_WIDTH_PX = 534;
// the OS reports the window as not fullscreen for a moment while it animates in
const FULLSCREEN_SETTLE_MS = 1500;

export const pipHeight = (width: number) => Math.round((width * 9) / 16) + PIP_BAR_PX;

/** Keeps a PiP fully on screen and between its minimum and maximum width. */
export function clampPipRect(
  rect: Pick<PixelRect, "left" | "top" | "width">,
  viewport: { width: number; height: number },
  minWidth: number
): PixelRect {
  const maxWidth = Math.max(
    Math.min(minWidth, viewport.width - 2 * PIP_MARGIN_PX),
    viewport.width * MAX_PIP_WIDTH
  );
  const width = Math.round(Math.min(Math.max(rect.width, minWidth), maxWidth));
  const height = pipHeight(width);
  const left = Math.round(Math.min(Math.max(rect.left, 0), Math.max(0, viewport.width - width)));
  const top = Math.round(Math.min(Math.max(rect.top, 0), Math.max(0, viewport.height - height)));
  return { left, top, width, height };
}

/** Where the `index`-th PiP goes before the user moves it: stacked up the right edge. */
export function defaultPipRect(
  index: number,
  viewport: { width: number; height: number },
  minWidth: number
): PixelRect {
  const width = Math.max(minWidth, viewport.width * DEFAULT_PIP_WIDTH);
  const height = pipHeight(width);
  const perColumn = Math.max(
    1,
    Math.floor((viewport.height - PIP_MARGIN_PX) / (height + PIP_GAP_PX))
  );
  const column = Math.floor(index / perColumn);
  const row = index % perColumn;
  return clampPipRect(
    {
      left: viewport.width - PIP_MARGIN_PX - (column + 1) * width - column * PIP_GAP_PX,
      top: viewport.height - PIP_MARGIN_PX - (row + 1) * height - row * PIP_GAP_PX,
      width,
    },
    viewport,
    minWidth
  );
}

/**
 * @brief Fullscreen with picture-in-picture overlays
 *
 * One tile fills the fullscreen window and other tiles float over it as draggable PiP windows.
 * Tiles never move in the DOM (that would reload their embeds): the grid cells switch to fixed
 * positioning, and every other tile keeps playing muted underneath.
 */
const _useFullscreenLayout = () => {
  const { streams } = useStreams();
  const { audioStreamId, activateStream } = useFocusedStream();
  const { isFullscreen, setWindowFullscreen, syncFullscreenState } = useImmersiveMode();
  const { nativePlayerEnabled } = usePreferences();
  const viewport = useWindowSize();

  const mainId = ref<string | null>(null);
  /** PiPs from bottom to top of the stack. */
  const pipIds = ref<string[]>([]);
  const pipRects = useStorage<Record<string, PipRect>>("multistream-pip-rects", {});
  /** A PiP is being dragged or resized: a shield keeps the embeds from swallowing the pointer. */
  const isInteracting = ref(false);

  const isActive = computed(() => mainId.value !== null);
  const isMain = (id: string) => mainId.value === id;
  const isPip = (id: string) => pipIds.value.includes(id);

  let enteredWindowFullscreen = false;
  let enteredAt = 0;
  // bumped by every enter/exit, so one that finishes awaiting the window after a newer one
  // started doesn't undo it
  let generation = 0;
  let unlistenResize: (() => void) | null = null;
  let watchingDocument = false;

  const streamById = (id: string): Stream | undefined => streams.value.find((s) => s.id === id);

  const minWidthFor = (id: string) => {
    const stream = streamById(id);
    const twitchEmbed = stream?.platform === "twitch" && !stream.vod && !nativePlayerEnabled.value;
    const min = twitchEmbed ? MIN_TWITCH_EMBED_WIDTH_PX : MIN_PIP_WIDTH_PX;
    return Math.min(min, Math.max(160, viewport.width.value - 2 * PIP_MARGIN_PX));
  };

  const size = () => ({ width: viewport.width.value, height: viewport.height.value });

  /** A PiP's on-screen box in pixels. */
  const rectOf = (id: string): PixelRect => {
    const stored = pipRects.value[id];
    const { width, height } = size();
    const min = minWidthFor(id);
    if (!stored) return defaultPipRect(Math.max(0, pipIds.value.indexOf(id)), size(), min);
    return clampPipRect(
      { left: stored.x * width, top: stored.y * height, width: stored.w * width },
      size(),
      min
    );
  };

  const setRect = (id: string, rect: Pick<PixelRect, "left" | "top" | "width">) => {
    const { width, height } = size();
    if (!width || !height) return;
    const next = clampPipRect(rect, size(), minWidthFor(id));
    pipRects.value = {
      ...pipRects.value,
      [id]: { x: next.left / width, y: next.top / height, w: next.width / width },
    };
  };

  // above the sidebars (z-20); the layout bar and drag shield sit at 49, dialogs at 50
  const zIndexOf = (id: string) => {
    if (isMain(id)) return 31;
    const index = pipIds.value.indexOf(id);
    return index < 0 ? undefined : 32 + Math.min(index, 16);
  };

  // the window leaving fullscreen some other way (green button, OS shortcut) ends the layout too
  const onWindowLeftFullscreen = () => {
    if (!isActive.value || Date.now() - enteredAt < FULLSCREEN_SETTLE_MS) return;
    enteredWindowFullscreen = false;
    exit();
  };

  const watchWindowFullscreen = async () => {
    if (!isTauri()) {
      if (watchingDocument || typeof document === "undefined") return;
      watchingDocument = true;
      document.addEventListener("fullscreenchange", () => {
        if (!document.fullscreenElement) onWindowLeftFullscreen();
      });
      return;
    }
    if (unlistenResize) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      unlistenResize = await win.onResized(async () => {
        if (!isActive.value) return;
        if (!(await win.isFullscreen())) {
          await syncFullscreenState();
          onWindowLeftFullscreen();
        }
      });
    } catch (err) {
      console.warn("Failed to watch window fullscreen:", err);
    }
  };

  /** Fill the screen with `id`; a tile that was a PiP leaves the stack. */
  const enter = async (id: string) => {
    if (!streamById(id) || mainId.value === id) return;
    const wasActive = isActive.value;
    mainId.value = id;
    pipIds.value = pipIds.value.filter((p) => p !== id);
    audioStreamId.value = id;
    if (wasActive) return;
    const current = ++generation;
    enteredAt = Date.now();
    watchWindowFullscreen();
    // the flag goes stale when the window leaves fullscreen without the app (green button)
    await syncFullscreenState();
    if (current !== generation || isFullscreen.value) return;
    const entered = await setWindowFullscreen(true);
    if (current === generation) {
      enteredWindowFullscreen = entered;
    } else if (entered && !isActive.value) {
      // the layout closed while the window was still going fullscreen
      await setWindowFullscreen(false);
    }
  };

  /** Back to the normal canvas, and out of window fullscreen if entering put the window there. */
  const exit = async () => {
    if (!isActive.value) return;
    generation++;
    mainId.value = null;
    pipIds.value = [];
    isInteracting.value = false;
    if (enteredWindowFullscreen) {
      enteredWindowFullscreen = false;
      await setWindowFullscreen(false);
    }
  };

  const toggle = (id: string) => (isMain(id) ? exit() : enter(id));

  const togglePip = (id: string) => {
    if (!isActive.value || isMain(id) || !streamById(id)) return;
    pipIds.value = isPip(id) ? pipIds.value.filter((p) => p !== id) : [...pipIds.value, id];
  };

  const bringToFront = (id: string) => {
    if (!isPip(id) || pipIds.value[pipIds.value.length - 1] === id) return;
    pipIds.value = [...pipIds.value.filter((p) => p !== id), id];
  };

  /** The PiP takes over the screen and the main tile takes its place in the stack. */
  const swapWithMain = (id: string) => {
    const previous = mainId.value;
    if (!previous || !isPip(id)) return;
    // the spot the PiP is showing in now, whether or not it was ever moved
    const spot = rectOf(id);
    pipIds.value = pipIds.value.map((p) => (p === id ? previous : p));
    mainId.value = id;
    audioStreamId.value = id;
    setRect(previous, spot);
  };

  /** A click on a tile: in the layout it only takes the audio, so nothing moves around. */
  const selectTile = (id: string) => {
    if (isActive.value) audioStreamId.value = id;
    else activateStream(id);
  };

  watch(
    () => streams.value.map((s) => s.id),
    (ids) => {
      const alive = new Set(ids);
      if (mainId.value && !alive.has(mainId.value)) exit();
      if (pipIds.value.some((id) => !alive.has(id))) {
        pipIds.value = pipIds.value.filter((id) => alive.has(id));
      }
      const stale = Object.keys(pipRects.value).filter((id) => !alive.has(id));
      if (stale.length) {
        pipRects.value = Object.fromEntries(
          Object.entries(pipRects.value).filter(([id]) => alive.has(id))
        );
      }
    }
  );

  return {
    mainId,
    pipIds,
    isActive,
    isInteracting,
    isMain,
    isPip,
    rectOf,
    setRect,
    zIndexOf,
    enter,
    exit,
    toggle,
    togglePip,
    bringToFront,
    swapWithMain,
    selectTile,
  };
};

export const useFullscreenLayout = createSharedComposable(_useFullscreenLayout);
