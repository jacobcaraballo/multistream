import { describe, it, expect } from "vitest";
import { previewAt, type VodPreviews } from "../vodPreviews";

const sprites: VodPreviews = {
  kind: "sprites",
  interval: 180,
  count: 200,
  cols: 5,
  rows: 10,
  width: 220,
  height: 124,
  images: [
    "https://cdn/high-0.jpg",
    "https://cdn/high-1.jpg",
    "https://cdn/high-2.jpg",
    "https://cdn/high-3.jpg",
  ],
};

const frames: VodPreviews = {
  kind: "frames",
  urlPrefix: "https://stream.kick.com/rec/media/thumbnails/thumb",
  interval: 60,
  first: 1,
  last: 923,
};

describe("previewAt", () => {
  it("should pick the sprite tile covering a moment", () => {
    // Act
    const start = previewAt(sprites, 0);
    const second = previewAt(sprites, 181);
    const nextSheet = previewAt(sprites, 50 * 180 + 6 * 180);

    // Assert
    expect(start).toEqual({
      kind: "sprite",
      url: "https://cdn/high-0.jpg",
      x: 0,
      y: 0,
      width: 220,
      height: 124,
      sheetWidth: 1100,
    });
    expect(second).toMatchObject({ url: "https://cdn/high-0.jpg", x: 220, y: 0 });
    expect(nextSheet).toMatchObject({ url: "https://cdn/high-1.jpg", x: 220, y: 124 });
  });

  it("should clamp moments past the end to the last tile", () => {
    // Act
    const last = previewAt(sprites, 10_000_000);

    // Assert
    expect(last).toMatchObject({ url: "https://cdn/high-3.jpg", x: 4 * 220, y: 9 * 124 });
  });

  it("should return nothing when a sprite sheet is missing", () => {
    // Arrange
    const partial: VodPreviews = { ...sprites, images: ["https://cdn/high-0.jpg"] };

    // Act / Assert
    expect(previewAt(partial, 60 * 180)).toBeNull();
  });

  it("should pick the Kick frame nearest a moment, starting at frame 1", () => {
    // Act / Assert
    expect(previewAt(frames, 0)).toEqual({
      kind: "image",
      url: "https://stream.kick.com/rec/media/thumbnails/thumb1.jpg",
    });
    expect(previewAt(frames, 89)).toMatchObject({ url: expect.stringMatching(/thumb1\.jpg$/) });
    expect(previewAt(frames, 91)).toMatchObject({ url: expect.stringMatching(/thumb2\.jpg$/) });
    expect(previewAt(frames, 1e9)).toMatchObject({ url: expect.stringMatching(/thumb923\.jpg$/) });
  });

  it("should not ask for frames a recording hasn't written yet", () => {
    // Arrange
    const recording: VodPreviews = { ...frames, last: undefined };

    // Act / Assert
    expect(previewAt(recording, 3000, 600)).toMatchObject({
      url: expect.stringMatching(/thumb10\.jpg$/),
    });
    expect(previewAt(recording, 10, 30)).toBeNull();
  });

  it("should ignore moments that aren't numbers", () => {
    // Act / Assert
    expect(previewAt(frames, Number.NaN)).toBeNull();
  });
});
