import { ref } from "vue";
import { describe, it, expect, beforeEach, vi } from "vitest";

const audioStreamId = ref<string | null>(null);
vi.mock("../useFocusedStream", () => ({ useFocusedStream: () => ({ audioStreamId }) }));

// node has no DOM: the wheel events here have no element to check for scrollable menus
vi.stubGlobal("Element", class {});

const announced: unknown[] = [];
vi.stubGlobal("window", {
  dispatchEvent: (e: CustomEvent) => {
    announced.push(e.detail);
    return true;
  },
});
vi.stubGlobal(
  "CustomEvent",
  class {
    type: string;
    detail: unknown;
    constructor(type: string, init: { detail: unknown }) {
      this.type = type;
      this.detail = init.detail;
    }
  }
);

import { useWheelVolume } from "../useWheelVolume";

const wheelEvent = (deltaY: number) => {
  const preventDefault = vi.fn();
  return {
    event: { deltaY, deltaX: 0, deltaMode: 0, ctrlKey: false, metaKey: false, preventDefault },
    preventDefault,
  };
};

describe("useWheelVolume", () => {
  let now = 0;
  const volume = ref([50]);
  const isMuted = ref(true);
  const video = ref({ volume: 0.5, muted: true } as unknown as HTMLVideoElement);
  let onWheel: ReturnType<typeof useWheelVolume>;

  const scroll = (deltaY: number) => {
    // separate notches, so each one is a step
    now += 1000;
    vi.spyOn(performance, "now").mockReturnValue(now);
    const { event, preventDefault } = wheelEvent(deltaY);
    onWheel(event as unknown as WheelEvent);
    return preventDefault;
  };

  beforeEach(() => {
    audioStreamId.value = "other";
    volume.value = [50];
    isMuted.value = true;
    video.value = { volume: 0.5, muted: true } as unknown as HTMLVideoElement;
    announced.length = 0;
    onWheel = useWheelVolume({ streamId: () => "me", volume, isMuted, video });
  });

  it("should take the audio and raise the level when scrolling up over a muted tile", () => {
    // Act
    const preventDefault = scroll(-4);

    // Assert
    expect(preventDefault).toHaveBeenCalled();
    expect(audioStreamId.value).toBe("me");
    expect(volume.value).toEqual([55]);
    expect(isMuted.value).toBe(false);
    expect(video.value!.muted).toBe(false);
    expect(video.value!.volume).toBeCloseTo(0.55);
    expect(announced).toEqual([{ streamId: "me", volume: 55, muted: false }]);
  });

  it("should only lower the level of a tile without the audio", () => {
    // Act
    scroll(4);

    // Assert
    expect(audioStreamId.value).toBe("other");
    expect(volume.value).toEqual([45]);
    expect(isMuted.value).toBe(true);
    expect(announced).toEqual([{ streamId: "me", volume: 45, muted: true }]);
  });

  it("should mute the tile with the audio once its level reaches zero", () => {
    // Arrange
    audioStreamId.value = "me";
    isMuted.value = false;
    volume.value = [5];

    // Act
    scroll(4);

    // Assert
    expect(volume.value).toEqual([0]);
    expect(isMuted.value).toBe(true);
  });

  it("should leave pinch-zoom gestures alone", () => {
    // Arrange
    const { event, preventDefault } = wheelEvent(-4);

    // Act
    onWheel({ ...event, ctrlKey: true } as unknown as WheelEvent);

    // Assert
    expect(preventDefault).not.toHaveBeenCalled();
    expect(volume.value).toEqual([50]);
  });
});
