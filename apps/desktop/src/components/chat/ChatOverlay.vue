<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useUnifiedChat } from "@/composables/useUnifiedChat";
import { kickChannelMessages } from "@/composables/useKickChat";
import { useVodChatReplay } from "@/composables/useVodChatReplay";
import { useEmotes } from "@/composables/useEmotes";
import { useTwitchAuth } from "@/composables/useTwitchAuth";

const props = defineProps<{
  streamId: string;
  channel: string;
  platform: "twitch" | "kick";
  isVod?: boolean;
  /** Smaller text for tiles that share the grid. */
  compact?: boolean;
}>();

const MAX_LINES = 8;
const COMPACT_LINES = 5;

const { t } = useI18n();
const { parseMessage, loadChannelEmotes } = useEmotes();
const { authenticated: twitchSignedIn } = useTwitchAuth();

// live chat comes from the connections the sidebar already holds; this only reads it
// (Twitch: the signed-in chat panes keep useUnifiedChat alive; Kick: the joined chats' store)
const unified = !props.isVod && props.platform === "twitch" ? useUnifiedChat() : null;

// VOD chat is replayed for this tile while the overlay is shown
const replay = props.isVod ? useVodChatReplay() : null;
const releaseReplay = replay?.requestOverlay(props.streamId);
onBeforeUnmount(() => releaseReplay?.());

watch(
  () => props.channel,
  (channel) => {
    if (channel) loadChannelEmotes(channel.toLowerCase()).catch(() => {});
  },
  { immediate: true }
);

// newest first, like the sources
const newest = computed(() => {
  if (replay) return replay.streamMessages.value[props.streamId] ?? [];
  const channel = props.channel.toLowerCase();
  if (unified) {
    return (unified.channelMessagesMap.value[channel] ?? []).filter((m) => m.platform !== "kick");
  }
  return kickChannelMessages.value[channel] ?? [];
});

const lines = computed(() =>
  newest.value
    .slice(0, props.compact ? COMPACT_LINES : MAX_LINES)
    .map((m) => ({
      id: m.id,
      name: m.display_name || m.username,
      color: m.color || "#e5e7eb",
      tokens: parseMessage(m.message, m.emotes ?? null, m.channel),
    }))
    .reverse()
);

const needsTwitchSignIn = computed(
  () => !props.isVod && props.platform === "twitch" && !twitchSignedIn.value
);
</script>

<template>
  <div
    class="chat-overlay pointer-events-none absolute right-2 z-10 flex flex-col justify-end overflow-hidden"
    :class="
      compact
        ? 'bottom-15 w-[min(240px,45%)] max-h-[36%]'
        : 'bottom-20 w-[min(320px,38%)] max-h-[35%]'
    "
    :data-testid="`chat-overlay-${streamId}`"
    aria-live="off"
  >
    <p v-if="needsTwitchSignIn && !lines.length" class="text-[11px] text-white/80">
      {{ t("chatOverlay.twitchSignIn") }}
    </p>
    <p
      v-for="line in lines"
      :key="line.id"
      class="chat-overlay-line break-words text-white"
      :class="compact ? 'text-[11px] leading-snug' : 'text-[13px] leading-snug'"
    >
      <span class="font-bold" :style="{ color: line.color }">{{ line.name }}</span
      ><span class="text-white/70">: </span>
      <template v-for="(token, index) in line.tokens" :key="index">
        <img
          v-if="token.type === 'emote'"
          :src="token.content"
          :alt="token.code"
          class="inline-block object-contain align-middle"
          style="height: 1.4em; max-width: 100%"
          loading="lazy"
          decoding="async"
        />
        <span v-else>{{ token.content }}</span>
      </template>
    </p>
  </div>
</template>

<style scoped>
.chat-overlay {
  /* fade the oldest lines out at the top */
  mask-image: linear-gradient(to bottom, transparent 0, #000 1.5rem);
  text-shadow:
    0 1px 2px rgba(0, 0, 0, 0.95),
    0 0 4px rgba(0, 0, 0, 0.8);
}

/* each line fades away on its own after a while, so a quiet chat clears the screen */
.chat-overlay-line {
  animation:
    chat-overlay-fade 0.25s ease-out,
    chat-overlay-expire 1s ease-in 20s forwards;
}

@keyframes chat-overlay-fade {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}

@keyframes chat-overlay-expire {
  to {
    opacity: 0;
  }
}
</style>
