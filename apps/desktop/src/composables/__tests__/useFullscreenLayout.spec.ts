import { nextTick, ref } from "vue";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Stream } from "../useStreams";

const mockStreams = ref<Stream[]>([]);
const audioStreamId = ref<string | null>(null);
const activateStream = vi.fn();
const isFullscreen = ref(false);
const setWindowFullscreen = vi.fn(async (on: boolean) => {
  isFullscreen.value = on;
  return true;
});
const nativePlayerEnabled = ref(false);
const viewport = { width: ref(1600), height: ref(900) };

vi.mock("@vueuse/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vueuse/core")>();
  const { ref: vueRef } = await import("vue");
  return {
    ...actual,
    createSharedComposable: (fn: unknown) => fn,
    useStorage: (_key: string, initial: unknown) => vueRef(initial),
    useWindowSize: () => viewport,
  };
});
vi.mock("../useStreams", () => ({ useStreams: () => ({ streams: mockStreams }) }));
vi.mock("../useFocusedStream", () => ({
  useFocusedStream: () => ({ audioStreamId, activateStream }),
}));
vi.mock("../useImmersiveMode", () => ({
  useImmersiveMode: () => ({ isFullscreen, setWindowFullscreen, syncFullscreenState: vi.fn() }),
}));
vi.mock("../usePreferences", () => ({ usePreferences: () => ({ nativePlayerEnabled }) }));
vi.mock("../useUpdater", () => ({ isTauri: () => false }));

import {
  PIP_BAR_PX,
  clampPipRect,
  defaultPipRect,
  pipHeight,
  useFullscreenLayout,
} from "../useFullscreenLayout";

const stream = (id: string, platform: Stream["platform"] = "kick"): Stream => ({
  id,
  channel: id,
  platform,
});

describe("PiP geometry", () => {
  const screen = { width: 1600, height: 900 };

  it("should keep a PiP on screen and at least its minimum size", () => {
    // Act
    const rect = clampPipRect({ left: 1500, top: -40, width: 100 }, screen, 320);

    // Assert
    expect(rect).toEqual({ left: 1280, top: 0, width: 320, height: 180 + PIP_BAR_PX });
  });

  it("should cap a PiP at most of the screen width", () => {
    // Act
    const rect = clampPipRect({ left: 0, top: 0, width: 5000 }, screen, 320);

    // Assert
    expect(rect.width).toBe(1120);
  });

  it("should stack new PiPs up the right edge, then start a new column", () => {
    // Act
    const first = defaultPipRect(0, screen, 320);
    const second = defaultPipRect(1, screen, 320);
    const height = pipHeight(first.width);
    const perColumn = Math.floor((900 - 16) / (height + 12));
    const nextColumn = defaultPipRect(perColumn, screen, 320);

    // Assert
    expect(first.left + first.width).toBe(1600 - 16);
    expect(first.top + first.height).toBe(900 - 16);
    expect(second.top + second.height).toBe(first.top - 12);
    expect(nextColumn.left + nextColumn.width).toBe(first.left - 12);
  });
});

describe("useFullscreenLayout", () => {
  let layout: ReturnType<typeof useFullscreenLayout>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStreams.value = [stream("a"), stream("b"), stream("c", "twitch")];
    audioStreamId.value = null;
    isFullscreen.value = false;
    nativePlayerEnabled.value = false;
    layout = useFullscreenLayout();
  });

  it("should fill the screen with a tile, give it the audio and go window-fullscreen", async () => {
    // Act
    await layout.enter("a");

    // Assert
    expect(layout.isMain("a")).toBe(true);
    expect(audioStreamId.value).toBe("a");
    expect(setWindowFullscreen).toHaveBeenCalledWith(true);
  });

  it("should leave window fullscreen on exit only when entering turned it on", async () => {
    // Arrange
    isFullscreen.value = true;
    await layout.enter("a");

    // Act
    await layout.exit();

    // Assert
    expect(layout.isActive.value).toBe(false);
    expect(setWindowFullscreen).not.toHaveBeenCalled();

    // Arrange
    isFullscreen.value = false;
    await layout.enter("a");

    // Act
    await layout.exit();

    // Assert
    expect(setWindowFullscreen).toHaveBeenLastCalledWith(false);
  });

  it("should float other tiles over the main one and drop them all on exit", async () => {
    // Arrange
    await layout.enter("a");

    // Act
    layout.togglePip("b");
    layout.togglePip("c");
    layout.togglePip("a");

    // Assert
    expect(layout.pipIds.value).toEqual(["b", "c"]);

    // Act
    await layout.exit();

    // Assert
    expect(layout.pipIds.value).toEqual([]);
  });

  it("should swap a PiP with the main tile, keeping the PiP's spot", async () => {
    // Arrange
    await layout.enter("a");
    layout.togglePip("b");
    layout.setRect("b", { left: 100, top: 100, width: 400 });
    const spot = layout.rectOf("b");

    // Act
    layout.swapWithMain("b");

    // Assert
    expect(layout.isMain("b")).toBe(true);
    expect(layout.pipIds.value).toEqual(["a"]);
    expect(layout.rectOf("a")).toEqual(spot);
    expect(audioStreamId.value).toBe("b");
  });

  it("should only move the audio when a tile is clicked inside the layout", async () => {
    // Arrange
    await layout.enter("a");
    layout.togglePip("b");

    // Act
    layout.selectTile("b");

    // Assert
    expect(audioStreamId.value).toBe("b");
    expect(activateStream).not.toHaveBeenCalled();
    expect(layout.isMain("a")).toBe(true);
  });

  it("should select tiles the usual way outside the layout", () => {
    // Act
    layout.selectTile("b");

    // Assert
    expect(activateStream).toHaveBeenCalledWith("b");
  });

  it("should keep Twitch embeds big enough that Twitch doesn't pause them", async () => {
    // Arrange
    await layout.enter("a");
    layout.togglePip("c");

    // Act
    layout.setRect("c", { left: 0, top: 0, width: 200 });

    // Assert
    expect(layout.rectOf("c").width).toBe(534);
    expect(layout.rectOf("c").height - PIP_BAR_PX).toBeGreaterThanOrEqual(300);
  });

  it("should end the layout when the main tile is removed and forget removed PiPs", async () => {
    // Arrange
    await layout.enter("a");
    layout.togglePip("b");
    layout.togglePip("c");

    // Act
    mockStreams.value = mockStreams.value.filter((s) => s.id !== "b");
    await nextTick();

    // Assert
    expect(layout.pipIds.value).toEqual(["c"]);

    // Act
    mockStreams.value = mockStreams.value.filter((s) => s.id !== "a");
    await nextTick();

    // Assert
    expect(layout.isActive.value).toBe(false);
  });

  it("should bring a PiP to the top of the stack", async () => {
    // Arrange
    await layout.enter("a");
    layout.togglePip("b");
    layout.togglePip("c");

    // Act
    layout.bringToFront("b");

    // Assert
    expect(layout.pipIds.value).toEqual(["c", "b"]);
    expect(layout.zIndexOf("b")!).toBeGreaterThan(layout.zIndexOf("c")!);
    expect(layout.zIndexOf("c")!).toBeGreaterThan(layout.zIndexOf("a")!);
  });
});
