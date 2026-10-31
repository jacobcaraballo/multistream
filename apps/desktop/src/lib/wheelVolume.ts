/**
 * Scroll-wheel volume steps, shared by the native players. `core/audio_focus.js` repeats this
 * logic inside embeds (it can't import modules), so keep the two in step.
 *
 * Mice and trackpads send very different wheel streams: a mouse notch is one event (anything
 * from 4px on macOS to 100px on Windows), a trackpad swipe is dozens of small ones. So the first
 * event of a gesture always moves one step, and the rest of a quick run of events adds a step
 * per `PX_PER_STEP` scrolled.
 */

/** One step, as a fraction of full volume. */
export const VOLUME_STEP = 0.05;
// trackpad and momentum events come every ~8-17 ms; anything slower is a separate notch
const GESTURE_GAP_MS = 40;
const PX_PER_STEP = 100;
const MAX_STEPS = 4;

export interface WheelState {
  px: number;
  lastAt: number;
}

export const createWheelState = (): WheelState => ({ px: 0, lastAt: -Infinity });

type WheelLike = Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">;

/** Steps to move the volume: positive when scrolling up (louder), 0 for none yet. */
export function wheelSteps(e: WheelLike, state: WheelState, now: number): number {
  if (e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return 0;
  const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  const fresh = now - state.lastAt > GESTURE_GAP_MS;
  state.lastAt = now;
  if (fresh) {
    state.px = 0;
    return px < 0 ? 1 : -1;
  }
  state.px += px;
  const steps = Math.trunc(state.px / PX_PER_STEP);
  state.px -= steps * PX_PER_STEP;
  return Math.max(-MAX_STEPS, Math.min(MAX_STEPS, -steps));
}

/** The next volume (0..1) after `steps`, snapped to whole steps. */
export function steppedVolume(current: number, steps: number): number {
  const units = Math.round(current / VOLUME_STEP) + steps;
  return Math.min(1, Math.max(0, units * VOLUME_STEP));
}

/** Whether the wheel should scroll something under the pointer instead (an open menu). */
export function isInsideScrollable(target: EventTarget | null, boundary: Element): boolean {
  let el = target instanceof Element ? target : null;
  while (el && el !== boundary) {
    if (el.scrollHeight > el.clientHeight + 1) {
      const overflow = getComputedStyle(el).overflowY;
      if (overflow === "auto" || overflow === "scroll") return true;
    }
    el = el.parentElement;
  }
  return false;
}

/** Tells the tile's volume indicator (in `BaseStream`) to show the new level. */
export function announceVolume(streamId: string, volume: number, muted: boolean) {
  window.dispatchEvent(
    new CustomEvent("multistream-volume", {
      detail: { streamId, volume: Math.round(volume * 100), muted },
    })
  );
}
