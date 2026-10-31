<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { PreviewFrame } from "@/lib/vodPreviews";

const props = defineProps<{ frame: PreviewFrame | null; width: number }>();

const height = computed(() => Math.round((props.width * 9) / 16));

const spriteStyle = computed(() => {
  const frame = props.frame;
  if (frame?.kind !== "sprite") return null;
  const scale = props.width / frame.width;
  return {
    backgroundImage: `url("${frame.url}")`,
    backgroundPosition: `${-frame.x * scale}px ${-frame.y * scale}px`,
    backgroundSize: `${frame.sheetWidth * scale}px auto`,
  };
});

// Kick frames are full 1080p JPEGs: load one at a time and only swap in decoded images, so
// sweeping across the bar shows the latest frame instead of queueing dozens of downloads
const shownUrl = ref<string | null>(null);
// the frame the pointer is on now; a load that finishes for any other frame is not shown
let wantedUrl: string | null = null;
let loadingUrl: string | null = null;
let disposed = false;

function load(url: string) {
  loadingUrl = url;
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  img
    .decode()
    .then(() => {
      if (!disposed && url === wantedUrl) shownUrl.value = url;
    })
    .catch(() => {})
    .finally(() => {
      if (disposed) return;
      loadingUrl = null;
      // the pointer moved on while this loaded: fetch where it is now
      if (wantedUrl && wantedUrl !== shownUrl.value && wantedUrl !== url) load(wantedUrl);
    });
}

watch(
  () => (props.frame?.kind === "image" ? props.frame.url : null),
  (url) => {
    wantedUrl = url;
    if (!url || url === shownUrl.value || loadingUrl) return;
    load(url);
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  disposed = true;
});
</script>

<template>
  <div
    v-if="frame"
    class="overflow-hidden rounded-md border border-white/15 bg-black shadow-xl"
    :style="{ width: `${width}px`, height: `${height}px` }"
    aria-hidden="true"
  >
    <div v-if="spriteStyle" class="size-full bg-no-repeat" :style="spriteStyle" />
    <img v-else-if="shownUrl" :src="shownUrl" alt="" class="size-full object-cover" />
  </div>
</template>
