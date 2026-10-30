<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useStorage } from "@vueuse/core";
import {
  Play,
  Pause,
  Rewind,
  FastForward,
  ChevronDown,
  ChevronUp,
  Minus,
  Plus,
  Loader2,
  Link2,
} from "@lucide/vue";
import { Switch } from "@/components/ui/switch";
import { PLATFORMS } from "@/config/platforms";
import { useVodSync } from "@/composables/useVodSync";
import { formatSpan } from "@/lib/vod";
import { anyRangesOverlap } from "@/lib/vodSync";

const { t, locale } = useI18n();
const {
  vodStreams,
  syncEnabled,
  offsets,
  phases,
  position,
  ranges,
  timeline,
  isPlaying,
  isStalled,
  canJumpToLatest,
  seek,
  seekBy,
  togglePlay,
  jumpToVod,
  jumpToLatest,
  nudgeOffset,
  resetOffset,
  setSyncEnabled,
} = useVodSync();

const expanded = useStorage("vod-sync-bar-expanded", true);
const trackRef = ref<HTMLDivElement | null>(null);
const scrubPos = ref<number | null>(null);
const hoverPos = ref<number | null>(null);

const span = computed(() => {
  const tl = timeline.value;
  return tl ? Math.max(tl.endMs - tl.startMs, 1) : 1;
});

const pct = (ms: number) => {
  const tl = timeline.value;
  if (!tl) return 0;
  return Math.min(100, Math.max(0, ((ms - tl.startMs) / span.value) * 100));
};

const displayPos = computed(() => scrubPos.value ?? position.value);

const lanes = computed(() =>
  vodStreams.value.map((s) => {
    const range = ranges.value.find((r) => r.id === s.id);
    return {
      id: s.id,
      name: s.vod.displayName || s.vod.channel,
      platform: PLATFORMS[s.vod.platform],
      offset: offsets.value[s.id] ?? 0,
      phase: phases[s.id],
      left: range ? pct(range.startMs) : 0,
      width: range ? Math.max(pct(range.endMs) - pct(range.startMs), 0.5) : 0,
      isRecording: range?.isRecording ?? false,
    };
  })
);

const multiDay = computed(() => {
  const tl = timeline.value;
  return !!tl && new Date(tl.startMs).toDateString() !== new Date(tl.endMs).toDateString();
});

const fmt = (ms: number, withDate = multiDay.value) =>
  new Intl.DateTimeFormat(locale.value, {
    ...(withDate ? { month: "short", day: "numeric" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(ms);

const currentLabel = computed(() =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "medium" }).format(
    displayPos.value
  )
);

const overlapLabel = computed(() => {
  if (vodStreams.value.length < 2) return "";
  const overlap = timeline.value?.overlap;
  if (overlap) {
    return t("vods.sync.overlap", {
      duration: formatSpan((overlap.endMs - overlap.startMs) / 1000),
    });
  }
  if (!anyRangesOverlap(ranges.value)) return t("vods.sync.noOverlap");
  const active = lanes.value.filter((l) => l.phase === "active" || l.phase === "loading").length;
  return t("vods.sync.activeCount", { active, total: lanes.value.length });
});

const formatOffset = (s: number) => `${s > 0 ? "+" : ""}${s.toFixed(1)}s`;

const posFromEvent = (e: PointerEvent | MouseEvent) => {
  const el = trackRef.value;
  const tl = timeline.value;
  if (!el || !tl) return null;
  const rect = el.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  return tl.startMs + ratio * span.value;
};

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  trackRef.value?.setPointerCapture(e.pointerId);
  scrubPos.value = posFromEvent(e);
}

function onPointerMove(e: PointerEvent) {
  const pos = posFromEvent(e);
  hoverPos.value = pos;
  if (scrubPos.value !== null) scrubPos.value = pos;
}

function onPointerUp(e: PointerEvent) {
  if (scrubPos.value === null) return;
  trackRef.value?.releasePointerCapture(e.pointerId);
  seek(scrubPos.value);
  scrubPos.value = null;
}

function onTrackKeydown(e: KeyboardEvent) {
  const step = e.shiftKey ? 60 : 10;
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    seekBy(-step);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    seekBy(step);
  } else if (e.key === " ") {
    e.preventDefault();
    togglePlay();
  }
}
</script>

<template>
  <section
    v-if="vodStreams.length"
    data-testid="vod-sync-bar"
    class="shrink-0 bg-[#14161a] border-t border-[#2a2d33] px-3 py-2 text-white select-none"
    :aria-label="t('vods.sync.label')"
  >
    <!-- controls row -->
    <div class="flex items-center gap-2 min-w-0">
      <template v-if="syncEnabled">
        <button
          type="button"
          class="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
          :aria-label="t('vods.sync.back10')"
          :title="t('vods.sync.back10')"
          @click="seekBy(-10)"
        >
          <Rewind class="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-testid="vod-sync-play"
          class="p-1.5 rounded-md text-white hover:bg-white/10 transition-colors cursor-pointer"
          :aria-label="isPlaying ? t('common.pause') : t('common.play')"
          @click="togglePlay"
        >
          <Pause v-if="isPlaying" class="size-4.5" aria-hidden="true" />
          <Play v-else class="size-4.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
          :aria-label="t('vods.sync.forward10')"
          :title="t('vods.sync.forward10')"
          @click="seekBy(10)"
        >
          <FastForward class="size-4" aria-hidden="true" />
        </button>

        <span
          class="text-xs font-medium tabular-nums text-[#eaeaea] whitespace-nowrap"
          data-testid="vod-sync-clock"
          >{{ currentLabel }}</span
        >
        <span v-if="isStalled" class="flex items-center gap-1 text-[11px] text-gray-400">
          <Loader2 class="size-3 animate-spin" aria-hidden="true" />
          {{ t("vods.sync.buffering") }}
        </span>
        <span v-else-if="overlapLabel" class="text-[11px] text-gray-400 truncate">
          {{ overlapLabel }}
        </span>
      </template>
      <span v-else class="text-xs text-gray-400 truncate">{{ t("vods.sync.off") }}</span>

      <div class="ml-auto flex items-center gap-2 shrink-0">
        <button
          v-if="syncEnabled && canJumpToLatest"
          type="button"
          class="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider text-gray-200 bg-white/10 hover:bg-red-600/80 hover:text-white transition-colors cursor-pointer"
          @click="jumpToLatest"
        >
          <span class="size-1.5 rounded-full bg-red-500" />
          {{ t("vods.player.jumpToLatest") }}
        </button>

        <label class="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
          <Link2 class="size-3.5 text-gray-400" aria-hidden="true" />
          {{ t("vods.sync.toggle") }}
          <Switch
            :checked="syncEnabled"
            data-testid="vod-sync-toggle"
            class="scale-75 origin-right"
            @update:checked="setSyncEnabled(!!$event)"
          />
        </label>

        <button
          v-if="syncEnabled"
          type="button"
          class="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
          :aria-label="expanded ? t('vods.sync.hideLanes') : t('vods.sync.showLanes')"
          :title="expanded ? t('vods.sync.hideLanes') : t('vods.sync.showLanes')"
          @click="expanded = !expanded"
        >
          <ChevronDown v-if="expanded" class="size-4" aria-hidden="true" />
          <ChevronUp v-else class="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>

    <!-- timeline -->
    <div v-if="syncEnabled && timeline" class="flex mt-1.5">
      <!-- lane labels -->
      <div class="w-48 shrink-0 pr-2">
        <div class="h-5 flex items-center text-[10px] text-gray-500 tabular-nums">
          {{ fmt(timeline.startMs) }}
        </div>
        <template v-if="expanded">
          <div
            v-for="lane in lanes"
            :key="lane.id"
            class="h-6 flex items-center gap-1.5 min-w-0 group/lane"
            :data-testid="`vod-lane-${lane.id}`"
          >
            <component
              :is="lane.platform.icon"
              :size="11"
              :style="{ color: lane.platform.color }"
              class="shrink-0"
            />
            <button
              type="button"
              class="text-[11px] truncate text-left cursor-pointer transition-colors"
              :class="lane.phase === 'active' ? 'text-[#eaeaea]' : 'text-gray-500'"
              :title="t('vods.player.jumpHere')"
              @click="jumpToVod(lane.id)"
            >
              {{ lane.name }}
            </button>
            <div class="ml-auto flex items-center shrink-0">
              <button
                type="button"
                class="p-0.5 rounded text-gray-500 hover:text-white hover:bg-white/5 cursor-pointer"
                :aria-label="t('vods.sync.offsetDelay')"
                :title="t('vods.sync.offsetDelay')"
                @click="nudgeOffset(lane.id, -1)"
              >
                <Minus class="size-3" aria-hidden="true" />
              </button>
              <button
                type="button"
                class="w-11 text-center text-[10px] tabular-nums rounded cursor-pointer"
                :class="lane.offset ? 'text-amber-300/90 hover:bg-white/5' : 'text-gray-500'"
                :title="t('vods.sync.resetOffset')"
                @click="resetOffset(lane.id)"
              >
                {{ formatOffset(lane.offset) }}
              </button>
              <button
                type="button"
                class="p-0.5 rounded text-gray-500 hover:text-white hover:bg-white/5 cursor-pointer"
                :aria-label="t('vods.sync.offsetAdvance')"
                :title="t('vods.sync.offsetAdvance')"
                @click="nudgeOffset(lane.id, 1)"
              >
                <Plus class="size-3" aria-hidden="true" />
              </button>
            </div>
          </div>
        </template>
      </div>

      <!-- tracks -->
      <div
        ref="trackRef"
        role="slider"
        tabindex="0"
        data-testid="vod-sync-track"
        class="relative flex-1 min-w-0 cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
        :aria-label="t('vods.seek')"
        :aria-valuemin="timeline.startMs"
        :aria-valuemax="timeline.endMs"
        :aria-valuenow="Math.round(displayPos)"
        :aria-valuetext="currentLabel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointerleave="hoverPos = null"
        @keydown="onTrackKeydown"
      >
        <div class="h-5 relative">
          <div
            class="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-[#2a2d33]"
          />
          <div
            v-if="timeline.overlap"
            class="absolute top-1/2 -translate-y-1/2 h-1.5 bg-white/15"
            :style="{
              left: `${pct(timeline.overlap.startMs)}%`,
              width: `${pct(timeline.overlap.endMs) - pct(timeline.overlap.startMs)}%`,
            }"
          />
          <div
            class="absolute left-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-white/80"
            :style="{ width: `${pct(displayPos)}%` }"
          />
          <span
            class="absolute right-0 -top-0.5 text-[10px] text-gray-500 tabular-nums pointer-events-none"
          >
            {{ fmt(timeline.endMs) }}
          </span>
        </div>

        <template v-if="expanded">
          <div v-for="lane in lanes" :key="lane.id" class="h-6 relative">
            <div
              class="absolute inset-x-0 top-1/2 -translate-y-1/2 h-2 rounded-sm bg-white/[0.03]"
            />
            <div
              class="absolute top-1/2 -translate-y-1/2 h-2 rounded-sm transition-opacity"
              :class="lane.phase === 'active' ? 'opacity-80' : 'opacity-35'"
              :style="{
                left: `${lane.left}%`,
                width: `${lane.width}%`,
                background: lane.platform.color,
              }"
            />
            <span
              v-if="lane.isRecording"
              class="absolute top-1/2 -translate-y-1/2 size-1.5 rounded-full bg-red-500 animate-pulse"
              :style="{ left: `calc(${lane.left + lane.width}% - 3px)` }"
            />
          </div>
        </template>

        <!-- hover time -->
        <div
          v-if="hoverPos !== null && scrubPos === null"
          class="absolute top-0 bottom-0 w-px bg-white/25 pointer-events-none"
          :style="{ left: `${pct(hoverPos)}%` }"
        >
          <span
            class="absolute -top-5 -translate-x-1/2 px-1.5 py-0.5 rounded bg-black/80 border border-white/10 text-[10px] tabular-nums whitespace-nowrap"
          >
            {{ fmt(hoverPos, true) }}
          </span>
        </div>

        <!-- playhead -->
        <div
          class="absolute top-0 bottom-0 w-px bg-white pointer-events-none"
          :style="{ left: `${pct(displayPos)}%` }"
        >
          <span class="absolute top-1 -translate-x-1/2 size-3 rounded-full bg-white shadow" />
        </div>
      </div>
    </div>
  </section>
</template>
