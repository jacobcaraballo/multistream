import { effectScope, nextTick, ref, type EffectScope } from "vue";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useVodSync } from "../useVodSync";
import type { Stream } from "../useStreams";
import type { Vod } from "@/lib/vod";
import { LIVE_EDGE_BUFFER_MS } from "@/lib/vodSync";

const mockStreamsRef = ref<Stream[]>([]);
const storage = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../useStreams", () => ({
  useStreams: () => ({ streams: mockStreamsRef }),
}));

// node test env has no window, so useStorage would not persist; back it with an in-memory map
vi.mock("@vueuse/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vueuse/core")>();
  const { ref: vueRef } = await import("vue");
  return {
    ...actual,
    useStorage: (key: string, initial: unknown) => {
      if (!storage.has(key)) storage.set(key, vueRef(initial));
      return storage.get(key);
    },
  };
});

const T0 = 1_793_000_000_000;
const HOUR_S = 3600;

class FakeVideo {
  currentTime = 0;
  paused = true;
  seeking = false;
  readyState = 4;
  playbackRate = 1;
  play = vi.fn(() => {
    this.paused = false;
    return Promise.resolve();
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
}

const asVideo = (v: FakeVideo) => v as unknown as HTMLVideoElement;

const makeVod = (
  id: string,
  startedAt: number,
  durationSeconds: number,
  isRecording = false
): Vod => ({
  id,
  platform: "twitch",
  channel: `ch${id}`,
  displayName: `Ch ${id}`,
  title: "",
  startedAt,
  durationSeconds,
  isRecording,
});

describe("useVodSync", () => {
  let scope: EffectScope;
  let sync: ReturnType<typeof useVodSync>;

  const setup = () => {
    scope = effectScope();
    sync = scope.run(() => useVodSync())!;
  };

  const addVod = (vod: Vod) => {
    const stream: Stream = { id: `s-${vod.id}`, channel: vod.channel, platform: vod.platform, vod };
    mockStreamsRef.value = [...mockStreamsRef.value, stream];
    return stream;
  };

  // A covers [T0, T0+1h], B covers [T0+30m, T0+1h30m]; they overlap for 30 minutes.
  const addTwoVods = () => {
    const a = makeVod("a", T0, HOUR_S);
    const b = makeVod("b", T0 + 1800_000, HOUR_S);
    return { aId: addVod(a).id, bId: addVod(b).id, a, b };
  };

  const register = (id: string, vod: Vod, video = new FakeVideo()) => {
    sync.registerPlayer(id, asVideo(video), {
      status: "ready",
      startMs: vod.startedAt,
      endS: vod.durationSeconds,
      isRecording: vod.isRecording,
    });
    return video;
  };

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
    });
    vi.setSystemTime(T0 + 10 * HOUR_S * 1000);
    storage.clear();
    mockStreamsRef.value = [];
    setup();
  });

  afterEach(() => {
    scope.stop();
    vi.useRealTimers();
  });

  it("should start at the beginning of the overlap and align every player to it", () => {
    // Arrange
    const { aId, bId, a, b } = addTwoVods();

    // Act
    const videoA = register(aId, a);
    const videoB = register(bId, b);

    // Assert
    expect(sync.position.value).toBe(T0 + 1800_000);
    expect(videoA.currentTime).toBe(1800);
    expect(videoB.currentTime).toBe(0);
    expect(videoA.paused).toBe(false);
    expect(videoB.paused).toBe(false);
    expect(sync.timeline.value?.overlap).toEqual({
      startMs: T0 + 1800_000,
      endMs: T0 + 3600_000,
    });
  });

  it("should advance the shared clock while every player has data", async () => {
    // Arrange
    const { aId, bId, a, b } = addTwoVods();
    register(aId, a);
    register(bId, b);
    const start = sync.position.value;
    await nextTick();

    // Act
    vi.advanceTimersByTime(1000);

    // Assert
    expect(sync.position.value - start).toBeGreaterThanOrEqual(800);
    expect(sync.isStalled.value).toBe(false);
  });

  it("should hold the clock and pause others while one player buffers", async () => {
    // Arrange
    const { aId, bId, a, b } = addTwoVods();
    const videoA = register(aId, a);
    const videoB = register(bId, b);
    await nextTick();
    videoB.readyState = 2;
    vi.advanceTimersByTime(200);
    const held = sync.position.value;

    // Act
    vi.advanceTimersByTime(2000);

    // Assert
    expect(sync.position.value).toBe(held);
    expect(sync.isStalled.value).toBe(true);
    expect(videoA.paused).toBe(true);

    // Act (buffer refilled)
    videoB.readyState = 4;
    vi.advanceTimersByTime(1000);

    // Assert
    expect(sync.position.value).toBeGreaterThan(held);
    expect(sync.isStalled.value).toBe(false);
    expect(videoA.paused).toBe(false);
  });

  it("should park a VOD that has not started yet at the current moment", () => {
    // Arrange
    const { aId, bId, a, b } = addTwoVods();
    register(aId, a);
    const videoB = register(bId, b);
    videoB.currentTime = 500;

    // Act
    sync.seek(T0 + 600_000);

    // Assert
    expect(sync.phases[bId]).toBe("before");
    expect(sync.phases[aId]).toBe("active");
    expect(videoB.paused).toBe(true);
    expect(videoB.currentTime).toBe(0);
  });

  it("should move every player when one tile is seeked", () => {
    // Arrange
    const { aId, bId, a, b } = addTwoVods();
    const videoA = register(aId, a);
    register(bId, b);

    // Act
    sync.seekPlayer(bId, 100);

    // Assert
    expect(sync.position.value).toBe(T0 + 1900_000);
    expect(videoA.currentTime).toBe(1900);
  });

  it("should apply per-VOD offsets to the media target", () => {
    // Arrange
    const { aId, bId, a, b } = addTwoVods();
    const videoA = register(aId, a);
    register(bId, b);
    sync.pause();

    // Act
    sync.nudgeOffset(aId, 1);
    sync.nudgeOffset(aId, 1);

    // Assert
    expect(sync.offsets.value[aId]).toBe(1);
    expect(videoA.currentTime).toBe(1801);

    // Act
    sync.resetOffset(aId);

    // Assert
    expect(sync.offsets.value[aId]).toBeUndefined();
    expect(videoA.currentTime).toBe(1800);
  });

  it("should resume from the saved position when it is inside the timeline", () => {
    // Arrange
    scope.stop();
    storage.set("vod-sync-position", ref(T0 + 2400_000));
    setup();

    // Act
    const { aId, a } = addTwoVods();
    register(aId, a);

    // Assert
    expect(sync.position.value).toBe(T0 + 2400_000);
  });

  it("should stop at the end when every VOD has finished", async () => {
    // Arrange
    const { aId, bId, a, b } = addTwoVods();
    register(aId, a);
    register(bId, b);
    await nextTick();

    // Act
    sync.seek(T0 + 5400_000 - 500);
    vi.advanceTimersByTime(1000);

    // Assert
    expect(sync.position.value).toBe(T0 + 5400_000);
    expect(sync.isPlaying.value).toBe(false);
  });

  it("should jump close to the live edge of a recording VOD", () => {
    // Arrange
    const live = makeVod("live", T0, 2 * HOUR_S, true);
    register(addVod(live).id, live);

    // Act
    sync.jumpToLatest();

    // Assert
    expect(sync.canJumpToLatest.value).toBe(true);
    expect(sync.position.value).toBe(T0 + 2 * HOUR_S * 1000 - LIVE_EDGE_BUFFER_MS);
    expect(sync.isPlaying.value).toBe(true);
  });

  it("should adopt the first player's moment when sync is switched back on", () => {
    // Arrange
    const { aId, bId, a, b } = addTwoVods();
    const videoA = register(aId, a);
    const videoB = register(bId, b);
    sync.setSyncEnabled(false);
    videoA.currentTime = 3000;
    videoB.currentTime = 10;

    // Act
    sync.setSyncEnabled(true);

    // Assert
    expect(sync.position.value).toBe(T0 + 3000_000);
    expect(videoB.currentTime).toBe(1200);
  });

  it("should skip the shared clock forward and back while synced", () => {
    // Arrange
    const { aId, bId, a, b } = addTwoVods();
    register(aId, a);
    register(bId, b);
    const start = sync.position.value;

    // Act
    const forward = sync.skip(10);

    // Assert
    expect(forward).toBe(true);
    expect(sync.position.value).toBe(start + 10_000);

    // Act
    sync.skip(-5);

    // Assert
    expect(sync.position.value).toBe(start + 5_000);
  });

  it("should skip only the targeted VOD while sync is off, within its length", () => {
    // Arrange
    const { aId, bId, a, b } = addTwoVods();
    const videoA = register(aId, a);
    const videoB = register(bId, b);
    sync.setSyncEnabled(false);
    videoA.currentTime = 100;
    videoB.currentTime = 3;

    // Act
    sync.skip(10, aId);
    sync.skip(-5, bId);

    // Assert
    expect(videoA.currentTime).toBe(110);
    expect(videoB.currentTime).toBe(0);

    // Act
    videoA.currentTime = HOUR_S - 4;
    sync.skip(10, aId);

    // Assert
    expect(videoA.currentTime).toBe(HOUR_S);
  });

  it("should only guess the target VOD when there is exactly one", () => {
    // Arrange
    const { aId, bId, a, b } = addTwoVods();
    const videoA = register(aId, a);
    register(bId, b);
    sync.setSyncEnabled(false);
    videoA.currentTime = 100;

    // Act / Assert
    expect(sync.skip(10)).toBe(false);
    expect(videoA.currentTime).toBe(100);

    // Act
    sync.unregisterPlayer(bId);
    const skipped = sync.skip(10);

    // Assert
    expect(skipped).toBe(true);
    expect(videoA.currentTime).toBe(110);
  });

  it("should report nothing to skip without VODs", () => {
    // Act / Assert
    expect(sync.skip(10)).toBe(false);
  });

  it("should leave players alone while sync is off", async () => {
    // Arrange
    const { aId, bId, a, b } = addTwoVods();
    register(aId, a);
    const videoB = register(bId, b);
    sync.setSyncEnabled(false);
    videoB.currentTime = 42;
    await nextTick();

    // Act
    vi.advanceTimersByTime(1000);

    // Assert
    expect(videoB.currentTime).toBe(42);
    expect(sync.phases[bId]).toBe("active");
  });

  it("should run the shared clock at the chosen speed and drive every player at it", async () => {
    // Arrange
    const { aId, bId, a, b } = addTwoVods();
    const videoA = register(aId, a);
    const videoB = register(bId, b);
    await nextTick();
    const start = sync.position.value;

    // Act
    sync.setSpeed(2);

    // Assert
    expect(sync.speed.value).toBe(2);
    expect(videoA.playbackRate).toBe(2);
    expect(videoB.playbackRate).toBe(2);

    // Act
    vi.advanceTimersByTime(1000);

    // Assert
    expect(sync.position.value - start).toBeGreaterThanOrEqual(1800);
  });

  it("should not rescale time that already elapsed when the speed changes", async () => {
    // Arrange
    const { aId, bId, a, b } = addTwoVods();
    register(aId, a);
    register(bId, b);
    await nextTick();
    const start = sync.position.value;
    vi.advanceTimersByTime(1000);

    // Act
    sync.setSpeed(2);

    // Assert
    expect(sync.position.value - start).toBeGreaterThanOrEqual(800);
    expect(sync.position.value - start).toBeLessThanOrEqual(1200);
  });

  it("should step speed through the presets", () => {
    // Arrange
    const { aId, a } = addTwoVods();
    register(aId, a);

    // Act
    sync.stepSpeed(1);
    sync.stepSpeed(1);

    // Assert
    expect(sync.speed.value).toBe(1.5);

    // Act
    sync.stepSpeed(-1);

    // Assert
    expect(sync.speed.value).toBe(1.25);
  });

  it("should fall back to normal speed once it catches up with a recording", () => {
    // Arrange
    const live = makeVod("live", T0, 2 * HOUR_S, true);
    const video = register(addVod(live).id, live);
    const latest = T0 + 2 * HOUR_S * 1000 - LIVE_EDGE_BUFFER_MS;
    sync.seek(latest - 60_000);

    // Act
    sync.setSpeed(2);

    // Assert
    expect(sync.speed.value).toBe(2);

    // Act
    sync.jumpToLatest();

    // Assert
    expect(sync.speed.value).toBe(1);
    expect(video.playbackRate).toBe(1);
  });
});
