<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { GripHorizontal } from "@lucide/vue";
import { usePreferences, type ChatOverlayPosition } from "@/composables/usePreferences";
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
const { chatOverlayPositions, setChatOverlayPosition } = usePreferences();

// dragging: the overlay is click-through, so only the small grip takes the pointer
const KEY_STEP = 0.03;
const overlayRef = ref<HTMLElement | null>(null);
const drag = ref<ChatOverlayPosition | null>(null);
let dragStart: { x: number; y: number; pos: ChatOverlayPosition } | null = null;

const dragged = computed(() => drag.value ?? chatOverlayPositions.value[props.streamId] ?? null);

const overlayStyle = computed(() =>
  dragged.value
    ? { right: `${dragged.value.right * 100}%`, bottom: `${dragged.value.bottom * 100}%` }
    : {}
);

/** Keeps the overlay inside its tile. */
function clampPosition(pos: ChatOverlayPosition): ChatOverlayPosition {
  const el = overlayRef.value;
  const tile = el?.offsetParent?.getBoundingClientRect();
  const box = el?.getBoundingClientRect();
  if (!tile?.width || !tile.height || !box) return pos;
  return {
    right: Math.min(Math.max(pos.right, 0), Math.max(0, 1 - box.width / tile.width)),
    bottom: Math.min(Math.max(pos.bottom, 0), Math.max(0, 1 - box.height / tile.height)),
  };
}

/** Where the overlay sits now, whether or not it was moved. */
function currentPosition(): ChatOverlayPosition {
  const el = overlayRef.value;
  const tile = el?.offsetParent?.getBoundingClientRect();
  const box = el?.getBoundingClientRect();
  if (!tile?.width || !tile.height || !box) return { right: 0.01, bottom: 0.1 };
  return {
    right: (tile.right - box.right) / tile.width,
    bottom: (tile.bottom - box.bottom) / tile.height,
  };
}

function onMove(e: PointerEvent) {
  const tile = overlayRef.value?.offsetParent?.getBoundingClientRect();
  if (!dragStart || !tile?.width || !tile.height) return;
  drag.value = clampPosition({
    right: dragStart.pos.right - (e.clientX - dragStart.x) / tile.width,
    bottom: dragStart.pos.bottom - (e.clientY - dragStart.y) / tile.height,
  });
}

function stopDrag(save: boolean) {
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", onCancel);
  if (save && drag.value) setChatOverlayPosition(props.streamId, drag.value);
  drag.value = null;
  dragStart = null;
}
const onUp = () => stopDrag(true);
const onCancel = () => stopDrag(false);

function startDrag(e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  dragStart = { x: e.clientX, y: e.clientY, pos: currentPosition() };
  // pointer moves over an embed's iframe never reach this page: capture the pointer, and the
  // shield below covers the window while dragging
  (e.currentTarget as Element | null)?.setPointerCapture?.(e.pointerId);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
}

// arrow keys nudge the focused grip; Home/double-click puts the overlay back
function onGripKeydown(e: KeyboardEvent) {
  const arrows: Record<string, [number, number]> = {
    ArrowLeft: [1, 0],
    ArrowRight: [-1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  if (e.key === "Home") {
    e.preventDefault();
    setChatOverlayPosition(props.streamId, null);
    return;
  }
  const arrow = arrows[e.key];
  if (!arrow) return;
  e.preventDefault();
  e.stopPropagation();
  const pos = dragged.value ?? currentPosition();
  setChatOverlayPosition(
    props.streamId,
    clampPosition({
      right: pos.right + arrow[0] * KEY_STEP,
      bottom: pos.bottom - arrow[1] * KEY_STEP,
    })
  );
}

onBeforeUnmount(() => stopDrag(false));

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
    ref="overlayRef"
    class="chat-overlay-box pointer-events-none absolute z-10 flex min-h-6 flex-col justify-end"
    :class="[
      compact ? 'w-[min(240px,45%)] max-h-[36%]' : 'w-[min(320px,38%)] max-h-[35%]',
      dragged ? '' : compact ? 'right-2 bottom-15' : 'right-2 bottom-20',
    ]"
    :style="overlayStyle"
    :data-testid="`chat-overlay-${streamId}`"
  >
    <div class="chat-overlay flex max-h-full flex-col justify-end overflow-hidden" aria-live="off">
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

    <!-- grip: shows while the pointer is over the tile (or focused); drag to move -->
    <div
      role="button"
      tabindex="0"
      class="chat-overlay-grip pointer-events-auto absolute -top-1 right-0 flex h-5 w-8 cursor-grab items-center justify-center rounded-md bg-black/60 text-white/80 opacity-0 transition-opacity hover:bg-black/80 hover:text-white focus-visible:opacity-100 group-hover:opacity-100"
      :class="{ 'cursor-grabbing opacity-100': drag }"
      :aria-label="t('chatOverlay.move')"
      :title="t('chatOverlay.move')"
      :data-testid="`chat-overlay-grip-${streamId}`"
      @pointerdown="startDrag"
      @dblclick.stop="setChatOverlayPosition(streamId, null)"
      @keydown="onGripKeydown"
    >
      <GripHorizontal class="size-3.5" aria-hidden="true" />
    </div>

    <Teleport to="body">
      <div v-if="drag" class="fixed inset-0 z-9998 cursor-grabbing" />
    </Teleport>
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
