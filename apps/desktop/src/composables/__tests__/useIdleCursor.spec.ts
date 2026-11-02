import { effectScope, nextTick, ref } from "vue";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const isActive = ref(false);
const isInteracting = ref(false);
vi.mock("../useFullscreenLayout", () => ({
  useFullscreenLayout: () => ({ isActive, isInteracting }),
}));

const classes = new Set<string>();
const listeners = new Map<string, () => void>();
vi.stubGlobal("document", {
  body: {
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
  },
});
vi.stubGlobal("window", {
  addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
  removeEventListener: (type: string) => listeners.delete(type),
});

import { IDLE_CURSOR_CLASS, IDLE_CURSOR_MS, useIdleCursor } from "../useIdleCursor";

describe("useIdleCursor", () => {
  let scope: ReturnType<typeof effectScope>;

  beforeEach(() => {
    vi.useFakeTimers();
    classes.clear();
    isActive.value = false;
    isInteracting.value = false;
    scope = effectScope();
    scope.run(() => useIdleCursor());
  });

  afterEach(() => {
    scope.stop();
    vi.useRealTimers();
  });

  it("should hide the cursor after a rest in the fullscreen layout and show it on movement", async () => {
    // Arrange
    isActive.value = true;
    await nextTick();

    // Act
    vi.advanceTimersByTime(IDLE_CURSOR_MS + 10);

    // Assert
    expect(classes.has(IDLE_CURSOR_CLASS)).toBe(true);

    // Act
    listeners.get("mousemove")?.();

    // Assert
    expect(classes.has(IDLE_CURSOR_CLASS)).toBe(false);
  });

  it("should leave the cursor alone outside the layout and restore it on exit", async () => {
    // Arrange
    isActive.value = true;
    await nextTick();
    vi.advanceTimersByTime(IDLE_CURSOR_MS + 10);

    // Act
    isActive.value = false;
    await nextTick();

    // Assert
    expect(classes.has(IDLE_CURSOR_CLASS)).toBe(false);

    // Act
    listeners.get("mousemove")?.();
    vi.advanceTimersByTime(IDLE_CURSOR_MS * 2);

    // Assert
    expect(classes.has(IDLE_CURSOR_CLASS)).toBe(false);
  });

  it("should keep the cursor while a PiP is being dragged", async () => {
    // Arrange
    isActive.value = true;
    isInteracting.value = true;
    await nextTick();

    // Act
    vi.advanceTimersByTime(IDLE_CURSOR_MS + 10);

    // Assert
    expect(classes.has(IDLE_CURSOR_CLASS)).toBe(false);
  });
});
