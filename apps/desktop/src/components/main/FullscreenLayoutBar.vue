<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Clapperboard, Minimize2, PictureInPicture2 } from "@lucide/vue";
import { KickIcon, TwitchIcon, YoutubeIcon, CustomIcon } from "@/components/icons";
import { useStreams, type Stream } from "@/composables/useStreams";
import { useFullscreenLayout } from "@/composables/useFullscreenLayout";

// Top-edge bar of the fullscreen layout: pick which other streams float over the main one, or
// leave. Pointer moves over the main tile's embed never reach the app, so a thin strip along the
// top edge reveals it; it also shows for a moment on entering so it can be found.
const HINT_MS = 3000;
const HIDE_DELAY_MS = 600;

const { t } = useI18n();
const { streams } = useStreams();
const layout = useFullscreenLayout();

const platformIcons: Record<string, unknown> = {
  twitch: TwitchIcon,
  kick: KickIcon,
  youtube: YoutubeIcon,
  custom: CustomIcon,
};

const others = computed(() => streams.value.filter((s) => !layout.isMain(s.id)));
const titleOf = (s: Stream) => s.vod?.displayName || s.displayName || s.channel;

const revealed = ref(false);
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function reveal() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
  revealed.value = true;
}

function scheduleHide(delay = HIDE_DELAY_MS) {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    revealed.value = false;
    hideTimer = null;
  }, delay);
}

onMounted(() => {
  reveal();
  scheduleHide(HINT_MS);
});

onBeforeUnmount(() => {
  if (hideTimer) clearTimeout(hideTimer);
});
</script>

<template>
  <div
    class="fixed inset-x-0 top-0 h-2 z-49"
    data-testid="pip-bar-trigger"
    @mouseenter="reveal"
    @mouseleave="scheduleHide()"
  />

  <!-- hidden, not inert: tabbing into it reveals it for keyboard users -->
  <div
    role="toolbar"
    :aria-label="t('pip.title')"
    data-testid="pip-layout-bar"
    class="fixed top-2 left-1/2 z-49 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-1.5 rounded-xl border border-[#2a2d33] bg-[#14161a]/95 px-2 py-1.5 text-white shadow-2xl shadow-black/60 backdrop-blur-md transition-all duration-200"
    :class="revealed ? 'opacity-100 translate-y-0' : 'pointer-events-none -translate-y-3 opacity-0'"
    @mouseenter="reveal"
    @mouseleave="scheduleHide()"
    @focusin="reveal"
    @focusout="scheduleHide()"
  >
    <PictureInPicture2 class="size-4 shrink-0 text-gray-400" aria-hidden="true" />
    <span class="shrink-0 text-xs font-medium text-gray-300">{{ t("pip.title") }}</span>

    <div v-if="others.length" class="flex min-w-0 items-center gap-1 overflow-x-auto">
      <button
        v-for="stream in others"
        :key="stream.id"
        type="button"
        :aria-pressed="layout.isPip(stream.id)"
        :title="layout.isPip(stream.id) ? t('pip.close') : t('pip.add')"
        :data-testid="`pip-toggle-${stream.channel}`"
        class="flex max-w-40 shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition-colors cursor-pointer"
        :class="
          layout.isPip(stream.id)
            ? 'border-sky-400/50 bg-sky-500/20 text-white'
            : 'border-[#2a2d33] bg-[#1c1f24] text-gray-300 hover:border-[#3a3f4b] hover:text-white'
        "
        @click="layout.togglePip(stream.id)"
      >
        <Clapperboard v-if="stream.vod" class="size-3.5 shrink-0" aria-hidden="true" />
        <component
          :is="platformIcons[stream.platform]"
          v-else
          class="size-3.5 shrink-0"
          aria-hidden="true"
        />
        <span class="truncate">{{ titleOf(stream) }}</span>
      </button>
    </div>
    <span v-else class="text-xs text-gray-500">{{ t("pip.none") }}</span>

    <div class="mx-0.5 h-5 w-px shrink-0 bg-[#2a2d33]" />
    <button
      type="button"
      :aria-label="t('pip.exit')"
      :title="t('pip.exit')"
      data-testid="pip-exit"
      class="flex size-7 shrink-0 items-center justify-center rounded-lg text-gray-300 hover:bg-white/10 hover:text-white cursor-pointer"
      @click="layout.exit()"
    >
      <Minimize2 class="size-4" />
    </button>
  </div>
</template>
