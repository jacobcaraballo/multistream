<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import { GripHorizontal, Maximize2, X } from "@lucide/vue";
import { useFullscreenLayout, type PixelRect } from "@/composables/useFullscreenLayout";

// the bar on top of a picture-in-picture tile: drag to move, buttons to swap or close,
// and a corner handle to resize. Pointer moves over embeds never reach the app, so a
// full-window shield takes the pointer while dragging.
const props = defineProps<{ streamId: string; title: string }>();

const { t } = useI18n();
const layout = useFullscreenLayout();

const mode = ref<"move" | "resize" | null>(null);
let startX = 0;
let startY = 0;
let startRect: PixelRect | null = null;

function onMove(e: PointerEvent) {
  if (!startRect) return;
  const dx = e.clientX - startX;
  const dy = e.clientY - startY;
  if (mode.value === "move") {
    layout.setRect(props.streamId, {
      left: startRect.left + dx,
      top: startRect.top + dy,
      width: startRect.width,
    });
  } else {
    // the top-left corner stays put; the larger of the two moves decides the new size
    const growth = Math.max(dx, (dy * 16) / 9);
    layout.setRect(props.streamId, {
      left: startRect.left,
      top: startRect.top,
      width: startRect.width + growth,
    });
  }
}

function stop() {
  mode.value = null;
  startRect = null;
  layout.isInteracting.value = false;
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", stop);
  window.removeEventListener("pointercancel", stop);
}

function start(e: PointerEvent, next: "move" | "resize") {
  if (e.button !== 0) return;
  if (next === "move" && (e.target as Element | null)?.closest?.("button")) return;
  e.preventDefault();
  e.stopPropagation();
  layout.bringToFront(props.streamId);
  startX = e.clientX;
  startY = e.clientY;
  startRect = layout.rectOf(props.streamId);
  mode.value = next;
  layout.isInteracting.value = true;
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
}

// arrow keys move the focused bar or resize from the focused corner (shift: bigger steps)
const KEY_STEP_PX = 24;
const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

function onKeydown(e: KeyboardEvent, target: "move" | "resize") {
  const arrow = ARROWS[e.key];
  if (!arrow || e.target !== e.currentTarget) return;
  e.preventDefault();
  e.stopPropagation();
  const step = e.shiftKey ? KEY_STEP_PX * 4 : KEY_STEP_PX;
  const rect = layout.rectOf(props.streamId);
  if (target === "move") {
    layout.setRect(props.streamId, {
      left: rect.left + arrow[0] * step,
      top: rect.top + arrow[1] * step,
      width: rect.width,
    });
  } else {
    layout.setRect(props.streamId, {
      left: rect.left,
      top: rect.top,
      width: rect.width + (arrow[0] || arrow[1]) * step,
    });
  }
}

onBeforeUnmount(() => {
  if (mode.value) stop();
});
</script>

<template>
  <div
    class="absolute inset-x-0 top-0 z-60 flex h-6 items-center gap-1.5 bg-[#14161a] pl-2 pr-1 text-white/70 cursor-grab select-none touch-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400"
    :class="{ 'cursor-grabbing': mode === 'move' }"
    role="group"
    tabindex="0"
    :aria-label="`${title} · ${t('pip.drag')}`"
    :data-testid="`pip-bar-${streamId}`"
    @pointerdown="start($event, 'move')"
    @keydown="onKeydown($event, 'move')"
  >
    <GripHorizontal class="size-3.5 shrink-0 text-white/40" aria-hidden="true" />
    <span class="min-w-0 flex-1 truncate text-[11px] font-medium">{{ title }}</span>
    <button
      type="button"
      class="flex size-5 shrink-0 items-center justify-center rounded text-white/60 hover:bg-white/10 hover:text-white cursor-pointer"
      :aria-label="t('pip.makeMain')"
      :title="t('pip.makeMain')"
      :data-testid="`pip-swap-${streamId}`"
      @click="layout.swapWithMain(streamId)"
    >
      <Maximize2 class="size-3" />
    </button>
    <button
      type="button"
      class="flex size-5 shrink-0 items-center justify-center rounded text-white/60 hover:bg-white/10 hover:text-white cursor-pointer"
      :aria-label="t('pip.close')"
      :title="t('pip.close')"
      :data-testid="`pip-close-${streamId}`"
      @click="layout.togglePip(streamId)"
    >
      <X class="size-3.5" />
    </button>
  </div>

  <div
    class="absolute bottom-0 right-0 z-60 size-4 cursor-nwse-resize touch-none rounded-sm focus-visible:outline-2 focus-visible:outline-sky-400"
    role="button"
    tabindex="0"
    :aria-label="t('pip.resize')"
    :data-testid="`pip-resize-${streamId}`"
    @pointerdown="start($event, 'resize')"
    @keydown="onKeydown($event, 'resize')"
  >
    <svg viewBox="0 0 16 16" class="size-4 text-white/60 drop-shadow" aria-hidden="true">
      <path d="M15 6 6 15M15 11l-4 4" stroke="currentColor" stroke-width="1.5" fill="none" />
    </svg>
  </div>

  <Teleport to="body">
    <div
      v-if="mode"
      class="fixed inset-0 z-49"
      :class="mode === 'move' ? 'cursor-grabbing' : 'cursor-nwse-resize'"
    />
  </Teleport>
</template>
