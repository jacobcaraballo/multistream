<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import { GripHorizontal, Minus, Plus } from "@lucide/vue";
import { usePreferences, type ChatOverlayPosition } from "@/composables/usePreferences";
import {
  normalizeFontScale,
  placementStyle,
  snapPosition,
  type Geometry,
} from "@/lib/chatOverlayLayout";
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
const {
  chatOverlayPositions,
  chatOverlayFontScale,
  setChatOverlayPosition,
  stepChatOverlayFontScale,
} = usePreferences();

// dragging: the overlay is click-through, so only the small control bar takes the pointer
const KEY_STEP = 0.03;
// where an unmoved overlay sits above the tile's bottom (clear of the player controls)
const bottomGap = computed(() => (props.compact ? 60 : 80));
const overlayRef = ref<HTMLElement | null>(null);
const drag = ref<ChatOverlayPosition | null>(null);
let dragStart: { x: number; y: number; pos: ChatOverlayPosition } | null = null;

const dragged = computed(() => drag.value ?? chatOverlayPositions.value[props.streamId] ?? null);
const scale = computed(() => normalizeFontScale(chatOverlayFontScale.value));

const baseWidth = computed(() => (props.compact ? 240 : 320));
const basePercent = computed(() => (props.compact ? 45 : 38));
const overlayStyle = computed(() => ({
  // bigger text gets a wider box so lines don't wrap into a tall column
  width: `min(${baseWidth.value * scale.value}px, ${Math.min(90, basePercent.value * scale.value)}%)`,
  ...(dragged.value
    ? placementStyle(dragged.value, bottomGap.value)
    : { right: "0.5rem", bottom: `${bottomGap.value}px` }),
}));
const fontSize = computed(() => `${(props.compact ? 11 : 13) * scale.value}px`);

function tileGeometry(): Geometry | null {
  const el = overlayRef.value;
  const tile = el?.offsetParent?.getBoundingClientRect();
  const box = el?.getBoundingClientRect();
  if (!tile?.width || !tile.height || !box) return null;
  return {
    tileWidth: tile.width,
    tileHeight: tile.height,
    boxWidth: box.width,
    boxHeight: box.height,
    bottomGap: bottomGap.value,
  };
}

/** Keeps the overlay inside its tile. */
function clampPosition(pos: ChatOverlayPosition): ChatOverlayPosition {
  const g = tileGeometry();
  if (!g) return pos;
  return {
    right: Math.min(Math.max(pos.right, 0), Math.max(0, 1 - g.boxWidth / g.tileWidth)),
    bottom: Math.min(Math.max(pos.bottom, 0), Math.max(0, 1 - g.boxHeight / g.tileHeight)),
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
  const g = tileGeometry();
  if (!dragStart || !g) return;
  const free = clampPosition({
    right: dragStart.pos.right - (e.clientX - dragStart.x) / g.tileWidth,
    bottom: dragStart.pos.bottom - (e.clientY - dragStart.y) / g.tileHeight,
  });
  // near a side, corner or centre line it pins there
  drag.value = snapPosition(free, g);
}

function stopDrag(save: boolean) {
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", onCancel);
  if (save && drag.value) setChatOverlayPosition(props.streamId, drag.value);
  drag.value = null;
  dragStart = null;
  wake();
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
  // measured, so a pinned overlay starts from where it really is; the nudge unpins it
  const pos = currentPosition();
  setChatOverlayPosition(
    props.streamId,
    snapPosition(
      clampPosition({
        right: pos.right + arrow[0] * KEY_STEP,
        bottom: pos.bottom - arrow[1] * KEY_STEP,
      }),
      tileGeometry() ?? { tileWidth: 1, tileHeight: 1, boxWidth: 0, boxHeight: 0, bottomGap: 0 }
    )
  );
}

// the control bar shows while the pointer is active over the tile and fades with the player's own
// controls; the grid relays pointer moves over embeds, which the page itself never sees
const CONTROLS_MS = 2500;
const controlsShown = ref(false);
const overBar = ref(false);
const barFocused = ref(false);
let controlsTimer: ReturnType<typeof setTimeout> | null = null;

function hideControls() {
  if (controlsTimer) clearTimeout(controlsTimer);
  controlsTimer = null;
  controlsShown.value = false;
}

function wake() {
  if (controlsTimer) clearTimeout(controlsTimer);
  controlsShown.value = true;
  controlsTimer = setTimeout(() => {
    controlsTimer = null;
    if (!drag.value && !overBar.value && !barFocused.value) controlsShown.value = false;
  }, CONTROLS_MS);
}

const barVisible = computed(
  () => controlsShown.value || !!drag.value || overBar.value || barFocused.value
);

onMounted(() => {
  const tile = overlayRef.value?.offsetParent;
  if (!tile) return;
  tile.addEventListener("pointermove", wake, { passive: true });
  tile.addEventListener("pointerenter", wake, { passive: true });
  tile.addEventListener("pointerleave", hideControls, { passive: true });
  stopTile = () => {
    tile.removeEventListener("pointermove", wake);
    tile.removeEventListener("pointerenter", wake);
    tile.removeEventListener("pointerleave", hideControls);
  };
});
let stopTile: (() => void) | null = null;

useEventListener(window, "multistream-tile-activity", (e: Event) => {
  if ((e as CustomEvent<{ streamId: string }>).detail?.streamId === props.streamId) wake();
});

onBeforeUnmount(() => {
  stopDrag(false);
  stopTile?.();
  if (controlsTimer) clearTimeout(controlsTimer);
});

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
    :class="compact ? 'max-h-[36%]' : 'max-h-[35%]'"
    :style="overlayStyle"
    :data-testid="`chat-overlay-${streamId}`"
  >
    <div class="chat-overlay flex max-h-full flex-col justify-end overflow-hidden" aria-live="off">
      <p v-if="needsTwitchSignIn && !lines.length" class="text-white/80" :style="{ fontSize }">
        {{ t("chatOverlay.twitchSignIn") }}
      </p>
      <p
        v-for="line in lines"
        :key="line.id"
        class="chat-overlay-line break-words leading-snug text-white"
        :style="{ fontSize }"
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

    <!-- controls: show while the pointer is active over the tile, like the player's own -->
    <div
      class="absolute -top-1 right-0 flex h-5 items-center gap-0.5 rounded-md bg-black/60 px-0.5 text-white/80 transition-opacity duration-300"
      :class="barVisible ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'"
      :data-testid="`chat-overlay-controls-${streamId}`"
      @pointerenter="overBar = true"
      @pointerleave="
        overBar = false;
        wake();
      "
      @focusin="barFocused = true"
      @focusout="barFocused = false"
    >
      <button
        type="button"
        class="flex size-4 items-center justify-center rounded hover:bg-white/15 hover:text-white cursor-pointer"
        :aria-label="t('chatOverlay.fontSmaller')"
        :title="t('chatOverlay.fontSmaller')"
        :data-testid="`chat-overlay-smaller-${streamId}`"
        @click.stop="stepChatOverlayFontScale(-1)"
      >
        <Minus class="size-3" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="flex size-4 items-center justify-center rounded hover:bg-white/15 hover:text-white cursor-pointer"
        :aria-label="t('chatOverlay.fontLarger')"
        :title="t('chatOverlay.fontLarger')"
        :data-testid="`chat-overlay-larger-${streamId}`"
        @click.stop="stepChatOverlayFontScale(1)"
      >
        <Plus class="size-3" aria-hidden="true" />
      </button>
      <div
        role="button"
        tabindex="0"
        class="flex h-4 w-6 cursor-grab items-center justify-center rounded hover:bg-white/15 hover:text-white"
        :class="{ 'cursor-grabbing': drag }"
        :aria-label="t('chatOverlay.move')"
        :title="t('chatOverlay.move')"
        :data-testid="`chat-overlay-grip-${streamId}`"
        @pointerdown="startDrag"
        @dblclick.stop="setChatOverlayPosition(streamId, null)"
        @keydown="onGripKeydown"
      >
        <GripHorizontal class="size-3.5" aria-hidden="true" />
      </div>
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
