import { createSharedComposable, useStorage } from "@vueuse/core";

export interface Preferences {
  selectedChat: string;
  sidebarOpen: boolean;
  followedSidebarOpen: boolean;
  followedOfflineOpen: boolean;
  notificationsEnabled: boolean;
  onboardingCompleted: boolean;
  pendingChangelogVersion: string;

  recordingQuality: string;
  recordingPath: string;
  nativePlayerEnabled: boolean;
  adblockEnabled: boolean;
  immersiveModeEnabled: boolean;

  vodSkipForwardSeconds: number;
  vodSkipBackSeconds: number;
  chatOverlayStreamIds: string[];
}

export const MIN_SKIP_SECONDS = 1;
export const MAX_SKIP_SECONDS = 600;

/** Whole seconds within the allowed skip range; anything unusable falls back to `fallback`. */
export function normalizeSkipSeconds(value: unknown, fallback: number): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(MAX_SKIP_SECONDS, Math.max(MIN_SKIP_SECONDS, Math.round(n)));
}

const defaultPreferences: Preferences = {
  selectedChat: "",
  sidebarOpen: true,
  followedSidebarOpen: false,
  followedOfflineOpen: true,
  notificationsEnabled: true,
  onboardingCompleted: false,
  pendingChangelogVersion: "",

  recordingQuality: "best",
  recordingPath: "",
  nativePlayerEnabled: false,
  adblockEnabled: true,
  immersiveModeEnabled: false,

  vodSkipForwardSeconds: 10,
  vodSkipBackSeconds: 5,
  chatOverlayStreamIds: [],
};

const _usePreferences = () => {
  /**
   * @brief Selected chat
   */
  const selectedChat = useStorage<string>(
    "preferences.selectedChat",
    defaultPreferences.selectedChat
  );

  /**
   * @brief Sidebar open state
   */
  const sidebarOpen = useStorage<boolean>(
    "preferences.sidebarOpen",
    defaultPreferences.sidebarOpen
  );

  /**
   * @brief Followed channels sidebar open state
   */
  const followedSidebarOpen = useStorage<boolean>(
    "preferences.followedSidebarOpen",
    defaultPreferences.followedSidebarOpen
  );

  /**
   * @brief Offline followed channels section expanded in the left sidebar
   */
  const followedOfflineOpen = useStorage<boolean>(
    "preferences.followedOfflineOpen",
    defaultPreferences.followedOfflineOpen
  );

  /**
   * @brief Notifications enabled
   */
  const notificationsEnabled = useStorage<boolean>(
    "preferences.notificationsEnabled",
    defaultPreferences.notificationsEnabled
  );

  /**
   * @brief Onboarding completed state
   */
  const onboardingCompleted = useStorage<boolean>(
    "preferences.onboardingCompleted",
    defaultPreferences.onboardingCompleted
  );

  const pendingChangelogVersion = useStorage<string>(
    "preferences.pendingChangelogVersion",
    defaultPreferences.pendingChangelogVersion
  );

  const recordingQuality = useStorage<string>(
    "preferences.recordingQuality",
    defaultPreferences.recordingQuality
  );

  const recordingPath = useStorage<string>(
    "preferences.recordingPath",
    defaultPreferences.recordingPath
  );

  const nativePlayerEnabled = useStorage<boolean>(
    "preferences.nativePlayerEnabled",
    defaultPreferences.nativePlayerEnabled
  );

  const adblockEnabled = useStorage<boolean>(
    "preferences.adblockEnabled",
    defaultPreferences.adblockEnabled
  );

  const immersiveModeEnabled = useStorage<boolean>(
    "preferences.immersiveModeEnabled",
    defaultPreferences.immersiveModeEnabled
  );

  /**
   * @brief Seconds the Right / Left arrow keys skip VODs forward / back
   */
  const vodSkipForwardSeconds = useStorage<number>(
    "preferences.vodSkipForwardSeconds",
    defaultPreferences.vodSkipForwardSeconds
  );
  const vodSkipBackSeconds = useStorage<number>(
    "preferences.vodSkipBackSeconds",
    defaultPreferences.vodSkipBackSeconds
  );

  /**
   * @brief Stream ids whose tile shows a chat overlay
   */
  const chatOverlayStreamIds = useStorage<string[]>("preferences.chatOverlayStreamIds", [
    ...defaultPreferences.chatOverlayStreamIds,
  ]);

  /**
   * @brief Set the selected chat
   *
   * @param chatId The chat ID
   * @return void
   */
  const setSelectedChat = (chatId: string) => {
    selectedChat.value = chatId;
  };

  const setRecordingQuality = (quality: string) => {
    recordingQuality.value = quality;
  };

  const setRecordingPath = (path: string) => {
    recordingPath.value = path;
  };

  const setAdblockEnabled = (enabled: boolean) => {
    adblockEnabled.value = enabled;
  };

  const setImmersiveModeEnabled = (enabled: boolean) => {
    immersiveModeEnabled.value = enabled;
  };

  const toggleImmersiveMode = () => {
    immersiveModeEnabled.value = !immersiveModeEnabled.value;
  };

  const setVodSkipForwardSeconds = (seconds: unknown) => {
    vodSkipForwardSeconds.value = normalizeSkipSeconds(
      seconds,
      defaultPreferences.vodSkipForwardSeconds
    );
  };

  const setVodSkipBackSeconds = (seconds: unknown) => {
    vodSkipBackSeconds.value = normalizeSkipSeconds(seconds, defaultPreferences.vodSkipBackSeconds);
  };

  const isChatOverlayOn = (streamId: string) => chatOverlayStreamIds.value.includes(streamId);

  const toggleChatOverlay = (streamId: string) => {
    chatOverlayStreamIds.value = isChatOverlayOn(streamId)
      ? chatOverlayStreamIds.value.filter((id) => id !== streamId)
      : [...chatOverlayStreamIds.value, streamId];
  };

  /** Forget overlays of streams that no longer exist. */
  const pruneChatOverlays = (streamIds: string[]) => {
    const kept = chatOverlayStreamIds.value.filter((id) => streamIds.includes(id));
    if (kept.length !== chatOverlayStreamIds.value.length) chatOverlayStreamIds.value = kept;
  };

  /**
   * @brief Toggle the sidebar
   *
   * @return void
   */
  const toggleSidebar = () => {
    sidebarOpen.value = !sidebarOpen.value;
  };

  /**
   * @brief Set the sidebar open state
   *
   * @param open The open state
   * @return void
   */
  const setSidebarOpen = (open: boolean) => {
    sidebarOpen.value = open;
  };

  /**
   * @brief Toggle the followed channels sidebar
   *
   * @return void
   */
  const toggleFollowedSidebar = () => {
    followedSidebarOpen.value = !followedSidebarOpen.value;
  };

  /**
   * @brief Set the followed channels sidebar open state
   *
   * @param open The open state
   * @return void
   */
  const setFollowedSidebarOpen = (open: boolean) => {
    followedSidebarOpen.value = open;
  };

  /**
   * @brief Set the onboarding completed state
   *
   * @param completed The completed state
   * @return void
   */
  const setOnboardingCompleted = (completed: boolean) => {
    onboardingCompleted.value = completed;
  };

  const setPendingChangelogVersion = (version: string) => {
    pendingChangelogVersion.value = version;
  };

  /**
   * @brief Reset the preferences to default
   *
   * @return void
   */
  const resetPreferences = () => {
    selectedChat.value = defaultPreferences.selectedChat;
    sidebarOpen.value = defaultPreferences.sidebarOpen;
    followedSidebarOpen.value = defaultPreferences.followedSidebarOpen;
    followedOfflineOpen.value = defaultPreferences.followedOfflineOpen;
    notificationsEnabled.value = defaultPreferences.notificationsEnabled;
    onboardingCompleted.value = defaultPreferences.onboardingCompleted;
    pendingChangelogVersion.value = defaultPreferences.pendingChangelogVersion;

    recordingQuality.value = defaultPreferences.recordingQuality;
    recordingPath.value = defaultPreferences.recordingPath;
    nativePlayerEnabled.value = defaultPreferences.nativePlayerEnabled;
    adblockEnabled.value = defaultPreferences.adblockEnabled;
    immersiveModeEnabled.value = defaultPreferences.immersiveModeEnabled;

    vodSkipForwardSeconds.value = defaultPreferences.vodSkipForwardSeconds;
    vodSkipBackSeconds.value = defaultPreferences.vodSkipBackSeconds;
    chatOverlayStreamIds.value = [...defaultPreferences.chatOverlayStreamIds];
  };

  return {
    // state
    selectedChat,
    sidebarOpen,
    followedSidebarOpen,
    followedOfflineOpen,
    notificationsEnabled,
    onboardingCompleted,
    pendingChangelogVersion,

    recordingQuality,
    recordingPath,
    nativePlayerEnabled,
    adblockEnabled,
    immersiveModeEnabled,
    vodSkipForwardSeconds,
    vodSkipBackSeconds,
    chatOverlayStreamIds,

    // actions
    setSelectedChat,
    toggleSidebar,
    setSidebarOpen,
    toggleFollowedSidebar,
    setFollowedSidebarOpen,
    setOnboardingCompleted,
    setPendingChangelogVersion,
    setRecordingQuality,
    setRecordingPath,
    setAdblockEnabled,
    setImmersiveModeEnabled,
    toggleImmersiveMode,
    setVodSkipForwardSeconds,
    setVodSkipBackSeconds,
    isChatOverlayOn,
    toggleChatOverlay,
    pruneChatOverlays,
    resetPreferences,
  };
};

export const usePreferences = createSharedComposable(_usePreferences);
