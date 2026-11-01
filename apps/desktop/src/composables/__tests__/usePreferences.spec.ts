import { describe, it, expect, beforeEach, vi } from "vitest";
import { normalizeSkipSeconds, usePreferences } from "../usePreferences";

describe("usePreferences composable unit tests", () => {
  let sut: ReturnType<typeof usePreferences>;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();

    sut = usePreferences();
    sut.resetPreferences();
  });

  it("should initialize with default preferences", () => {
    // Arrange & Act
    const {
      selectedChat,
      sidebarOpen,
      notificationsEnabled,
      onboardingCompleted,
      nativePlayerEnabled,
      adblockEnabled,
      immersiveModeEnabled,
    } = sut;

    // Assert
    expect(selectedChat.value).toBe("");
    expect(sidebarOpen.value).toBe(true);
    expect(notificationsEnabled.value).toBe(true);
    expect(onboardingCompleted.value).toBe(false);
    expect(nativePlayerEnabled.value).toBe(false);
    expect(adblockEnabled.value).toBe(true);
    expect(immersiveModeEnabled.value).toBe(false);
  });

  it("should set selected chat correctly", () => {
    // Arrange
    const { setSelectedChat, selectedChat } = sut;

    // Act
    setSelectedChat("gaules_twitch");

    // Assert
    expect(selectedChat.value).toBe("gaules_twitch");
  });

  it("should set onboarding completed state correctly", () => {
    // Arrange
    const { setOnboardingCompleted, onboardingCompleted } = sut;

    // Act
    setOnboardingCompleted(true);

    // Assert
    expect(onboardingCompleted.value).toBe(true);
  });

  it("should toggle sidebar open state", () => {
    // Arrange
    const { toggleSidebar, sidebarOpen } = sut;
    expect(sidebarOpen.value).toBe(true); // default

    // Act
    toggleSidebar();

    // Assert
    expect(sidebarOpen.value).toBe(false);

    // Act again
    toggleSidebar();

    // Assert again
    expect(sidebarOpen.value).toBe(true);
  });

  it("should set sidebar open state explicitly", () => {
    // Arrange
    const { setSidebarOpen, sidebarOpen } = sut;

    // Act (set to false)
    setSidebarOpen(false);

    // Assert
    expect(sidebarOpen.value).toBe(false);

    // Act (set to true)
    setSidebarOpen(true);

    // Assert
    expect(sidebarOpen.value).toBe(true);
  });

  it("should toggle followed sidebar open state", () => {
    // Arrange
    const { toggleFollowedSidebar, followedSidebarOpen } = sut;
    expect(followedSidebarOpen.value).toBe(false); // default

    // Act
    toggleFollowedSidebar();

    // Assert
    expect(followedSidebarOpen.value).toBe(true);

    // Act again
    toggleFollowedSidebar();

    // Assert again
    expect(followedSidebarOpen.value).toBe(false);
  });

  it("should set followed sidebar open state explicitly", () => {
    // Arrange
    const { setFollowedSidebarOpen, followedSidebarOpen } = sut;

    // Act (set to true)
    setFollowedSidebarOpen(true);

    // Assert
    expect(followedSidebarOpen.value).toBe(true);

    // Act (set to false)
    setFollowedSidebarOpen(false);

    // Assert
    expect(followedSidebarOpen.value).toBe(false);
  });

  it("should set recording quality correctly", () => {
    // Arrange
    const { setRecordingQuality, recordingQuality } = sut;

    // Act
    setRecordingQuality("720p");

    // Assert
    expect(recordingQuality.value).toBe("720p");
  });

  it("should set recording path correctly", () => {
    // Arrange
    const { setRecordingPath, recordingPath } = sut;

    // Act
    setRecordingPath("D:/videos");

    // Assert
    expect(recordingPath.value).toBe("D:/videos");
  });

  it("should set adblock enabled state correctly", () => {
    // Arrange
    const { setAdblockEnabled, adblockEnabled } = sut;
    expect(adblockEnabled.value).toBe(true);

    // Act
    setAdblockEnabled(false);

    // Assert
    expect(adblockEnabled.value).toBe(false);

    // Act again
    setAdblockEnabled(true);

    // Assert again
    expect(adblockEnabled.value).toBe(true);
  });

  it("should set pending changelog version correctly", () => {
    // Arrange
    const { setPendingChangelogVersion, pendingChangelogVersion } = sut;
    expect(pendingChangelogVersion.value).toBe("");

    // Act
    setPendingChangelogVersion("0.19.0");

    // Assert
    expect(pendingChangelogVersion.value).toBe("0.19.0");
  });

  it("should set and toggle immersive mode correctly", () => {
    // Arrange
    const { setImmersiveModeEnabled, toggleImmersiveMode, immersiveModeEnabled } = sut;
    expect(immersiveModeEnabled.value).toBe(false);

    // Act
    setImmersiveModeEnabled(true);

    // Assert
    expect(immersiveModeEnabled.value).toBe(true);

    // Act
    toggleImmersiveMode();

    // Assert
    expect(immersiveModeEnabled.value).toBe(false);
  });

  it("should reset all preferences to default values", () => {
    // Arrange
    const {
      resetPreferences,
      setSelectedChat,
      selectedChat,
      setSidebarOpen,
      sidebarOpen,
      setFollowedSidebarOpen,
      followedSidebarOpen,
      notificationsEnabled,
      setOnboardingCompleted,
      onboardingCompleted,
      setPendingChangelogVersion,
      pendingChangelogVersion,
      nativePlayerEnabled,
      adblockEnabled,
      setAdblockEnabled,
      setRecordingQuality,
      recordingQuality,
      setRecordingPath,
      recordingPath,
      setImmersiveModeEnabled,
      immersiveModeEnabled,
    } = sut;

    // Tweak properties
    setSelectedChat("alanzoka_twitch");
    setSidebarOpen(false);
    setFollowedSidebarOpen(true);
    notificationsEnabled.value = false;
    setOnboardingCompleted(true);
    setPendingChangelogVersion("0.19.0");
    nativePlayerEnabled.value = true;
    setAdblockEnabled(false);
    setRecordingQuality("480p");
    setRecordingPath("C:/test");
    setImmersiveModeEnabled(true);

    expect(selectedChat.value).toBe("alanzoka_twitch");
    expect(sidebarOpen.value).toBe(false);
    expect(followedSidebarOpen.value).toBe(true);
    expect(notificationsEnabled.value).toBe(false);
    expect(onboardingCompleted.value).toBe(true);
    expect(pendingChangelogVersion.value).toBe("0.19.0");
    expect(nativePlayerEnabled.value).toBe(true);
    expect(adblockEnabled.value).toBe(false);
    expect(recordingQuality.value).toBe("480p");
    expect(recordingPath.value).toBe("C:/test");
    expect(immersiveModeEnabled.value).toBe(true);

    // Act
    resetPreferences();

    // Assert
    expect(selectedChat.value).toBe("");
    expect(sidebarOpen.value).toBe(true);
    expect(followedSidebarOpen.value).toBe(false);
    expect(notificationsEnabled.value).toBe(true);
    expect(onboardingCompleted.value).toBe(false);
    expect(pendingChangelogVersion.value).toBe("");
    expect(nativePlayerEnabled.value).toBe(false);
    expect(adblockEnabled.value).toBe(true);
    expect(recordingQuality.value).toBe("best");
    expect(recordingPath.value).toBe("");
    expect(immersiveModeEnabled.value).toBe(false);
  });

  it("should default VOD arrow-key skips to 10s forward and 5s back", () => {
    // Assert
    expect(sut.vodSkipForwardSeconds.value).toBe(10);
    expect(sut.vodSkipBackSeconds.value).toBe(5);
  });

  it("should store skip seconds as whole, bounded numbers", () => {
    // Act
    sut.setVodSkipForwardSeconds("30");
    sut.setVodSkipBackSeconds(2.6);

    // Assert
    expect(sut.vodSkipForwardSeconds.value).toBe(30);
    expect(sut.vodSkipBackSeconds.value).toBe(3);

    // Act
    sut.setVodSkipForwardSeconds(0);
    sut.setVodSkipBackSeconds(99999);

    // Assert
    expect(sut.vodSkipForwardSeconds.value).toBe(1);
    expect(sut.vodSkipBackSeconds.value).toBe(600);
  });

  it("should keep the default when a skip value isn't a number", () => {
    // Act / Assert
    expect(normalizeSkipSeconds("", 10)).toBe(10);
    expect(normalizeSkipSeconds("abc", 5)).toBe(5);
    expect(normalizeSkipSeconds(Number.NaN, 5)).toBe(5);
    expect(normalizeSkipSeconds(undefined, 10)).toBe(10);
  });

  it("should toggle a tile's chat overlay and forget removed streams", () => {
    // Act
    sut.toggleChatOverlay("a");
    sut.toggleChatOverlay("b");

    // Assert
    expect(sut.isChatOverlayOn("a")).toBe(true);
    expect(sut.chatOverlayStreamIds.value).toEqual(["a", "b"]);

    // Act
    sut.toggleChatOverlay("a");
    sut.pruneChatOverlays(["c"]);

    // Assert
    expect(sut.isChatOverlayOn("a")).toBe(false);
    expect(sut.chatOverlayStreamIds.value).toEqual([]);
  });

  it("should remember a dragged chat overlay, put it back on reset, and forget removed streams", () => {
    // Act
    sut.setChatOverlayPosition("a", { right: 0.4, bottom: 0.2 });
    sut.setChatOverlayPosition("b", { right: 0.1, bottom: 0.1 });

    // Assert
    expect(sut.chatOverlayPositions.value.a).toEqual({ right: 0.4, bottom: 0.2 });

    // Act
    sut.setChatOverlayPosition("b", null);
    sut.pruneChatOverlays(["b"]);

    // Assert
    expect(sut.chatOverlayPositions.value).toEqual({});

    // Act
    sut.setChatOverlayPosition("c", { right: 0.3, bottom: 0.3 });
    sut.resetPreferences();

    // Assert
    expect(sut.chatOverlayPositions.value).toEqual({});
  });

  it("should reset skip seconds and overlays to defaults", () => {
    // Arrange
    sut.setVodSkipForwardSeconds(45);
    sut.toggleChatOverlay("a");

    // Act
    sut.resetPreferences();

    // Assert
    expect(sut.vodSkipForwardSeconds.value).toBe(10);
    expect(sut.chatOverlayStreamIds.value).toEqual([]);
  });
});
