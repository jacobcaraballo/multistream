import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { PREVIEW_RETRY_MS, __test_resetVodPreviews, loadVodPreviews } from "../useVodPreviews";
import type { VodPreviews } from "@/lib/vodPreviews";

const invokeMock = invoke as ReturnType<typeof vi.fn>;
const vod = { platform: "kick" as const, id: "abc" };
const frames: VodPreviews = {
  kind: "frames",
  urlPrefix: "https://x/thumb",
  interval: 60,
  first: 1,
};

describe("loadVodPreviews", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    __test_resetVodPreviews();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should fetch a VOD's previews once and share the result", async () => {
    // Arrange
    invokeMock.mockResolvedValue(frames);

    // Act
    const [a, b] = await Promise.all([loadVodPreviews(vod), loadVodPreviews(vod)]);
    const c = await loadVodPreviews(vod);

    // Assert
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("vod_previews", { platform: "kick", id: "abc" });
    expect([a, b, c]).toEqual([frames, frames, frames]);
  });

  it("should retry a VOD without previews only after a while", async () => {
    // Arrange
    invokeMock.mockResolvedValueOnce(null).mockResolvedValueOnce(frames);
    await loadVodPreviews(vod);

    // Act
    const soon = await loadVodPreviews(vod);
    vi.advanceTimersByTime(PREVIEW_RETRY_MS);
    const later = await loadVodPreviews(vod);

    // Assert
    expect(soon).toBeNull();
    expect(later).toEqual(frames);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("should treat a failed request as no previews", async () => {
    // Arrange
    invokeMock.mockRejectedValue(new Error("offline"));

    // Act
    const result = await loadVodPreviews(vod);

    // Assert
    expect(result).toBeNull();
  });
});
