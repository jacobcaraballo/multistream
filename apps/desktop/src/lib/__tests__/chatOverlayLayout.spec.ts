import { describe, it, expect } from "vitest";
import {
  normalizeFontScale,
  placementStyle,
  snapPosition,
  stepFontScale,
  type Geometry,
} from "../chatOverlayLayout";

const geometry: Geometry = {
  tileWidth: 1000,
  tileHeight: 600,
  boxWidth: 300,
  boxHeight: 100,
  bottomGap: 80,
};
// a box whose edges are `left`/`top` pixels from the tile's
const at = (left: number, top: number) => ({
  right: (1000 - left - 300) / 1000,
  bottom: (600 - top - 100) / 600,
});

describe("snapPosition", () => {
  it("should pin to a corner when dragged next to it", () => {
    // Act
    const topLeft = snapPosition(at(10, 60), geometry);
    const bottomRight = snapPosition(at(690, 420), geometry);

    // Assert
    expect([topLeft.ax, topLeft.ay]).toEqual(["l", "t"]);
    expect([bottomRight.ax, bottomRight.ay]).toEqual(["r", "b"]);
  });

  it("should pin to the middle of a side or edge", () => {
    // Act
    const leftSide = snapPosition(at(5, 250), geometry);
    const topMiddle = snapPosition(at(350, 50), geometry);

    // Assert
    expect([leftSide.ax, leftSide.ay]).toEqual(["l", "c"]);
    expect([topMiddle.ax, topMiddle.ay]).toEqual(["c", "t"]);
  });

  it("should stay free away from every edge and centre line", () => {
    // Act
    const free = snapPosition(at(120, 150), geometry);

    // Assert
    expect(free.ax).toBeUndefined();
    expect(free.ay).toBeUndefined();
  });
});

describe("placementStyle", () => {
  it("should use fixed gaps for pinned axes and fractions for free ones", () => {
    // Act
    const style = placementStyle({ right: 0.25, bottom: 0.4, ax: "l", ay: "b" }, 60);
    const free = placementStyle({ right: 0.25, bottom: 0.4 }, 60);

    // Assert
    expect(style).toEqual({ left: "8px", bottom: "60px" });
    expect(free).toEqual({ right: "25%", bottom: "40%" });
  });

  it("should centre a pinned axis with a transform", () => {
    // Act
    const style = placementStyle({ right: 0, bottom: 0, ax: "c", ay: "c" }, 60);

    // Assert
    expect(style).toMatchObject({ left: "50%", top: "50%" });
    expect(style.transform).toBe("translateX(-50%) translateY(-50%)");
  });
});

describe("font scale", () => {
  it("should step through the sizes and stop at both ends", () => {
    // Act / Assert
    expect(stepFontScale(1, 1)).toBe(1.15);
    expect(stepFontScale(1, -1)).toBe(0.85);
    expect(stepFontScale(0.85, -1)).toBe(0.85);
    expect(stepFontScale(2, 1)).toBe(2);
    expect(stepFontScale(1.2, 1)).toBe(1.3);
  });

  it("should clamp stored values and fall back for junk", () => {
    // Act / Assert
    expect(normalizeFontScale(5)).toBe(2);
    expect(normalizeFontScale(0.1)).toBe(0.85);
    expect(normalizeFontScale("big")).toBe(1);
  });
});
