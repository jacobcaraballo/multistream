import { createSharedComposable, useStorage } from "@vueuse/core";
import { computed, onScopeDispose, reactive, ref, shallowRef, watch } from "vue";
import { useStreams, type Stream } from "./useStreams";
import type { Vod } from "@/lib/vod";
import {
  LIVE_EDGE_BUFFER_MS,
  PAUSED_TOLERANCE_S,
  classifyPhase,
  clampPosition,
  computeTimeline,
  isHoldingClock,
  latestPlayablePosition,
  mediaTarget,
  nextPlaybackSpeed,
  planCorrection,
  positionForMediaTime,
  type Timeline,
  type VodPhase,
  type VodRange,
} from "@/lib/vodSync";

export type VodPlayerStatus = "loading" | "ready" | "error";

export interface VodPlayerState {
  status: VodPlayerStatus;
  /** Wall-clock epoch ms of media t=0. */
  startMs: number;
  /** Newest playable media second. */
  endS: number;
  isRecording: boolean;
}

export type VodStream = Stream & { vod: Vod };

const TICK_MS = 200;
const PERSIST_EVERY_MS = 2000;
const OFFSET_STEP_S = 0.5;

const setRate = (video: HTMLVideoElement, rate: number) => {
  if (Math.abs(video.playbackRate - rate) > 0.001) video.playbackRate = rate;
};

/**
 * @brief Shared wall-clock that keeps every VOD tile on the same moment in time
 *
 * One virtual clock (epoch ms) drives all VOD players. Each tick maps the clock to every
 * player's media time, holds the clock while any in-range player is buffering or seeking,
 * and corrects drift with small playbackRate nudges (hard seek for large drift). The clock
 * can run faster or slower than real time; every player's rate follows the shared speed.
 * VODs that don't cover the current moment are paused behind a "starts in / ended" overlay.
 */
const _useVodSync = () => {
  const { streams } = useStreams();

  const syncEnabled = useStorage("vod-sync-enabled", true);
  const offsets = useStorage<Record<string, number>>("vod-sync-offsets", {});
  const savedPosition = useStorage<number>("vod-sync-position", 0);

  const players = reactive<Record<string, VodPlayerState>>({});
  const phases = reactive<Record<string, VodPhase>>({});
  const videos = new Map<string, HTMLVideoElement>();

  const isPlaying = ref(true);
  const isStalled = ref(false);
  const speed = ref(1);
  const position = ref(0);
  const ranges = shallowRef<VodRange[]>([]);
  const timeline = shallowRef<Timeline | null>(null);

  let anchorWall = 0;
  let anchorPerf = 0;
  let running = false;
  let initialized = false;
  let lastPersist = 0;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const clockNow = () =>
    running ? anchorWall + (performance.now() - anchorPerf) * speed.value : anchorWall;
  const setClock = (wallMs: number, run: boolean) => {
    anchorWall = wallMs;
    anchorPerf = performance.now();
    running = run;
  };

  // re-anchor first so time already elapsed isn't rescaled by the new speed
  const applySpeed = (next: number) => {
    setClock(clockNow(), running);
    speed.value = next;
  };

  const vodStreams = computed(() => streams.value.filter((s): s is VodStream => !!s.vod));

  const offsetOf = (id: string) => offsets.value[id] ?? 0;

  // Metadata stands in until the player has parsed the playlist's program date-times.
  const effectiveState = (stream: VodStream): VodPlayerState => {
    const player = players[stream.id];
    if (player?.status === "ready") return player;
    const { vod } = stream;
    const estimatedEdgeS = (Date.now() - LIVE_EDGE_BUFFER_MS - vod.startedAt) / 1000;
    return {
      status: player?.status ?? "loading",
      startMs: vod.startedAt,
      endS: vod.isRecording ? Math.max(vod.durationSeconds, estimatedEdgeS) : vod.durationSeconds,
      isRecording: vod.isRecording,
    };
  };

  const rangeFor = (stream: VodStream): VodRange => {
    const state = effectiveState(stream);
    const offsetMs = offsetOf(stream.id) * 1000;
    return {
      id: stream.id,
      startMs: state.startMs - offsetMs,
      endMs: state.startMs + state.endS * 1000 - offsetMs,
      isRecording: state.isRecording,
    };
  };

  const applyIndependentPhases = (list: VodStream[]) => {
    for (const s of list) {
      const status = players[s.id]?.status ?? "loading";
      phases[s.id] = status === "ready" ? "active" : status;
    }
    isStalled.value = false;
  };

  const drivePlayers = (list: VodStream[], pos: number) => {
    for (const s of list) {
      const video = videos.get(s.id);
      if (!video || players[s.id]?.status !== "ready") continue;

      if (phases[s.id] !== "active") {
        if (!video.paused) video.pause();
        setRate(video, speed.value);
        // park upcoming VODs at their first frame so they start instantly
        if (phases[s.id] === "before" && video.currentTime > PAUSED_TOLERANCE_S && !video.seeking) {
          video.currentTime = 0;
        }
        continue;
      }

      const state = effectiveState(s);
      const target = mediaTarget(pos, state.startMs, offsetOf(s.id));
      const plan = planCorrection(video.currentTime, target, running, video.paused);
      if (plan.seekTo !== null) video.currentTime = plan.seekTo;
      setRate(video, speed.value * plan.rate);
      if (plan.pause) video.pause();
      if (plan.play) video.play().catch(() => {});
    }
  };

  const tick = () => {
    const list = vodStreams.value;
    if (!list.length) return;

    const nextRanges = list.map(rangeFor);
    const nextTimeline = computeTimeline(nextRanges);
    ranges.value = nextRanges;
    timeline.value = nextTimeline;

    if (!initialized && nextTimeline) {
      const saved = savedPosition.value;
      const resumable = saved >= nextTimeline.startMs && saved <= nextTimeline.endMs;
      setClock(resumable ? saved : (nextTimeline.overlap?.startMs ?? nextTimeline.startMs), false);
      initialized = true;
    }

    if (!syncEnabled.value) {
      applyIndependentPhases(list);
      return;
    }

    let pos = clockNow();
    const clamped = clampPosition(pos, nextTimeline);
    if (clamped !== pos) {
      pos = clamped;
      const reachedEnd = !!nextTimeline && pos >= nextTimeline.endMs;
      if (reachedEnd && !nextRanges.some((r) => r.isRecording)) isPlaying.value = false;
      setClock(pos, running && isPlaying.value);
    }

    // recordings can't be watched faster than they are produced
    if (speed.value > 1) {
      const latest = latestPlayablePosition(nextRanges);
      if (latest !== null && pos >= latest) applySpeed(1);
    }

    let holding = false;
    for (const s of list) {
      const state = effectiveState(s);
      const target = mediaTarget(pos, state.startMs, offsetOf(s.id));
      const phase = classifyPhase(target, state.endS, state.isRecording, state.status);
      phases[s.id] = phase;

      if (phase === "loading") holding = true;
      const video = videos.get(s.id);
      if (
        phase === "active" &&
        video &&
        isHoldingClock(video.seeking, video.readyState, target, state.endS, state.isRecording)
      ) {
        holding = true;
      }
    }

    const shouldRun = isPlaying.value && !holding;
    if (shouldRun !== running) setClock(pos, shouldRun);
    isStalled.value = isPlaying.value && holding;
    position.value = pos;

    drivePlayers(list, pos);

    const now = Date.now();
    if (now - lastPersist >= PERSIST_EVERY_MS) {
      savedPosition.value = Math.round(pos);
      lastPersist = now;
    }
  };

  const startTicking = () => {
    if (intervalId) return;
    intervalId = setInterval(tick, TICK_MS);
  };

  const stopTicking = () => {
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
  };

  watch(
    () => vodStreams.value.map((s) => s.id),
    (ids) => {
      if (ids.length) {
        startTicking();
      } else {
        stopTicking();
        initialized = false;
        timeline.value = null;
        ranges.value = [];
      }

      const alive = new Set(ids);
      const stale = Object.keys(offsets.value).filter((id) => !alive.has(id));
      if (stale.length) {
        offsets.value = Object.fromEntries(
          Object.entries(offsets.value).filter(([id]) => alive.has(id))
        );
      }
    },
    { immediate: true }
  );

  onScopeDispose(stopTicking);

  const findStream = (id: string) => vodStreams.value.find((s) => s.id === id);

  const registerPlayer = (id: string, video: HTMLVideoElement, state: VodPlayerState) => {
    videos.set(id, video);
    players[id] = { ...state };
    tick();
  };

  const updatePlayer = (id: string, patch: Partial<VodPlayerState>) => {
    const player = players[id];
    if (player) Object.assign(player, patch);
  };

  const unregisterPlayer = (id: string) => {
    videos.delete(id);
    delete players[id];
    delete phases[id];
  };

  /** Current media second of a loaded player, or null while it is loading or failed. */
  const mediaTimeOf = (id: string): number | null => {
    const video = videos.get(id);
    return video && players[id]?.status === "ready" ? video.currentTime : null;
  };

  /** Media second a freshly loaded player should start buffering from. */
  const initialMediaTime = (id: string): number => {
    const stream = findStream(id);
    if (!stream || !syncEnabled.value) return 0;
    if (!initialized) tick();
    return Math.max(0, mediaTarget(clockNow(), stream.vod.startedAt, offsetOf(id)));
  };

  const seek = (positionMs: number) => {
    const next = clampPosition(positionMs, timeline.value);
    setClock(next, false);
    position.value = next;
    tick();
  };

  const play = () => {
    const finished = !ranges.value.some((r) => r.isRecording);
    if (finished && timeline.value && clockNow() >= timeline.value.endMs - 1000) {
      setClock(timeline.value.startMs, false);
    }
    isPlaying.value = true;
    tick();
  };

  const pause = () => {
    isPlaying.value = false;
    setClock(clockNow(), false);
    tick();
  };

  const togglePlay = () => (isPlaying.value ? pause() : play());

  const seekBy = (deltaS: number) => seek(clockNow() + deltaS * 1000);

  /** Seek the shared clock so that `id` lands on media second `mediaS`. */
  const seekPlayer = (id: string, mediaS: number) => {
    const stream = findStream(id);
    if (!stream) return;
    seek(positionForMediaTime(mediaS, effectiveState(stream).startMs, offsetOf(id)));
  };

  const jumpToVod = (id: string) => seekPlayer(id, 0);

  /**
   * Skip `deltaS` seconds: the shared clock while synced, otherwise the VOD `targetId` (or the only
   * loaded VOD when there's just one). Returns false when there was nothing to skip.
   */
  const skip = (deltaS: number, targetId?: string | null): boolean => {
    if (!vodStreams.value.length) return false;
    if (syncEnabled.value) {
      seekBy(deltaS);
      return true;
    }
    const id =
      targetId && videos.has(targetId)
        ? targetId
        : videos.size === 1
          ? videos.keys().next().value
          : undefined;
    const video = id ? videos.get(id) : undefined;
    const player = id ? players[id] : undefined;
    if (!video || !player || player.status !== "ready") return false;
    const end = Number.isFinite(video.duration) ? video.duration : player.endS;
    video.currentTime = Math.min(Math.max(0, video.currentTime + deltaS), Math.max(0, end));
    return true;
  };

  const jumpToLatest = () => {
    const latest = latestPlayablePosition(ranges.value);
    if (latest === null) return;
    seek(latest);
    play();
  };

  const setSpeed = (next: number) => {
    if (next === speed.value || next <= 0) return;
    applySpeed(next);
    tick();
  };

  const stepSpeed = (direction: 1 | -1) => setSpeed(nextPlaybackSpeed(speed.value, direction));

  const canJumpToLatest = computed(() => ranges.value.some((r) => r.isRecording));

  const nudgeOffset = (id: string, direction: 1 | -1) => {
    const next = Math.round((offsetOf(id) + direction * OFFSET_STEP_S) * 10) / 10;
    offsets.value = { ...offsets.value, [id]: next };
    tick();
  };

  const resetOffset = (id: string) => {
    offsets.value = Object.fromEntries(Object.entries(offsets.value).filter(([key]) => key !== id));
    tick();
  };

  const setSyncEnabled = (enabled: boolean) => {
    if (enabled === syncEnabled.value) return;

    if (enabled) {
      // adopt the moment the first loaded VOD is showing, so turning sync on doesn't jump
      const anchor = vodStreams.value.find(
        (s) => videos.has(s.id) && players[s.id]?.status === "ready"
      );
      const video = anchor && videos.get(anchor.id);
      const state = anchor && players[anchor.id];
      if (anchor && video && state) {
        setClock(
          positionForMediaTime(video.currentTime, state.startMs, offsetOf(anchor.id)),
          false
        );
        isPlaying.value = !video.paused;
      }
    } else {
      videos.forEach((video) => (video.playbackRate = 1));
    }

    syncEnabled.value = enabled;
    tick();
  };

  return {
    vodStreams,
    syncEnabled,
    offsets,
    phases,
    players,
    position,
    ranges,
    timeline,
    isPlaying,
    isStalled,
    speed,
    canJumpToLatest,
    registerPlayer,
    updatePlayer,
    unregisterPlayer,
    initialMediaTime,
    mediaTimeOf,
    seek,
    seekBy,
    seekPlayer,
    skip,
    play,
    pause,
    togglePlay,
    jumpToVod,
    jumpToLatest,
    setSpeed,
    stepSpeed,
    nudgeOffset,
    resetOffset,
    setSyncEnabled,
    tick,
  };
};

export const useVodSync = createSharedComposable(_useVodSync);
