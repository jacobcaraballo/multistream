import { onScopeDispose, watch } from "vue";

export const DIALOG_OPEN_CLASS = "dialog-open";

let openDialogs = 0;

/**
 * @brief Dims the app behind open dialogs by toggling a class on <body>
 *
 * Replaces a `body:has([data-slot="dialog-content"])` CSS rule: WebKit (macOS/Linux) can skip
 * re-checking `:has()` when a dialog unmounts, which left the app dimmed and unclickable after the
 * dialog closed. Class changes are always re-checked.
 */
export function useDialogDim(isOpen: () => boolean) {
  let counted = false;

  const set = (open: boolean) => {
    if (open === counted) return;
    counted = open;
    openDialogs += open ? 1 : -1;
    document.body.classList.toggle(DIALOG_OPEN_CLASS, openDialogs > 0);
  };

  watch(isOpen, set, { immediate: true });
  onScopeDispose(() => set(false));
}
