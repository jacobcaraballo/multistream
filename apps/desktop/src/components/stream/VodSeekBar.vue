<script setup lang="ts">
import { computed, ref } from "vue";
import { formatClock } from "@/lib/vod";
import type { PreviewFrame } from "@/lib/vodPreviews";
import { chapterBreaks, chapterIndexAt, type VodChapter } from "@/lib/vodChapters";
import { usePreferences } from "@/composables/usePreferences";
import VodPreviewThumb from "./VodPreviewThumb.vue";

const props = defineProps<{
  /** Current media second. */
  value: number;
  /** Media length in seconds. */
  max: number;
  label: string;
  compact?: boolean;
  /** Thumbnail for a media second, when the VOD has previews. */
  previewFor?: (seconds: number) => PreviewFrame | null;
  /** Loaded media as [start, end] seconds, drawn behind the played part. */
  buffered?: [number, number][];
  /** Game chapters: the bar breaks between them and the tooltip names the one hovered. */
  chapters?: VodChapter[];
}>();

const emit = defineEmits<{
  /** The position being dragged to, or null once the drag ends. */
  (e: "scrub", seconds: number | null): void;
  (e: "commit", seconds: number): void;
  /** Relative skip (arrow / page keys), so a synced player moves the shared clock from where it is. */
  (e: "skip", deltaSeconds: number): void;
  /** The pointer entered the bar: a good moment to load previews. */
  (e: "hover"): void;
}>();

const { vodSkipForwardSeconds, vodSkipBackSeconds } = usePreferences();

const barRef = ref<HTMLDivElement | null>(null);
const barWidth = ref(0);
const hoverX = ref<number | null>(null);
const dragValue = ref<number | null>(null);

const length = computed(() => Math.max(props.max, 1));
const clampValue = (s: number) => Math.min(Math.max(s, 0), length.value);
const shownValue = computed(() => dragValue.value ?? clampValue(props.value));
const pct = (s: number) => `${(clampValue(s) / length.value) * 100}%`;

const breaks = computed(() => chapterBreaks(props.chapters ?? [], length.value));
const tipChapter = computed(() => {
  if (tipValue.value === null || !props.chapters?.length) return null;
  return props.chapters[chapterIndexAt(props.chapters, tipValue.value)] ?? null;
});

const bufferedSpans = computed(() =>
  (props.buffered ?? []).map(([start, end]) => ({
    left: pct(start),
    width: `${((clampValue(end) - clampValue(start)) / length.value) * 100}%`,
  }))
);

function measure() {
  const rect = barRef.value?.getBoundingClientRect();
  barWidth.value = rect?.width ?? 0;
  return rect;
}

function xOf(e: PointerEvent) {
  const rect = measure();
  if (!rect || rect.width === 0) return 0;
  return Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
}

const valueAtX = (x: number) => (barWidth.value ? (x / barWidth.value) * length.value : 0);

// the tooltip follows the drag, otherwise the pointer
const tipValue = computed(() => {
  if (dragValue.value !== null) return dragValue.value;
  return hoverX.value === null ? null : valueAtX(hoverX.value);
});
const frame = computed(() =>
  tipValue.value === null || !props.previewFor ? null : props.previewFor(tipValue.value)
);
const thumbWidth = computed(() => (props.compact ? 128 : 176));
const tipLeft = computed(() => {
  if (tipValue.value === null) return 0;
  const x = (tipValue.value / length.value) * barWidth.value;
  const half = frame.value ? thumbWidth.value / 2 : 28;
  return Math.min(Math.max(x, half), Math.max(barWidth.value - half, half));
});

function onPointerEnter() {
  emit("hover");
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  barRef.value?.setPointerCapture(e.pointerId);
  barRef.value?.focus({ preventScroll: true });
  hoverX.value = xOf(e);
  dragValue.value = valueAtX(hoverX.value);
  emit("scrub", dragValue.value);
}

function onPointerMove(e: PointerEvent) {
  hoverX.value = xOf(e);
  if (dragValue.value === null) return;
  dragValue.value = valueAtX(hoverX.value);
  emit("scrub", dragValue.value);
}

function onPointerUp(e: PointerEvent) {
  if (dragValue.value === null) return;
  const target = dragValue.value;
  dragValue.value = null;
  barRef.value?.releasePointerCapture(e.pointerId);
  emit("commit", target);
  emit("scrub", null);
}

// capture lost without a pointerup (e.g. the window lost focus): drop the drag without seeking
function onCaptureLost() {
  if (dragValue.value === null) return;
  dragValue.value = null;
  emit("scrub", null);
}

function onPointerLeave() {
  if (dragValue.value === null) hoverX.value = null;
}

function onKeydown(e: KeyboardEvent) {
  const steps: Record<string, number> = {
    ArrowRight: vodSkipForwardSeconds.value,
    ArrowLeft: -vodSkipBackSeconds.value,
    PageUp: 60,
    PageDown: -60,
  };
  const step = steps[e.key];
  if (step === undefined && e.key !== "Home" && e.key !== "End") return;
  e.preventDefault();
  e.stopPropagation();
  if (step !== undefined) emit("skip", step);
  else emit("commit", e.key === "Home" ? 0 : length.value);
}
</script>

<template>
  <div
    ref="barRef"
    role="slider"
    tabindex="0"
    :aria-label="label"
    :aria-valuemin="0"
    :aria-valuemax="Math.round(length)"
    :aria-valuenow="Math.round(shownValue)"
    :aria-valuetext="formatClock(shownValue)"
    class="group/seek relative cursor-pointer touch-none select-none rounded outline-none focus-visible:ring-1 focus-visible:ring-white/40"
    :class="compact ? 'py-2 -my-1' : 'py-2.5 -my-1'"
    @pointerenter="onPointerEnter"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onCaptureLost"
    @lostpointercapture="onCaptureLost"
    @pointerleave="onPointerLeave"
    @keydown="onKeydown"
  >
    <div
      class="relative h-1 rounded-full bg-white/20 transition-[height] duration-150 group-hover/seek:h-1.5"
      :class="{ 'h-1.5': dragValue !== null }"
    >
      <div
        v-for="(span, i) in bufferedSpans"
        :key="i"
        class="absolute inset-y-0 rounded-full bg-white/25"
        :style="span"
        data-testid="vod-seek-buffered"
      />
      <div
        v-if="hoverX !== null && dragValue === null"
        class="absolute inset-y-0 left-0 rounded-full bg-white/30"
        :style="{ width: `${barWidth ? (hoverX / barWidth) * 100 : 0}%` }"
      />
      <div
        class="absolute inset-y-0 left-0 rounded-full bg-white"
        :style="{ width: pct(shownValue) }"
      />
      <div
        class="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow transition-transform duration-150 group-hover/seek:scale-100"
        :class="dragValue !== null ? 'scale-100' : 'scale-0'"
        :style="{ left: pct(shownValue) }"
      />
      <div
        v-for="at in breaks"
        :key="at"
        class="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-black/80"
        :style="{ left: pct(at) }"
        data-testid="vod-seek-chapter-break"
      />
    </div>

    <div
      v-if="tipValue !== null"
      class="pointer-events-none absolute bottom-full mb-1.5 flex -translate-x-1/2 flex-col items-center gap-1"
      :style="{ left: `${tipLeft}px` }"
    >
      <VodPreviewThumb :frame="frame" :width="thumbWidth" />
      <span
        v-if="tipChapter"
        class="flex max-w-56 items-center gap-1.5 rounded bg-black/85 px-1.5 py-0.5 text-[11px] font-medium text-white shadow"
      >
        <img
          v-if="tipChapter.imageUrl"
          :src="tipChapter.imageUrl"
          alt=""
          class="h-4 w-3 shrink-0 rounded-sm object-cover"
        />
        <span class="truncate">{{ tipChapter.title }}</span>
      </span>
      <span
        class="rounded bg-black/85 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white shadow"
      >
        {{ formatClock(tipValue) }}
      </span>
    </div>
  </div>
</template>
