<script lang="ts" setup>
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowDown, Loader2, MessageSquareOff } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import UnifiedChatMessage from "./UnifiedChatMessage.vue";
import { CHANNEL_PALETTE } from "@/composables/useUnifiedChat";
import { useEmotes } from "@/composables/useEmotes";
import { useVodChatReplay } from "@/composables/useVodChatReplay";

const props = defineProps<{ active: boolean }>();

const { t, locale } = useI18n();
const { vodStreams, messages, isLoading, hidden, toggleHidden, setActive } = useVodChatReplay();
const { loadChannelEmotes } = useEmotes();

watch(() => props.active, setActive, { immediate: true });

watch(
  () =>
    vodStreams.value
      .filter((s) => s.vod.platform === "twitch")
      .map((s) => s.vod.channel.toLowerCase()),
  (channels) => channels.forEach((channel) => loadChannelEmotes(channel)),
  { immediate: true }
);

const colors = computed(() => {
  const map = new Map<string, string>();
  for (const s of vodStreams.value) {
    const key = s.vod.channel.toLowerCase();
    if (!map.has(key)) map.set(key, CHANNEL_PALETTE[map.size % CHANNEL_PALETTE.length] ?? "");
  }
  return map;
});

const channelColor = (channel: string) => colors.value.get(channel.toLowerCase()) ?? "#9ca3af";

// two VODs from one channel get their date so the chips can be told apart
const chipLabels = computed(() => {
  const counts = new Map<string, number>();
  for (const s of vodStreams.value) {
    const key = s.vod.channel.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const date = new Intl.DateTimeFormat(locale.value, { month: "short", day: "numeric" });
  return new Map(
    vodStreams.value.map((s) => {
      const name = s.vod.displayName || s.vod.channel;
      const shared = (counts.get(s.vod.channel.toLowerCase()) ?? 0) > 1;
      return [s.id, shared ? `${name} · ${date.format(s.vod.startedAt)}` : name];
    })
  );
});

const scrollContainer = ref<HTMLElement | null>(null);
const isScrolledUp = ref(false);

function handleScroll() {
  if (scrollContainer.value) {
    isScrolledUp.value = Math.abs(scrollContainer.value.scrollTop) > 50;
  }
}

function scrollToBottom() {
  if (scrollContainer.value) {
    scrollContainer.value.scrollTop = 0;
    isScrolledUp.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col h-full bg-[#0f1115] relative" data-testid="vod-chat-replay">
    <div
      v-if="vodStreams.length > 1"
      class="flex gap-1.5 overflow-x-auto px-3 py-2 border-b border-[#1f2227] shrink-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="group"
      :aria-label="t('vods.chat.filter')"
    >
      <button
        v-for="stream in vodStreams"
        :key="stream.id"
        type="button"
        :aria-pressed="!hidden.has(stream.id)"
        :data-testid="`vod-chat-filter-${stream.vod.id}`"
        :title="stream.vod.title"
        class="flex-none inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium border transition-colors duration-150 cursor-pointer"
        :class="
          hidden.has(stream.id)
            ? 'text-gray-500 border-[#2a2d33] bg-transparent hover:text-gray-300'
            : 'text-white border-white/20 bg-white/10 hover:bg-white/15'
        "
        @click="toggleHidden(stream.id)"
      >
        <span
          class="size-1.5 rounded-full"
          :style="{ background: channelColor(stream.vod.channel) }"
          aria-hidden="true"
        />
        {{ chipLabels.get(stream.id) }}
      </button>
    </div>

    <div class="flex-1 relative min-h-0">
      <div
        v-if="!messages.length"
        class="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center"
      >
        <Loader2 v-if="isLoading" class="size-5 animate-spin text-gray-500" aria-hidden="true" />
        <MessageSquareOff v-else class="size-6 text-gray-600" aria-hidden="true" />
        <p class="text-xs text-gray-400 max-w-56">
          {{ isLoading ? t("vods.chat.loading") : t("vods.chat.empty") }}
        </p>
      </div>

      <div
        ref="scrollContainer"
        class="absolute inset-0 overflow-y-auto overflow-x-hidden custom-scrollbar pt-1 flex flex-col-reverse"
        @scroll="handleScroll"
      >
        <UnifiedChatMessage
          v-for="msg in messages"
          :key="msg.id"
          :message="msg"
          :channel-color="channelColor(msg.channel)"
          :show-platform-icon="vodStreams.length > 1"
        />
      </div>

      <Transition name="fade">
        <div v-if="isScrolledUp" class="absolute bottom-4 left-1/2 -translate-x-1/2 z-20">
          <Button
            variant="secondary"
            size="sm"
            class="bg-[#1f232b]/95 hover:bg-[#2a2d33] text-gray-200 border border-white/10 shadow-lg rounded-full px-4 flex items-center gap-2 font-medium backdrop-blur-sm"
            @click="scrollToBottom"
          >
            {{ t("vods.chat.resume") }}
            <ArrowDown class="w-4 h-4" />
          </Button>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: #2a2d33;
  border-radius: 4px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: #3a3f4b;
}
.fade-leave-active {
  transition: opacity 0.4s ease;
}
.fade-leave-to {
  opacity: 0;
}
</style>
