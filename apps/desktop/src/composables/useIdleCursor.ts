import { watch, onScopeDispose } from "vue";
import { useEventListener } from "@vueuse/core";
import { useFullscreenLayout } from "./useFullscreenLayout";

export const IDLE_CURSOR_MS = 2500;
export const IDLE_CURSOR_CLASS = "cursor-idle";

/**
 * @brief Hides the mouse cursor in the fullscreen layout after a moment without movement
 *
 * Like the player controls that fade out, the cursor goes too and comes back on the next move.
 * It stays while a PiP is being dragged. Over an embed's frame the page never sees mouse moves,
 * so `core/fullscreen_bridge.js` does the same inside frames.
 */
export function useIdleCursor() {
  const layout = useFullscreenLayout();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const show = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    document.body.classList.remove(IDLE_CURSOR_CLASS);
  };

  const wake = () => {
    show();
    if (!layout.isActive.value) return;
    timer = setTimeout(() => {
      timer = null;
      if (layout.isActive.value && !layout.isInteracting.value) {
        document.body.classList.add(IDLE_CURSOR_CLASS);
      }
    }, IDLE_CURSOR_MS);
  };

  for (const type of ["mousemove", "mousedown", "wheel", "keydown"]) {
    useEventListener(window, type, wake, { passive: true, capture: true });
  }

  watch(
    () => layout.isActive.value,
    (active) => (active ? wake() : show()),
    { immediate: true }
  );

  onScopeDispose(show);
}
