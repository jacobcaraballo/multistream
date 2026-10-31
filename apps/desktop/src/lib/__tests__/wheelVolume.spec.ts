import { describe, it, expect } from "vitest";
import { createWheelState, steppedVolume, wheelSteps } from "../wheelVolume";

const wheel = (deltaY: number, deltaMode = 0, deltaX = 0) => ({ deltaX, deltaY, deltaMode });

describe("wheelSteps", () => {
  it("should move one step per separate mouse notch, whatever its size", () => {
    // Arrange
    const state = createWheelState();

    // Act
    const macNotch = wheelSteps(wheel(-4), state, 0);
    const windowsNotch = wheelSteps(wheel(100), state, 500);
    const lineNotch = wheelSteps(wheel(-3, 1), state, 1000);

    // Assert
    expect([macNotch, windowsNotch, lineNotch]).toEqual([1, -1, 1]);
  });

  it("should count every notch of a quickly rolled macOS mouse wheel", () => {
    // Arrange
    const state = createWheelState();
    const steps: number[] = [];

    // Act (5 small notches, 80ms apart)
    for (let i = 0; i < 5; i++) steps.push(wheelSteps(wheel(-4 * (i + 1)), state, i * 80));

    // Assert
    expect(steps).toEqual([1, 1, 1, 1, 1]);
  });

  it("should add a step per 100px during a quick run of events", () => {
    // Arrange
    const state = createWheelState();
    const steps: number[] = [];

    // Act (a trackpad swipe down: 12 events of 20px, 16ms apart)
    for (let i = 0; i < 12; i++) steps.push(wheelSteps(wheel(20), state, i * 16));

    // Assert
    expect(steps[0]).toBe(-1);
    expect(steps.reduce((a, b) => a + b, 0)).toBe(-3);
  });

  it("should cap a single huge event", () => {
    // Arrange
    const state = createWheelState();
    wheelSteps(wheel(-10), state, 0);

    // Act
    const steps = wheelSteps(wheel(-5000), state, 10);

    // Assert
    expect(steps).toBe(4);
  });

  it("should ignore sideways scrolling", () => {
    // Act / Assert
    expect(wheelSteps(wheel(5, 0, 40), createWheelState(), 0)).toBe(0);
    expect(wheelSteps(wheel(0), createWheelState(), 0)).toBe(0);
  });
});

describe("steppedVolume", () => {
  it("should snap to whole steps and stay within 0..1", () => {
    // Act / Assert
    expect(steppedVolume(0.5, 1)).toBeCloseTo(0.55);
    expect(steppedVolume(0.33, -1)).toBeCloseTo(0.3);
    expect(steppedVolume(0.98, 2)).toBe(1);
    expect(steppedVolume(0.02, -3)).toBe(0);
  });
});
