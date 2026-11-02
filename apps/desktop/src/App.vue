<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onUnmounted, defineAsyncComponent } from "vue";
import { Menu, X, WifiOff } from "@lucide/vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useStreams, type Platform } from "./composables/useStreams";
import { usePreferences } from "./composables/usePreferences";
import { useUpdater, isTauri } from "./composables/useUpdater";
import { useLiveStatus } from "./composables/useLiveStatus";
import { useMediaCodecs } from "./composables/useMediaCodecs";
import { useRecording } from "./composables/useRecording";
import { useDeepLink } from "./composables/useDeepLink";
import { useNetworkStatus } from "./composables/useNetworkStatus";
import { useImmersiveMode } from "./composables/useImmersiveMode";
import { useVodSync } from "./composables/useVodSync";
import { useFocusedStream } from "./composables/useFocusedStream";
import { useFullscreenLayout } from "./composables/useFullscreenLayout";
import { useIdleCursor } from "./composables/useIdleCursor";
import ToastProvider from "./components/ui/toast/ToastProvider.vue";
import FollowedChannelsSidebar from "./components/main/FollowedChannelsSidebar.vue";
import SidebarPanel from "./components/main/SidebarPanel.vue";
import StreamGrid from "./components/main/StreamGrid.vue";
import EmptyState from "./components/main/EmptyState.vue";
import OnboardingTour from "./components/dialogs/OnboardingTour.vue";
import TwitchAuthDialog from "./components/dialogs/TwitchAuthDialog.vue";
import KickAuthDialog from "./components/dialogs/KickAuthDialog.vue";
import ChangelogDialog from "./components/dialogs/ChangelogDialog.vue";
import FullscreenLayoutBar from "./components/main/FullscreenLayoutBar.vue";

import { toast } from "@/composables/useToast";
import { useI18n } from "vue-i18n";
import { parseUrlOptions } from "./lib/parseUrlOptions";
import { resolveStream } from "./lib/streamResolver";
import { APP_LINKS } from "./config/links";
import { isVodPlatform, type VodPlatform } from "./lib/vod";

const VodSyncBar = defineAsyncComponent(() => import("./components/main/VodSyncBar.vue"));
const AddDialog = defineAsyncComponent(() => import("./components/dialogs/AddDialog.vue"));
const ShareDialog = defineAsyncComponent(() => import("./components/dialogs/ShareDialog.vue"));
const ImportDialog = defineAsyncComponent(() => import("./components/dialogs/ImportDialog.vue"));
const VodDialog = defineAsyncComponent(() => import("./components/dialogs/VodDialog.vue"));
const SettingsDialog = defineAsyncComponent(
  () => import("./components/dialogs/SettingsDialog.vue")
);

const showOnboarding = ref(false);
const dismissedWebBanner = ref(false);
const showTwitchAuth = ref(false);
const showKickAuth = ref(false);
const showChangelog = ref(false);

const hasOpenedOnboarding = ref(false);
const hasOpenedTwitchAuth = ref(false);
const hasOpenedKickAuth = ref(false);
const hasOpenedChangelog = ref(false);

watch(
  showOnboarding,
  (val) => {
    if (val) hasOpenedOnboarding.value = true;
  },
  { immediate: true }
);
watch(
  showTwitchAuth,
  (val) => {
    if (val) hasOpenedTwitchAuth.value = true;
  },
  { immediate: true }
);
watch(
  showKickAuth,
  (val) => {
    if (val) hasOpenedKickAuth.value = true;
  },
  { immediate: true }
);
watch(
  showChangelog,
  (val) => {
    if (val) hasOpenedChangelog.value = true;
  },
  { immediate: true }
);

// toolbar dialogs mount on first open and stay mounted so reopening is instant
const addDialogOpen = ref(false);
const shareDialogOpen = ref(false);
const importDialogOpen = ref(false);
const settingsDialogOpen = ref(false);
const vodDialogOpen = ref(false);
const vodDialogTarget = ref<{ platform: VodPlatform; channel: string } | null>(null);
const hasOpened = reactive({
  add: false,
  share: false,
  import: false,
  settings: false,
  vods: false,
});

watch(addDialogOpen, (v) => {
  if (v) hasOpened.add = true;
});
watch(shareDialogOpen, (v) => {
  if (v) hasOpened.share = true;
});
watch(importDialogOpen, (v) => {
  if (v) hasOpened.import = true;
});
watch(settingsDialogOpen, (v) => {
  if (v) hasOpened.settings = true;
});
watch(vodDialogOpen, (v) => {
  if (v) hasOpened.vods = true;
});

function handleOpenVodsEvent(e: Event) {
  const detail = (e as CustomEvent<{ platform?: string; channel?: string } | null>).detail;
  const platform = detail?.platform;
  vodDialogTarget.value =
    platform && detail.channel && isVodPlatform(platform)
      ? { platform, channel: detail.channel }
      : null;
  vodDialogOpen.value = true;
}

const { streams, addStream, clearStreams } = useStreams();
const {
  sidebarOpen,
  setSelectedChat,
  onboardingCompleted,
  setOnboardingCompleted,
  pendingChangelogVersion,
  setPendingChangelogVersion,
  vodSkipForwardSeconds,
  vodSkipBackSeconds,
} = usePreferences();
const { skip: skipVods, vodStreams } = useVodSync();
// the shared timeline only earns its space once there's more than one VOD to line up
const showVodSyncBar = computed(() => vodStreams.value.length > 1);
const { audioStreamId, focusedStreamId } = useFocusedStream();
const layout = useFullscreenLayout();
useIdleCursor();
const { checkForUpdates } = useUpdater();
const { refreshSuggestions, startPolling } = useLiveStatus();
const { checkVideoCodecs } = useMediaCodecs();
const { checkDependencies } = useRecording();
const { locale, t } = useI18n();
const { isOnline, onReconnect } = useNetworkStatus();
const {
  immersiveModeEnabled,
  isLeftPanelRevealed,
  isRightPanelRevealed,
  revealLeftPanel,
  revealRightPanel,
  toggleFullscreen,
  handleEscape,
} = useImmersiveMode();

function isModalDialogOpen(): boolean {
  return (
    showOnboarding.value ||
    showTwitchAuth.value ||
    showKickAuth.value ||
    showChangelog.value ||
    Boolean(document.querySelector('[role="dialog"]'))
  );
}

onReconnect(() => {
  toast.success(t("network.reconnected"), { id: "network-reconnected", duration: 3000 });
});

useDeepLink();

function handleGlobalKeyDown(e: KeyboardEvent) {
  if (showOnboarding.value) return;

  const target = e.target as HTMLElement;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
    return;
  }

  // F11: toggle fullscreen (or leave the PiP layout)
  if (e.key === "F11") {
    e.preventDefault();
    if (layout.isActive.value) layout.exit();
    else toggleFullscreen();
    return;
  }

  // Escape: leave the PiP layout / exit immersive mode / auto-hide revealed panels if no modal dialog is open
  if (e.key === "Escape") {
    if (!isModalDialogOpen()) {
      if (layout.isActive.value) layout.exit();
      else handleEscape();
      return;
    }
  }

  // Right / Left: skip VODs forward / back by the amounts set in Settings
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || isModalDialogOpen()) return;
    if (target.closest?.('[role="slider"], [role="menu"], [role="listbox"], [role="tablist"]')) {
      return;
    }
    const seconds =
      e.key === "ArrowRight" ? vodSkipForwardSeconds.value : -vodSkipBackSeconds.value;
    if (skipVods(seconds, audioStreamId.value ?? focusedStreamId.value)) e.preventDefault();
    return;
  }

  const num = parseInt(e.key, 10);
  if (num >= 1 && num <= 9) {
    const stream = streams.value[num - 1];
    if (stream) {
      setSelectedChat(`${stream.platform}:${stream.channel}`);
    }
    return;
  }

  // S: screenshot focused stream
  if (e.key.toLowerCase() === "s") {
    window.dispatchEvent(new CustomEvent("multistream-screenshot"));
    return;
  }

  // D: open add stream dialog
  if (e.key.toLowerCase() === "d") {
    window.dispatchEvent(
      new CustomEvent("multistream-show-dialog", {
        detail: "add-stream",
      })
    );
  }
}

function handleFrameShortcuts(e: MessageEvent) {
  if (e.data?.type !== "SHORTCUT" || showOnboarding.value) return;

  if (e.data?.key === "F11") {
    if (layout.isActive.value) layout.exit();
    else toggleFullscreen();
    return;
  }

  if (e.data?.key === "Escape") {
    if (!isModalDialogOpen()) {
      if (layout.isActive.value) layout.exit();
      else handleEscape();
      return;
    }
  }

  // 1-9: quick select chat
  const num = parseInt(e.data.key, 10);
  if (num >= 1 && num <= 9) {
    const stream = streams.value[num - 1];
    if (stream) {
      setSelectedChat(`${stream.platform}:${stream.channel}`);
    }
    return;
  }

  // S: screenshot focused stream
  if (e.data?.key?.toLowerCase() === "s") {
    window.dispatchEvent(new CustomEvent("multistream-screenshot"));
    return;
  }

  // D: open add stream dialog
  if (e.data?.key?.toLowerCase() === "d") {
    window.dispatchEvent(
      new CustomEvent("multistream-show-dialog", {
        detail: "add-stream",
      })
    );
  }
}

watch(immersiveModeEnabled, (enabled) => {
  if (enabled) {
    toast.info(t("preferences.immersive.toastEnabled"), {
      id: "immersive-mode-toast",
      duration: 3500,
    });
  }
});

watch(streams, (newStreams) => {
  if (newStreams.length === 0) {
    refreshSuggestions();
  }
});

watch(locale, () => {
  if (streams.value.length === 0) {
    refreshSuggestions();
  }
});

function handleDialogShowEvent(e: Event) {
  const evt = e as CustomEvent;
  if (evt.detail === "onboarding-tour") {
    showOnboarding.value = true;
  } else if (evt.detail === "twitch-auth") {
    showTwitchAuth.value = true;
  } else if (evt.detail === "kick-auth") {
    showKickAuth.value = true;
  } else if (evt.detail === "changelog") {
    showChangelog.value = true;
  } else if (evt.detail === "add-stream") {
    addDialogOpen.value = true;
  } else if (evt.detail === "settings") {
    settingsDialogOpen.value = true;
  } else if (evt.detail === "share") {
    shareDialogOpen.value = true;
  } else if (evt.detail === "import") {
    importDialogOpen.value = true;
  }
}

let unlistenWatch: UnlistenFn | null = null;

onMounted(async () => {
  window.addEventListener("keydown", handleGlobalKeyDown);
  window.addEventListener("message", handleFrameShortcuts);
  window.addEventListener("multistream-show-dialog", handleDialogShowEvent);
  window.addEventListener("multistream-open-vods", handleOpenVodsEvent);

  if (isTauri()) {
    invoke("stop_all_recordings_on_reload").catch(() => {});
    try {
      unlistenWatch = await listen<{ channel: string; platform: Platform }>(
        "notification-watch",
        async (event) => {
          const { channel, platform } = event.payload;
          if (platform === "youtube") {
            const resolved = await resolveStream({ channel, platform });
            if (resolved) {
              addStream(
                resolved.channel,
                resolved.platform,
                resolved.iframeUrl,
                resolved.displayName,
                resolved.handle
              );
              return;
            }
          }
          addStream(channel, platform);
        }
      );
    } catch (e) {
      console.warn("Failed to register notification listener:", e);
    }
  }

  if (!onboardingCompleted.value) {
    if (pendingChangelogVersion.value) {
      setPendingChangelogVersion("");
    }
    showOnboarding.value = true;
  } else if (pendingChangelogVersion.value) {
    const normalizedPending = pendingChangelogVersion.value.replace(/^v/, "").trim();
    const normalizedCurrent = (import.meta.env.VITE_APP_VERSION || "").replace(/^v/, "").trim();
    setPendingChangelogVersion("");
    if (!normalizedCurrent || normalizedPending === normalizedCurrent) {
      showChangelog.value = true;
    }
  }

  // check for updates on startup
  checkForUpdates();
  checkVideoCodecs();
  checkDependencies();

  // start polling favorites live status (every 30s)
  startPolling();

  // check for streams on startup
  try {
    const parsedStreams = parseUrlOptions(window.location.search);

    if (parsedStreams === null) {
      if (streams.value.length === 0) {
        refreshSuggestions();
      }
    } else {
      clearStreams();
      for (const s of parsedStreams) {
        const resolved = await resolveStream(s);
        if (resolved) {
          addStream(
            resolved.channel,
            resolved.platform,
            resolved.iframeUrl,
            resolved.displayName,
            resolved.handle
          );
        } else if (s.platform === "youtube") {
          toast.error(t("toasts.youtube.offline"));
        }
      }
      window.history.replaceState({}, "", window.location.pathname);
    }
  } catch {
    toast.error(t("import.invalidCustom"));
    window.history.replaceState({}, "", window.location.pathname);
  }
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleGlobalKeyDown);
  window.removeEventListener("message", handleFrameShortcuts);
  window.removeEventListener("multistream-show-dialog", handleDialogShowEvent);
  window.removeEventListener("multistream-open-vods", handleOpenVodsEvent);

  if (unlistenWatch) {
    unlistenWatch();
  }
});
</script>

<template>
  <div class="flex h-screen overflow-hidden bg-[#191b1f]">
    <!-- offline banner -->
    <Transition
      enter-active-class="transition duration-300 ease-out"
      enter-from-class="opacity-0 -translate-y-2 scale-95"
      enter-to-class="opacity-100 translate-y-0 scale-100"
      leave-active-class="transition duration-200 ease-in"
      leave-from-class="opacity-100 translate-y-0 scale-100"
      leave-to-class="opacity-0 -translate-y-2 scale-95"
    >
      <div
        v-if="!isOnline"
        data-testid="network-offline-banner"
        class="fixed top-3 left-1/2 -translate-x-1/2 z-50 pointer-events-none flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#14161a]/95 border border-[#2a2d33] text-xs shadow-xl shadow-black/50 backdrop-blur-md select-none"
      >
        <WifiOff class="size-3.5 text-zinc-400 shrink-0" />
        <span class="text-zinc-200 font-medium">{{ $t("network.offline") }}</span>
        <span class="text-zinc-500 font-normal">({{ $t("network.reconnecting") }})</span>
      </div>
    </Transition>

    <!-- left sidebar -->
    <FollowedChannelsSidebar />

    <div class="flex flex-col flex-1 overflow-hidden relative">
      <div
        v-if="!isTauri() && !dismissedWebBanner"
        class="w-full flex items-center justify-center gap-4 px-4 py-2 bg-[#14161a] border-b border-[#2a2d33] shrink-0 animate-in fade-in slide-in-from-top-2 duration-300"
      >
        <span class="text-[13px] text-[#e0e0e0] whitespace-nowrap">{{
          $t("webBanner.title")
        }}</span>
        <div class="flex items-center gap-3 border-l border-[#2a2d33] pl-3">
          <a
            :href="APP_LINKS.github.releases"
            target="_blank"
            class="text-[13px] font-medium text-white hover:text-gray-300 transition-colors"
            >{{ $t("webBanner.button") }}</a
          >
          <button
            :aria-label="$t('common.close')"
            class="text-[#787774] hover:text-white transition-colors flex items-center justify-center cursor-pointer"
            @click="dismissedWebBanner = true"
          >
            <X class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <!-- main -->
      <main class="flex-1 flex flex-col overflow-hidden bg-[#1f2227]">
        <div class="flex-1 min-h-0 overflow-y-auto">
          <!-- stream grid -->
          <StreamGrid v-if="streams.length > 0" />

          <EmptyState v-else @add="addDialogOpen = true" @tour="showOnboarding = true" />
        </div>

        <!-- shared timeline for past broadcasts -->
        <VodSyncBar v-if="showVodSyncBar" />
      </main>
    </div>

    <!-- sidebar -->
    <SidebarPanel />

    <!-- edge hover trigger zones for immersive mode -->
    <div
      v-if="immersiveModeEnabled && !isLeftPanelRevealed && !layout.isActive.value"
      data-testid="immersive-left-trigger"
      class="fixed inset-y-0 left-0 w-3.5 z-40 pointer-events-auto"
      @mouseenter="revealLeftPanel"
    />
    <div
      v-if="immersiveModeEnabled && !isRightPanelRevealed && !layout.isActive.value"
      data-testid="immersive-right-trigger"
      class="fixed inset-y-0 right-0 w-3.5 z-40 pointer-events-auto"
      @mouseenter="revealRightPanel"
    />

    <!-- toggle button -->
    <button
      v-if="!sidebarOpen && !immersiveModeEnabled"
      :aria-label="$t('sidebar.openSidebar')"
      class="fixed right-0 top-5/12 -translate-y-1/2 flex items-center justify-center w-8 py-6 bg-[#14161a] border border-r-0 border-[#2a2d33] rounded-l-lg shadow-xl shadow-black/30 cursor-pointer transition-all duration-300 hover:w-8 hover:bg-[#1c1f24] hover:border-[#3a3f4b] hover:shadow-black/50 group animate-in fade-in slide-in-from-right-2"
      @click="sidebarOpen = true"
    >
      <Menu class="size-4 text-gray-400 group-hover:text-white transition-colors duration-200" />
    </button>

    <!-- fullscreen with picture-in-picture: pick overlays / leave -->
    <FullscreenLayoutBar v-if="layout.isActive.value" />

    <ToastProvider />

    <!-- onboarding tour -->
    <OnboardingTour
      v-if="hasOpenedOnboarding"
      v-model:open="showOnboarding"
      :allow-outside-close="onboardingCompleted"
      @complete="setOnboardingCompleted(true)"
    />

    <TwitchAuthDialog v-if="hasOpenedTwitchAuth" v-model:open="showTwitchAuth" />
    <KickAuthDialog v-if="hasOpenedKickAuth" v-model:open="showKickAuth" />
    <ChangelogDialog v-if="hasOpenedChangelog" v-model:open="showChangelog" />

    <AddDialog v-if="hasOpened.add" v-model:open="addDialogOpen" />
    <ShareDialog v-if="hasOpened.share" v-model:open="shareDialogOpen" />
    <ImportDialog v-if="hasOpened.import" v-model:open="importDialogOpen" />
    <SettingsDialog v-if="hasOpened.settings" v-model:open="settingsDialogOpen" />
    <VodDialog v-if="hasOpened.vods" v-model:open="vodDialogOpen" :target="vodDialogTarget" />
  </div>
</template>
