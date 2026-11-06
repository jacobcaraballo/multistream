import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  CHAPTERS_RECORDING_TTL_MS,
  __test_resetVodChapters,
  loadVodChapters,
} from "../useVodChapters";

const invokeMock = invoke as ReturnType<typeof vi.fn>;
const finished = { platform: "twitch" as const, id: "1", isRecording: false };
const recording = { platform: "twitch" as const, id: "2", isRecording: true };
const chapters = [{ startS: 0, title: "Just Chatting" }];

describe("loadVodChapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    __test_resetVodChapters();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should fetch a finished VOD's chapters once and share them", async () => {
    // Arrange
    invokeMock.mockResolvedValue(chapters);

    // Act
    const [a, b] = await Promise.all([loadVodChapters(finished), loadVodChapters(finished)]);
    vi.advanceTimersByTime(CHAPTERS_RECORDING_TTL_MS * 10);
    const c = await loadVodChapters(finished);

    // Assert
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("vod_chapters", { platform: "twitch", id: "1" });
    expect([a, b, c]).toEqual([chapters, chapters, chapters]);
  });

  it("should fetch a recording's chapters again after a while", async () => {
    // Arrange
    invokeMock.mockResolvedValueOnce(chapters).mockResolvedValueOnce([...chapters, ...chapters]);
    await loadVodChapters(recording);

    // Act
    const soon = await loadVodChapters(recording);
    vi.advanceTimersByTime(CHAPTERS_RECORDING_TTL_MS);
    const later = await loadVodChapters(recording);

    // Assert
    expect(soon).toHaveLength(1);
    expect(later).toHaveLength(2);
  });

  it("should treat a failed request as no chapters", async () => {
    // Arrange
    invokeMock.mockRejectedValue(new Error("offline"));

    // Act / Assert
    expect(await loadVodChapters(finished)).toEqual([]);
  });
});
