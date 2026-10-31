import { effectScope, reactive, ref, type EffectScope } from "vue";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Vod } from "@/lib/vod";
import type { ReplayMessage } from "@/lib/vodChat";

const sync = vi.hoisted(() => ({
  state: null as null | {
    vodStreams: { value: unknown[] };
    players: Record<string, { isRecording: boolean; endS: number }>;
    phases: Record<string, string>;
    syncEnabled: { value: boolean };
    times: Record<string, number | null>;
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.mock("../useVodSync", () => ({
  useVodSync: () => ({
    vodStreams: sync.state!.vodStreams,
    players: sync.state!.players,
    phases: sync.state!.phases,
    syncEnabled: sync.state!.syncEnabled,
    mediaTimeOf: (id: string) => sync.state!.times[id] ?? null,
  }),
}));

import { invoke } from "@tauri-apps/api/core";
import { useVodChatReplay } from "../useVodChatReplay";

const invokeMock = invoke as ReturnType<typeof vi.fn>;

const vod = (id: string, channel: string): Vod => ({
  id,
  platform: "twitch",
  channel,
  displayName: channel,
  title: "",
  startedAt: 0,
  durationSeconds: 3600,
  isRecording: false,
});

const msg = (id: string, channel: string, offset: number): ReplayMessage => ({
  id,
  channel,
  username: "u",
  display_name: "U",
  message: "hi",
  timestamp_ms: offset * 1000,
  offset_seconds: offset,
  color: null,
  badges: [],
  emotes: null,
  platform: "twitch",
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("useVodChatReplay", () => {
  let scope: EffectScope;
  let sut: ReturnType<typeof useVodChatReplay>;

  const addVod = (streamId: string, v: Vod, time: number) => {
    sync.state!.vodStreams.value = [
      ...sync.state!.vodStreams.value,
      { id: streamId, channel: v.channel, platform: v.platform, vod: v },
    ];
    sync.state!.players[streamId] = { isRecording: false, endS: 3600 };
    sync.state!.phases[streamId] = "active";
    sync.state!.times[streamId] = time;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sync.state = {
      vodStreams: ref<unknown[]>([]),
      players: reactive({}),
      phases: reactive({}),
      syncEnabled: ref(true),
      times: {},
    };
    scope = effectScope();
    sut = scope.run(() => useVodChatReplay())!;
  });

  afterEach(() => {
    scope.stop();
  });

  it("should fetch from just before the playhead and reveal only reached messages", async () => {
    // Arrange
    addVod("s1", vod("111", "riotgames"), 100);
    invokeMock.mockResolvedValueOnce([
      msg("early", "riotgames", 85),
      msg("now", "riotgames", 99),
      msg("later", "riotgames", 104),
    ]);

    // Act
    sut.tick();
    await flush();
    sut.tick();

    // Assert
    expect(invokeMock).toHaveBeenCalledWith("vod_chat", {
      platform: "twitch",
      vodId: "111",
      channel: "riotgames",
      startedAt: 0,
      offsetSeconds: 80,
    });
    expect(sut.messages.value.map((m) => m.id)).toEqual(["now", "early"]);

    // Act (playback moves past the next message)
    sync.state!.times.s1 = 105;
    sut.tick();

    // Assert
    expect(sut.messages.value.map((m) => m.id)).toEqual(["later", "now", "early"]);
  });

  it("should start over from the new position after a seek", async () => {
    // Arrange
    addVod("s1", vod("111", "riotgames"), 100);
    invokeMock.mockResolvedValue([msg("a", "riotgames", 99)]);
    sut.tick();
    await flush();

    // Act
    sync.state!.times.s1 = 2000;
    sut.tick();
    await flush();

    // Assert
    expect(invokeMock).toHaveBeenLastCalledWith(
      "vod_chat",
      expect.objectContaining({ offsetSeconds: 1980 })
    );
    expect(sut.messages.value).toEqual([]);
  });

  it("should leave out VODs that don't cover the current synced moment", async () => {
    // Arrange
    addVod("s1", vod("111", "riotgames"), 100);
    sync.state!.phases.s1 = "after";

    // Act
    sut.tick();
    await flush();

    // Assert
    expect(invokeMock).not.toHaveBeenCalled();
    expect(sut.messages.value).toEqual([]);
  });

  it("should hide a channel's chat when it is filtered out", async () => {
    // Arrange
    addVod("s1", vod("111", "riotgames"), 100);
    addVod("s2", vod("222", "caedrel"), 100);
    invokeMock.mockImplementation((_cmd: string, args: { vodId: string }) =>
      Promise.resolve(
        args.vodId === "111" ? [msg("r", "riotgames", 90)] : [msg("c", "caedrel", 95)]
      )
    );
    sut.tick();
    await flush();
    sut.tick();

    // Act
    sut.toggleHidden("s2");
    sut.tick();

    // Assert
    expect(sut.messages.value.map((m) => m.id)).toEqual(["r"]);

    // Act
    sut.toggleHidden("s2");
    sut.tick();

    // Assert
    expect(sut.messages.value.map((m) => m.id)).toEqual(["c", "r"]);
  });

  it("should retry later instead of hammering after a failed fetch", async () => {
    // Arrange
    addVod("s1", vod("111", "riotgames"), 100);
    invokeMock.mockRejectedValueOnce(new Error("offline"));

    // Act
    sut.tick();
    await flush();
    sut.tick();
    sut.tick();

    // Assert
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("should serve one tile's overlay without the panel and fetch only for it", async () => {
    // Arrange
    addVod("s1", vod("111", "riotgames"), 100);
    addVod("s2", vod("222", "caedrel"), 100);
    invokeMock.mockResolvedValue([msg("r1", "riotgames", 90), msg("r2", "riotgames", 99)]);
    const release = sut.requestOverlay("s1");

    // Act
    sut.tick();
    await flush();
    sut.tick();

    // Assert
    const fetchedVods = invokeMock.mock.calls.map(([, args]) => (args as { vodId: string }).vodId);
    expect(fetchedVods.length).toBeGreaterThan(0);
    expect(new Set(fetchedVods)).toEqual(new Set(["111"]));
    expect(sut.streamMessages.value.s1?.map((m) => m.id)).toEqual(["r2", "r1"]);
    expect(sut.streamMessages.value.s2).toBeUndefined();

    // Act
    release();
    sut.tick();

    // Assert
    expect(sut.streamMessages.value).toEqual({});
  });

  it("should keep an overlay alive until every requester releases it", () => {
    // Arrange
    addVod("s1", vod("111", "riotgames"), 100);
    const first = sut.requestOverlay("s1");
    const second = sut.requestOverlay("s1");

    // Act
    first();
    first();
    invokeMock.mockResolvedValue([]);
    sut.tick();

    // Assert
    expect(invokeMock).toHaveBeenCalledTimes(1);

    // Act
    second();
    invokeMock.mockClear();
    sut.tick();

    // Assert: with no overlay and no panel, a manual tick reverts to panel behaviour
    expect(sut.streamMessages.value).toEqual({});
  });

  it("should leave the panel's messages alone while only overlays are running", async () => {
    // Arrange: the panel showed messages, then was hidden while an overlay kept running
    addVod("s1", vod("111", "riotgames"), 100);
    invokeMock.mockResolvedValue([msg("r1", "riotgames", 90)]);
    sut.setActive(true);
    await flush();
    sut.tick();
    const shown = sut.messages.value.map((m) => m.id);
    const release = sut.requestOverlay("s1");
    sut.setActive(false);

    // Act
    sut.tick();

    // Assert
    expect(shown).toEqual(["r1"]);
    expect(sut.messages.value.map((m) => m.id)).toEqual(["r1"]);
    release();
  });
});
