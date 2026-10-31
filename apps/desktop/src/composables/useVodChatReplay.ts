import { createSharedComposable } from "@vueuse/core";
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useVodSync, type VodStream } from "./useVodSync";
import {
  BACKFILL_S,
  KEEP_BEHIND_S,
  advanceAfterFetch,
  isSeek,
  mergeMessages,
  nextFetchOffset,
  visibleMessages,
  type ReplayMessage,
} from "@/lib/vodChat";

export const VOD_CHAT_ID = "__vod_chat__";

const TICK_MS = 500;
const RETRY_AFTER_MS = 5000;
/** Newest revealed messages kept per stream for its tile's chat overlay. */
export const OVERLAY_MESSAGES = 20;

interface ChatTrack {
  messages: ReplayMessage[];
  seen: Set<string>;
  fetchedUntil: number;
  lastTime: number | null;
  loading: boolean;
  generation: number;
  retryAt: number;
}

const newTrack = (): ChatTrack => ({
  messages: [],
  seen: new Set(),
  fetchedUntil: 0,
  lastTime: null,
  loading: false,
  generation: 0,
  retryAt: 0,
});

const resetTrack = (track: ChatTrack, time: number) => {
  track.messages = [];
  track.seen.clear();
  track.fetchedUntil = Math.max(0, time - BACKFILL_S);
  track.generation++;
  track.loading = false;
  track.retryAt = 0;
};

const prune = (track: ChatTrack, time: number) => {
  const cutoff = time - KEEP_BEHIND_S;
  if (track.messages[0] && track.messages[0].offset_seconds < cutoff) {
    track.messages = track.messages.filter((m) => m.offset_seconds >= cutoff);
  }
};

const sameIds = (a: ReplayMessage[], b: ReplayMessage[]) =>
  a.length === b.length && a.every((m, i) => m.id === b[i]?.id);

/**
 * @brief Chat replay for the VODs in the grid, following each player's media time
 *
 * Fetches chat a little ahead of every VOD's playhead and reveals messages once their player
 * reaches them. Runs while `active` (the replay panel is shown) or while a tile shows its
 * chat overlay (`requestOverlay`), fetching only for the streams someone is showing.
 */
const _useVodChatReplay = () => {
  const sync = useVodSync();

  const active = ref(false);
  const hidden = ref(new Set<string>());
  const messages = shallowRef<ReplayMessage[]>([]);
  const isLoading = ref(false);
  const overlayCounts = ref<Record<string, number>>({});
  const streamMessages = shallowRef<Record<string, ReplayMessage[]>>({});

  const hasOverlay = (id: string) => (overlayCounts.value[id] ?? 0) > 0;

  const tracks = new Map<string, ChatTrack>();
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const liveEdgeOf = (id: string): number | null => {
    const player = sync.players[id];
    return player?.isRecording ? player.endS : null;
  };

  const fetchChat = async (stream: VodStream, track: ChatTrack, from: number) => {
    const generation = track.generation;
    track.loading = true;
    try {
      const page = await invoke<ReplayMessage[]>("vod_chat", {
        platform: stream.vod.platform,
        vodId: stream.vod.id,
        channel: stream.vod.channel,
        startedAt: stream.vod.startedAt,
        offsetSeconds: from,
      });
      if (generation !== track.generation) return;
      track.messages = mergeMessages(track.messages, page, track.seen);
      track.fetchedUntil = advanceAfterFetch(
        stream.vod.platform,
        from,
        page,
        liveEdgeOf(stream.id)
      );
    } catch {
      if (generation === track.generation) track.retryAt = Date.now() + RETRY_AFTER_MS;
    } finally {
      if (generation === track.generation) track.loading = false;
    }
  };

  const tick = () => {
    const streams = sync.vodStreams.value;
    const views = [];
    const perStream: Record<string, ReplayMessage[]> = {};
    let waitingForFirstPage = false;
    // running only for overlays: leave the streams nobody is showing alone
    const forPanel = active.value || !Object.values(overlayCounts.value).some((n) => n > 0);

    for (const stream of streams) {
      const overlay = hasOverlay(stream.id);
      if (!forPanel && !overlay) continue;

      let track = tracks.get(stream.id);
      if (!track) {
        track = newTrack();
        tracks.set(stream.id, track);
      }

      // synced VODs that don't cover the current moment ("starts in" / "ended") have no chat now
      const phase = sync.phases[stream.id];
      if (sync.syncEnabled.value && phase !== "active") continue;

      const time = sync.mediaTimeOf(stream.id);
      if (time === null) continue;

      if (track.lastTime === null || isSeek(track.lastTime, time)) resetTrack(track, time);
      track.lastTime = time;
      prune(track, time);

      const from = nextFetchOffset(track.fetchedUntil, time, liveEdgeOf(stream.id));
      if (from !== null && !track.loading && Date.now() >= track.retryAt) {
        void fetchChat(stream, track, from);
      }
      if (track.loading && !track.messages.length) waitingForFirstPage = true;

      if (forPanel && !hidden.value.has(stream.id)) {
        views.push({ messages: track.messages, time });
      }
      if (overlay) {
        perStream[stream.id] = visibleMessages(
          [{ messages: track.messages, time }],
          OVERLAY_MESSAGES
        );
      }
    }

    for (const id of tracks.keys()) {
      if (!streams.some((s) => s.id === id)) tracks.delete(id);
    }

    // ticks that only serve overlays leave the panel's list as it was
    if (forPanel) {
      const next = visibleMessages(views);
      if (!sameIds(next, messages.value)) messages.value = next;
      isLoading.value = waitingForFirstPage && !next.length;
    }

    const previous = streamMessages.value;
    const changed =
      Object.keys(previous).length !== Object.keys(perStream).length ||
      Object.entries(perStream).some(([id, list]) => !sameIds(list, previous[id] ?? []));
    if (changed) streamMessages.value = perStream;
  };

  const start = () => {
    if (intervalId) return;
    tick();
    intervalId = setInterval(tick, TICK_MS);
  };

  const stop = () => {
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
  };

  watch(
    () =>
      (active.value || Object.values(overlayCounts.value).some((n) => n > 0)) &&
      sync.vodStreams.value.length > 0,
    (run) => (run ? start() : stop()),
    { immediate: true }
  );

  onScopeDispose(stop);

  const toggleHidden = (id: string) => {
    const next = new Set(hidden.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    hidden.value = next;
    if (intervalId) tick();
  };

  const setActive = (value: boolean) => {
    active.value = value;
    // already running for overlays: refresh the panel now rather than on the next interval
    if (value && intervalId) tick();
  };

  /** A tile's chat overlay wants this stream's chat; call the returned function when it closes. */
  const requestOverlay = (id: string) => {
    overlayCounts.value = { ...overlayCounts.value, [id]: (overlayCounts.value[id] ?? 0) + 1 };
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (overlayCounts.value[id] ?? 1) - 1;
      const next = { ...overlayCounts.value };
      if (left > 0) next[id] = left;
      else delete next[id];
      overlayCounts.value = next;
    };
  };

  return {
    vodStreams: sync.vodStreams,
    messages,
    isLoading,
    hidden: computed(() => hidden.value),
    toggleHidden,
    setActive,
    streamMessages,
    requestOverlay,
    tick,
  };
};

export const useVodChatReplay = createSharedComposable(_useVodChatReplay);
