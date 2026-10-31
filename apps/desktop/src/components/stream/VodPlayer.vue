<script setup lang="ts">
import { ref, shallowRef, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { onClickOutside } from "@vueuse/core";
import Hls, {
  type HlsConfig,
  type LevelDetails,
  type LoaderCallbacks,
  type LoaderConfiguration,
  type LoaderContext,
  type PlaylistLoaderConstructor,
} from "hls.js";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "vue-i18n";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import {
  Play,
  Pause,
  Volume2,
  Volume1,
  VolumeX,
  Maximize,
  Minimize,
  Settings,
  Loader2,
  RotateCw,
  SkipForward,
  Clock,
} from "@lucide/vue";
import { PLATFORMS } from "@/config/platforms";
import { useVodSync } from "@/composables/useVodSync";
import { useStreams } from "@/composables/useStreams";
import { useNetworkStatus } from "@/composables/useNetworkStatus";
import { useFocusedStream } from "@/composables/useFocusedStream";
import { formatClock, formatSpan, stripEndlist, vodErrorKey, type Vod } from "@/lib/vod";
import { LIVE_EDGE_BUFFER_MS, PLAYBACK_SPEEDS, mediaTarget } from "@/lib/vodSync";
import { previewAt, type VodPreviews } from "@/lib/vodPreviews";
import { loadVodPreviews } from "@/composables/useVodPreviews";
import VodSeekBar from "./VodSeekBar.vue";

const props = defineProps<{
  streamId: string;
  vod: Vod;
  avatarUrl?: string | null;
  isFocused?: boolean;
}>();

const MAX_RETRIES = 3;
const KICK_STATUS_POLL_MS = 60_000;
const STALL_CHECK_MS = 1000;
const STALL_RECOVERY_MS = 6000;
const LIVE_EDGE_SLACK_S = 15;

const { t, locale } = useI18n();
const { isOnline } = useNetworkStatus();
const { updateVod } = useStreams();
const sync = useVodSync();
const { audioStreamId } = useFocusedStream();

const videoRef = ref<HTMLVideoElement | null>(null);
const containerRef = ref<HTMLDivElement | null>(null);
const settingsMenuRef = ref<HTMLDivElement | null>(null);

const isLoading = ref(true);
const isBuffering = ref(false);
const errorKey = ref("");
const errorDetails = ref("");
const isMuted = ref(true);
const volume = ref([50]);
const isFullscreen = ref(false);
const showControls = ref(true);
const settingsMenuOpen = ref(false);
const localPaused = ref(true);
const localSpeed = ref(1);
const currentTime = ref(0);
const scrubValue = ref<number | null>(null);
const startMs = ref(props.vod.startedAt);
const endS = ref(props.vod.durationSeconds);
const isRecording = ref(props.vod.isRecording);
const availableLevels = ref<{ height: number; label: string }[]>([]);
const currentLevelIndex = ref(-1);

let hls: Hls | null = null;
let retryCount = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let clickTimer: ReturnType<typeof setTimeout> | null = null;
let statusPoll: ReturnType<typeof setInterval> | null = null;
let stallTimer: ReturnType<typeof setInterval> | null = null;
let stalledSince = 0;
let stallRecoveries = 0;
let currentLoadId = 0;
let isDisposed = false;

onClickOutside(settingsMenuRef, () => {
  settingsMenuOpen.value = false;
});

const platform = computed(() => PLATFORMS[props.vod.platform]);
const isSynced = computed(() => sync.syncEnabled.value);
const isCompact = computed(() => !props.isFocused && !isFullscreen.value);
const isPlaying = computed(() => (isSynced.value ? sync.isPlaying.value : !localPaused.value));
const currentSpeed = computed(() => (isSynced.value ? sync.speed.value : localSpeed.value));
const speedLabel = (speed: number) => (speed === 1 ? t("vods.speed.normal") : `${speed}x`);
const phase = computed(() => sync.phases[props.streamId] ?? "loading");
const hasError = computed(() => !!errorKey.value);

const target = computed(() =>
  mediaTarget(sync.position.value, startMs.value, sync.offsets.value[props.streamId] ?? 0)
);

const overlay = computed(() => {
  if (!isSynced.value || isLoading.value || hasError.value) return null;
  if (phase.value === "before") {
    return { text: t("vods.player.startsIn", { time: formatSpan(-target.value) }), action: "jump" };
  }
  if (phase.value === "after") {
    return {
      text: t("vods.player.ended", { time: formatSpan(target.value - endS.value) }),
      action: "jump",
    };
  }
  if (phase.value === "waiting") return { text: t("vods.player.waiting"), action: "latest" };
  return null;
});

const seekValue = computed(() => Math.min(currentTime.value, endS.value));

const previews = shallowRef<VodPreviews | null>(null);

function loadPreviews() {
  loadVodPreviews(props.vod).then((loaded) => {
    if (!isDisposed) previews.value = loaded;
  });
}

// a recording only has frames up to what has been written so far
const previewFor = (seconds: number) =>
  previews.value
    ? previewAt(previews.value, seconds, isRecording.value ? endS.value : undefined)
    : null;

const wallClock = computed(() =>
  new Intl.DateTimeFormat(locale.value, { timeStyle: "medium" }).format(
    startMs.value + currentTime.value * 1000
  )
);

const startedLabel = computed(() =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(
    props.vod.startedAt
  )
);

const volumeIcon = computed(() => {
  const v = volume.value[0] ?? 0;
  if (isMuted.value || v === 0) return VolumeX;
  if (v < 50) return Volume1;
  return Volume2;
});

const currentQualityLabel = computed(() => {
  if (currentLevelIndex.value === -1) return t("nativePlayer.quality.auto");
  return availableLevels.value[currentLevelIndex.value]?.label || t("nativePlayer.quality.auto");
});

// Kick's in-progress VOD playlists carry #EXT-X-ENDLIST even while the broadcast is running.
// Dropping it makes hls.js treat the playlist as a growing EVENT stream and keep reloading it.
function createEndlistStrippingLoader(shouldStrip: () => boolean): PlaylistLoaderConstructor {
  const Base = Hls.DefaultConfig.loader;
  class EndlistStrippingLoader extends Base {
    load(
      context: LoaderContext,
      config: LoaderConfiguration,
      callbacks: LoaderCallbacks<LoaderContext>
    ) {
      super.load(context, config, {
        ...callbacks,
        onSuccess: (response, stats, ctx, networkDetails) => {
          if (shouldStrip() && typeof response.data === "string") {
            response.data = stripEndlist(response.data);
          }
          callbacks.onSuccess(response, stats, ctx, networkDetails);
        },
      });
    }
  }
  return EndlistStrippingLoader as PlaylistLoaderConstructor;
}

function buildLevelLabel(level: { height: number; attrs?: Record<string, string> }) {
  if (!level.height) return t("nativePlayer.quality.audio");
  const fps = level.attrs?.["FRAME-RATE"];
  const fpsNum = fps ? Math.round(parseFloat(fps)) : null;
  return `${level.height}p${fpsNum && fpsNum > 30 ? fpsNum : ""}`;
}

function setError(key: string, details = "") {
  errorKey.value = key;
  errorDetails.value = details;
  isLoading.value = false;
  sync.updatePlayer(props.streamId, { status: "error" });
}

function onLevelDetails(details: LevelDetails) {
  const first = details.fragments[0];
  // EXT-X-PROGRAM-DATE-TIME is the broadcaster's wall clock; it beats API timestamps by seconds
  if (first?.programDateTime) {
    startMs.value = first.programDateTime - first.start * 1000;
  }
  endS.value = details.edge;
  isRecording.value = details.live;
  isLoading.value = false;
  retryCount = 0;
  sync.updatePlayer(props.streamId, {
    status: "ready",
    startMs: startMs.value,
    endS: endS.value,
    isRecording: isRecording.value,
  });

  if (props.vod.isRecording && !details.live) {
    updateVod(props.streamId, { isRecording: false, durationSeconds: Math.round(details.edge) });
  }
}

function scheduleRetry() {
  if (isDisposed || !isOnline.value) return;
  if (retryCount >= MAX_RETRIES) {
    setError("vods.errors.playback");
    return;
  }
  retryCount++;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(
    () => {
      retryTimer = null;
      loadVod();
    },
    Math.min(1000 * 2 ** retryCount, 10_000)
  );
}

async function loadVod() {
  if (isDisposed) return;
  const loadId = ++currentLoadId;
  isLoading.value = true;
  errorKey.value = "";
  errorDetails.value = "";
  sync.updatePlayer(props.streamId, { status: "loading" });

  let url: string;
  try {
    url = await invoke<string>("vod_get_playback_url", {
      platform: props.vod.platform,
      id: props.vod.id,
    });
  } catch (err) {
    if (isDisposed || loadId !== currentLoadId) return;
    const key = vodErrorKey(err);
    if (key === "vods.errors.generic" && isOnline.value && retryCount < MAX_RETRIES) {
      scheduleRetry();
      return;
    }
    setError(key, String(err));
    return;
  }

  const video = videoRef.value;
  if (isDisposed || loadId !== currentLoadId || !video) return;

  hls?.destroy();
  hls = null;

  if (!Hls.isSupported()) {
    setError("vods.errors.unsupported");
    return;
  }

  const config: Partial<HlsConfig> = {
    enableWorker: true,
    startPosition: sync.initialMediaTime(props.streamId),
    capLevelToPlayerSize: true,
    maxBufferLength: 30,
    backBufferLength: 30,
  };
  if (props.vod.platform === "kick") {
    config.pLoader = createEndlistStrippingLoader(() => !!props.vod.isRecording);
  }

  const instance = new Hls(config);
  hls = instance;

  instance.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
    availableLevels.value = data.levels.map((l) => ({
      height: l.height,
      label: buildLevelLabel(l),
    }));
    currentLevelIndex.value = -1;
    if (!isSynced.value) video.play().catch(() => {});
  });
  instance.on(Hls.Events.LEVEL_LOADED, (_e, data) => onLevelDetails(data.details));
  instance.on(Hls.Events.LEVEL_UPDATED, (_e, data) => onLevelDetails(data.details));
  instance.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
    if (currentLevelIndex.value !== -1) currentLevelIndex.value = data.level;
  });

  let networkRetries = 0;
  instance.on(Hls.Events.FRAG_LOADED, () => {
    networkRetries = 0;
  });
  instance.on(Hls.Events.ERROR, (_e, data) => {
    if (isDisposed || !data.fatal) return;

    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      instance.recoverMediaError();
      return;
    }
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      if (!isOnline.value) return;
      // usher tokens expire; a fresh playback URL fixes 403s
      if (data.response?.code === 403) {
        scheduleRetry();
        return;
      }
      if (networkRetries < MAX_RETRIES) {
        networkRetries++;
        instance.startLoad();
        return;
      }
    }
    setError("vods.errors.playback", `${data.type}: ${data.details}`);
  });

  instance.loadSource(url);
  instance.attachMedia(video);
}

function retryLoad() {
  retryCount = 0;
  loadVod();
}

function togglePlay() {
  if (isSynced.value) {
    sync.togglePlay();
    return;
  }
  const video = videoRef.value;
  if (!video) return;
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

function seekTo(seconds: number) {
  if (isSynced.value) {
    sync.seekPlayer(props.streamId, seconds);
    return;
  }
  if (videoRef.value) videoRef.value.currentTime = seconds;
}

function onSeekCommit(seconds: number) {
  seekTo(seconds);
  // show the target right away; the next timeupdate only arrives once the new position decodes
  currentTime.value = seconds;
}

// relative skips go through the sync engine: the shared clock when synced, this video otherwise
function onSeekSkip(deltaSeconds: number) {
  if (sync.skip(deltaSeconds, props.streamId)) onTimeUpdate();
}

function jumpToLatest() {
  if (isSynced.value) {
    sync.jumpToLatest();
    return;
  }
  seekTo(Math.max(0, endS.value - LIVE_EDGE_BUFFER_MS / 1000));
  videoRef.value?.play().catch(() => {});
}

function onOverlayAction(action: string) {
  if (action === "latest") sync.jumpToLatest();
  else sync.jumpToVod(props.streamId);
}

function toggleMute() {
  const video = videoRef.value;
  if (!video) return;
  isMuted.value = !isMuted.value;
  video.muted = isMuted.value;
}

function setMuted(muted: boolean) {
  isMuted.value = muted;
  if (!muted && (volume.value[0] ?? 0) === 0) volume.value = [50];
  const video = videoRef.value;
  if (!video) return;
  video.volume = (volume.value[0] ?? 50) / 100;
  video.muted = muted;
}

// the tile with the audio plays unmuted; every other tile is muted
watch(
  audioStreamId,
  (id) => {
    if (id !== null) setMuted(id !== props.streamId);
  },
  { immediate: true }
);

function onVolumeChange(val: number[] | undefined) {
  if (!val) return;
  volume.value = val;
  const video = videoRef.value;
  if (!video) return;
  const v = val[0] ?? 0;
  video.volume = v / 100;
  isMuted.value = v === 0;
  video.muted = isMuted.value;
}

function setSpeed(next: number) {
  settingsMenuOpen.value = false;
  if (isSynced.value) {
    sync.setSpeed(next);
    return;
  }
  localSpeed.value = next;
  applyLocalSpeed();
}

// media loads reset playbackRate to its default, and the sync engine only drives it while synced
function applyLocalSpeed() {
  if (!isSynced.value && videoRef.value) videoRef.value.playbackRate = localSpeed.value;
}

function setQuality(index: number) {
  if (!hls) return;
  hls.currentLevel = index;
  currentLevelIndex.value = index;
  settingsMenuOpen.value = false;
}

// fullscreen the whole tile (the player's parent) so tile overlays such as chat come along
const fullscreenTarget = () => containerRef.value?.parentElement ?? containerRef.value;

async function toggleFullscreen() {
  const tile = fullscreenTarget();
  if (!tile) return;
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await tile.requestFullscreen();
  }
}

function onFullscreenChange() {
  const el = document.fullscreenElement;
  isFullscreen.value = !!el && (el === containerRef.value || el === fullscreenTarget());
}

function resetHideTimer() {
  if (hideTimer) clearTimeout(hideTimer);
  showControls.value = true;
  hideTimer = setTimeout(() => {
    if (!settingsMenuOpen.value && scrubValue.value === null) showControls.value = false;
  }, 2500);
}

function onMouseLeave() {
  if (hideTimer) clearTimeout(hideTimer);
  if (!settingsMenuOpen.value && scrubValue.value === null) showControls.value = false;
}

function handleVideoClick() {
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
    toggleFullscreen();
    return;
  }
  clickTimer = setTimeout(() => {
    clickTimer = null;
    togglePlay();
  }, 250);
}

function onTimeUpdate() {
  if (videoRef.value) currentTime.value = videoRef.value.currentTime;
}

function onWaiting() {
  isBuffering.value = true;
}

// keep the bar on the seek target instead of snapping back until the new position plays
function onSeeking() {
  onWaiting();
  if (videoRef.value) currentTime.value = videoRef.value.currentTime;
}

function onPlaying() {
  isBuffering.value = false;
  localPaused.value = false;
  stallRecoveries = 0;
}

function onPause() {
  localPaused.value = true;
}

function startStatusPolling() {
  if (statusPoll || props.vod.platform !== "kick") return;
  statusPoll = setInterval(async () => {
    try {
      const fresh = await invoke<Vod>("vod_get", { platform: "kick", id: props.vod.id });
      updateVod(props.streamId, {
        isRecording: fresh.isRecording,
        durationSeconds: fresh.durationSeconds,
      });
    } catch {
      // transient; the next poll retries
    }
  }, KICK_STATUS_POLL_MS);
}

function stopStatusPolling() {
  if (statusPoll) clearInterval(statusPoll);
  statusPoll = null;
}

// WebKit can drop SourceBuffer data that hls.js still tracks as buffered, leaving the element
// seeking forever (and holding the shared clock). Rebuilding the media pipeline recovers it.
function checkStall() {
  const video = videoRef.value;
  if (!video || !hls || isLoading.value || hasError.value || !isOnline.value) {
    stalledSince = 0;
    return;
  }
  const shouldPlay = isSynced.value ? phase.value === "active" : !video.paused;
  const starving = video.seeking || video.readyState < 3;
  const atEdge = isRecording.value
    ? video.currentTime >= endS.value - LIVE_EDGE_SLACK_S
    : video.currentTime >= endS.value - 1;
  if (!shouldPlay || !starving || atEdge) {
    stalledSince = 0;
    return;
  }

  const now = Date.now();
  if (!stalledSince) stalledSince = now;
  if (now - stalledSince < STALL_RECOVERY_MS) return;

  stalledSince = 0;
  stallRecoveries++;
  if (stallRecoveries <= 2) hls.recoverMediaError();
  else if (stallRecoveries === 3) retryLoad();
  else setError("vods.errors.playback");
}

watch(
  () => props.vod.isRecording,
  (recording) => (recording ? startStatusPolling() : stopStatusPolling()),
  { immediate: true }
);

watch(settingsMenuOpen, (open) => {
  if (!open) resetHideTimer();
});

watch(isSynced, (synced) => {
  if (synced) return;
  localSpeed.value = sync.speed.value;
  applyLocalSpeed();
});

watch(isOnline, (online) => {
  if (online && hasError.value) retryLoad();
});

function onStreamReloadEvent(e: Event) {
  const { detail } = e as CustomEvent<{ channelid?: string }>;
  if (!detail?.channelid || detail.channelid === props.streamId) retryLoad();
}

onMounted(() => {
  const video = videoRef.value;
  if (video) {
    video.volume = (volume.value[0] ?? 50) / 100;
    sync.registerPlayer(props.streamId, video, {
      status: "loading",
      startMs: props.vod.startedAt,
      endS: props.vod.durationSeconds,
      isRecording: props.vod.isRecording,
    });
  }
  loadVod();
  stallTimer = setInterval(checkStall, STALL_CHECK_MS);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  window.addEventListener("multistream-reload-stream", onStreamReloadEvent);
});

onBeforeUnmount(() => {
  isDisposed = true;
  if (retryTimer) clearTimeout(retryTimer);
  if (hideTimer) clearTimeout(hideTimer);
  if (clickTimer) clearTimeout(clickTimer);
  if (stallTimer) clearInterval(stallTimer);
  stopStatusPolling();
  sync.unregisterPlayer(props.streamId);
  hls?.destroy();
  hls = null;
  document.removeEventListener("fullscreenchange", onFullscreenChange);
  window.removeEventListener("multistream-reload-stream", onStreamReloadEvent);
});
</script>

<template>
  <div
    ref="containerRef"
    class="relative w-full h-full bg-black group select-none"
    :data-testid="`vod-player-${vod.id}`"
    @mousemove="resetHideTimer"
    @mouseleave="onMouseLeave"
  >
    <Skeleton v-if="isLoading && !hasError" class="absolute inset-0 bg-[#1e2127]" />

    <div
      v-if="hasError"
      class="absolute inset-0 flex flex-col items-center justify-center bg-[#0f1115] p-4 text-center z-10"
    >
      <p class="text-red-400 font-medium text-sm mb-1">{{ t(errorKey) }}</p>
      <p
        v-if="errorDetails"
        class="text-gray-400 text-xs font-mono max-w-xs break-words opacity-80"
      >
        {{ errorDetails }}
      </p>
      <button
        type="button"
        class="mt-3 px-3 py-1.5 text-xs font-medium rounded-md bg-[#1e2127] hover:bg-[#2a2d33] border border-[#2a2d33] text-zinc-300 hover:text-white transition-colors cursor-pointer flex items-center gap-1.5"
        @click="retryLoad"
      >
        <RotateCw class="size-3" aria-hidden="true" />
        {{ t("nativePlayer.retry") }}
      </button>
    </div>

    <!-- out-of-range overlay (synced mode) -->
    <div
      v-if="overlay"
      class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0f1115]/85 backdrop-blur-sm p-4 text-center z-10"
      :data-testid="`vod-overlay-${vod.id}`"
    >
      <img
        v-if="avatarUrl"
        :src="avatarUrl"
        :alt="vod.displayName"
        class="rounded-full object-cover ring-4 ring-white/5"
        :class="isCompact ? 'size-9' : 'size-12'"
      />
      <div>
        <p class="text-white font-semibold text-sm">{{ vod.displayName || vod.channel }}</p>
        <p class="text-gray-400 text-xs mt-0.5 tabular-nums">{{ overlay.text }}</p>
      </div>
      <button
        type="button"
        class="px-3 py-1.5 text-xs font-medium rounded-md bg-[#1e2127] hover:bg-[#2a2d33] border border-[#2a2d33] text-zinc-300 hover:text-white transition-colors cursor-pointer flex items-center gap-1.5"
        @click="onOverlayAction(overlay.action)"
      >
        <SkipForward class="size-3" aria-hidden="true" />
        {{
          overlay.action === "latest" ? t("vods.player.jumpToLatest") : t("vods.player.jumpHere")
        }}
      </button>
    </div>

    <div
      v-if="isBuffering && !isLoading && !hasError && !overlay"
      class="absolute inset-0 flex items-center justify-center pointer-events-none z-10"
    >
      <Loader2 class="size-8 text-white animate-spin opacity-75" aria-hidden="true" />
    </div>

    <video
      ref="videoRef"
      class="w-full h-full object-contain cursor-pointer"
      :class="{ 'opacity-0': isLoading }"
      playsinline
      :muted="isMuted"
      @timeupdate="onTimeUpdate"
      @waiting="onWaiting"
      @seeking="onSeeking"
      @play="localPaused = false"
      @loadedmetadata="applyLocalSpeed"
      @playing="onPlaying"
      @seeked="isBuffering = false"
      @canplay="isBuffering = false"
      @pause="onPause"
      @click="handleVideoClick"
    />

    <Transition name="hud-fade">
      <div
        v-show="showControls && !isLoading && !hasError"
        class="absolute inset-0 pointer-events-none z-20"
      >
        <!-- top: channel + broadcast info -->
        <div
          class="absolute top-0 left-0 right-0 bg-linear-to-b from-black/70 to-transparent px-3 pt-3 pb-8"
        >
          <div class="flex items-center gap-2.5">
            <img
              v-if="avatarUrl"
              :src="avatarUrl"
              :alt="vod.channel"
              class="size-8 rounded-full object-cover ring-1 ring-white/10 shrink-0"
            />
            <div class="min-w-0 flex flex-col justify-center">
              <div class="flex items-center gap-2">
                <p class="text-white text-sm font-semibold leading-tight truncate">
                  {{ vod.displayName || vod.channel }}
                </p>
                <span
                  class="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-black/40 uppercase tracking-wider"
                  :style="{ color: platform.color }"
                  >{{ t("vods.badge") }}</span
                >
                <span
                  v-if="isRecording"
                  class="flex items-center gap-1 text-[10px] text-rose-400 font-bold bg-black/40 px-1.5 py-0.5 rounded-md uppercase tracking-wider"
                >
                  <span class="size-1.5 rounded-full bg-rose-500 animate-pulse" />
                  {{ t("vods.recording") }}
                </span>
              </div>
              <p class="text-gray-400 text-xs leading-tight truncate max-w-75 mt-0.5">
                {{ startedLabel }}<template v-if="vod.title"> · {{ vod.title }}</template>
              </p>
            </div>
          </div>
        </div>

        <!-- bottom: seek bar + controls -->
        <div
          class="absolute bottom-0 left-0 right-0 bg-linear-to-t from-black/80 to-transparent pt-8 pb-2 pointer-events-auto"
          :class="isCompact ? 'px-2' : 'px-3'"
        >
          <VodSeekBar
            :value="seekValue"
            :max="endS"
            :label="t('vods.seek')"
            :compact="isCompact"
            :preview-for="previewFor"
            class="mb-1.5"
            :data-testid="`vod-seek-${vod.id}`"
            @hover="loadPreviews"
            @scrub="(s) => (scrubValue = s)"
            @commit="onSeekCommit"
            @skip="onSeekSkip"
          />
          <div class="flex items-center" :class="isCompact ? 'gap-1.5' : 'gap-2'">
            <button
              type="button"
              class="text-white/90 hover:text-white transition-colors cursor-pointer p-1"
              :aria-label="isPlaying ? t('common.pause') : t('common.play')"
              @click="togglePlay"
            >
              <Pause v-if="isPlaying" :class="isCompact ? 'size-4.5' : 'size-5'" />
              <Play v-else :class="isCompact ? 'size-4.5' : 'size-5'" />
            </button>

            <button
              type="button"
              class="text-white/90 hover:text-white transition-colors cursor-pointer p-1"
              :aria-label="isMuted ? t('common.unmute') : t('common.mute')"
              @click="toggleMute"
            >
              <component :is="volumeIcon" :class="isCompact ? 'size-4.5' : 'size-5'" />
            </button>
            <Slider
              :model-value="isMuted ? [0] : volume"
              :max="100"
              :step="1"
              :class="isCompact ? 'w-12' : 'w-20'"
              :aria-label="t('common.volume')"
              @update:model-value="onVolumeChange"
            />

            <span
              class="text-white/80 tabular-nums whitespace-nowrap"
              :class="isCompact ? 'text-[10px]' : 'text-xs'"
            >
              {{ formatClock(scrubValue ?? currentTime) }} / {{ formatClock(endS) }}
            </span>
            <span
              v-if="currentSpeed !== 1"
              class="px-1 py-0.5 rounded bg-white/10 text-white/90 font-semibold tabular-nums"
              :class="isCompact ? 'text-[9px]' : 'text-[10px]'"
              :data-testid="`vod-speed-badge-${vod.id}`"
              >{{ currentSpeed }}x</span
            >
            <span
              v-if="!isCompact"
              class="hidden sm:flex items-center gap-1 text-[11px] text-gray-400 tabular-nums"
              :title="t('vods.player.wallClock')"
            >
              <Clock class="size-3" aria-hidden="true" />
              {{ wallClock }}
            </span>

            <button
              v-if="isRecording"
              type="button"
              class="flex items-center rounded font-bold uppercase tracking-wider cursor-pointer ml-auto transition-colors text-gray-200 bg-white/10 hover:bg-red-600/80 hover:text-white"
              :class="
                isCompact ? 'gap-0.5 px-1 py-0.5 text-[9px]' : 'gap-1 px-1.5 py-0.5 text-[10px]'
              "
              @click="jumpToLatest"
            >
              <span class="size-1.5 rounded-full bg-red-500" />
              {{ t("vods.player.jumpToLatest") }}
            </button>

            <div ref="settingsMenuRef" class="relative" :class="{ 'ml-auto': !isRecording }">
              <button
                type="button"
                class="text-white/90 hover:text-white transition-colors cursor-pointer p-1 flex items-center gap-1"
                :aria-label="t('common.settings')"
                @click="settingsMenuOpen = !settingsMenuOpen"
              >
                <Settings class="size-4" />
                <span v-if="!isCompact" class="text-gray-300 text-xs">{{
                  currentQualityLabel
                }}</span>
              </button>
              <Transition name="hud-fade">
                <div
                  v-if="settingsMenuOpen"
                  class="absolute bottom-full right-0 mb-2 bg-[#1a1c20]/95 backdrop-blur-md border border-white/10 rounded-lg py-1 shadow-xl flex max-h-60 overflow-y-auto"
                >
                  <div class="min-w-24" role="group" :aria-label="t('vods.speed.title')">
                    <p class="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wider text-gray-500">
                      {{ t("vods.player.speed") }}
                    </p>
                    <button
                      v-for="speed in PLAYBACK_SPEEDS"
                      :key="speed"
                      type="button"
                      class="w-full text-left px-3 py-1.5 text-xs cursor-pointer transition-colors tabular-nums"
                      :class="
                        currentSpeed === speed
                          ? 'text-white bg-white/10'
                          : 'text-gray-300 hover:bg-white/5 hover:text-white'
                      "
                      :data-testid="`vod-speed-${speed}`"
                      @click="setSpeed(speed)"
                    >
                      {{ speedLabel(speed) }}
                    </button>
                  </div>
                  <div
                    class="min-w-24 border-l border-white/10"
                    role="group"
                    :aria-label="t('vods.player.quality')"
                  >
                    <p class="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wider text-gray-500">
                      {{ t("vods.player.quality") }}
                    </p>
                    <button
                      type="button"
                      class="w-full text-left px-3 py-1.5 text-xs cursor-pointer transition-colors"
                      :class="
                        currentLevelIndex === -1
                          ? 'text-white bg-white/10'
                          : 'text-gray-300 hover:bg-white/5 hover:text-white'
                      "
                      @click="setQuality(-1)"
                    >
                      {{ t("nativePlayer.quality.auto") }}
                    </button>
                    <button
                      v-for="(level, idx) in availableLevels"
                      :key="idx"
                      type="button"
                      class="w-full text-left px-3 py-1.5 text-xs cursor-pointer transition-colors"
                      :class="
                        currentLevelIndex === idx
                          ? 'text-white bg-white/10'
                          : 'text-gray-300 hover:bg-white/5 hover:text-white'
                      "
                      @click="setQuality(idx)"
                    >
                      {{ level.label }}
                    </button>
                  </div>
                </div>
              </Transition>
            </div>

            <button
              type="button"
              class="text-white/90 hover:text-white transition-colors cursor-pointer p-1"
              :aria-label="isFullscreen ? t('common.exitFullscreen') : t('common.fullscreen')"
              @click="toggleFullscreen"
            >
              <Minimize v-if="isFullscreen" :class="isCompact ? 'size-4.5' : 'size-5'" />
              <Maximize v-else :class="isCompact ? 'size-4.5' : 'size-5'" />
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.hud-fade-enter-active,
.hud-fade-leave-active {
  transition: opacity 0.25s ease;
}
.hud-fade-enter-from,
.hud-fade-leave-to {
  opacity: 0;
}
</style>
