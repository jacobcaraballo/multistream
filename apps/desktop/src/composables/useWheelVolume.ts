import type { Ref } from "vue";
import { useFocusedStream } from "./useFocusedStream";
import {
  announceVolume,
  createWheelState,
  isInsideScrollable,
  steppedVolume,
  wheelSteps,
} from "@/lib/wheelVolume";

interface WheelVolumeTarget {
  streamId: () => string | undefined;
  /** Slider value, 0..100. */
  volume: Ref<number[]>;
  isMuted: Ref<boolean>;
  video: Ref<HTMLVideoElement | null>;
}

/**
 * @brief Wheel handler for a native player: scrolling over it changes its volume
 *
 * Louder on a tile without the audio gives it the audio, like clicking it would, since only one
 * tile plays sound at a time; quieter only lowers its level while it stays muted.
 */
export function useWheelVolume({ streamId, volume, isMuted, video }: WheelVolumeTarget) {
  const { audioStreamId } = useFocusedStream();
  const state = createWheelState();

  return (e: WheelEvent) => {
    const id = streamId();
    if (!id || e.ctrlKey || e.metaKey || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
    if (e.currentTarget instanceof Element && isInsideScrollable(e.target, e.currentTarget)) return;
    e.preventDefault();
    const steps = wheelSteps(e, state, performance.now());
    if (!steps) return;

    if (steps > 0 && audioStreamId.value !== id) audioStreamId.value = id;
    const next = Math.round(steppedVolume((volume.value[0] ?? 50) / 100, steps) * 100);
    volume.value = [next];
    if (steps > 0) isMuted.value = false;
    else if (next === 0) isMuted.value = true;

    const el = video.value;
    if (el) {
      el.volume = next / 100;
      el.muted = isMuted.value;
    }
    announceVolume(id, next / 100, isMuted.value);
  };
}
