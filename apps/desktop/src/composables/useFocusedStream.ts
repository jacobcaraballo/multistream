import { watch } from "vue";
import { useStorage, createSharedComposable } from "@vueuse/core";

const _useFocusedStream = () => {
  const focusedStreamId = useStorage<string | null>("multistream-focused-id", null);

  /**
   * @brief Stream that has the audio: it plays unmuted while every other tile is muted.
   * Null until the user picks one, which leaves each player's own mute state alone.
   */
  const audioStreamId = useStorage<string | null>("multistream-audio-id", null);

  // whatever fills the big viewer (Maximize button, drag-swap, click) also gets the audio
  watch(
    focusedStreamId,
    (id) => {
      if (id) audioStreamId.value = id;
    },
    { flush: "sync" }
  );

  /**
   * @brief Toggle focus on a stream
   *
   * If the stream is already focused, it unfocuses it (returns to normal grid).
   * Otherwise, it sets the given stream as the focused one.
   *
   * @param id The stream ID to focus/unfocus
   */
  const toggleFocus = (id: string) => {
    focusedStreamId.value = focusedStreamId.value === id ? null : id;
  };

  /**
   * @brief Check if a stream is focused
   *
   * @param id The stream ID to check
   * @returns true if the stream is the currently focused one
   */
  const isFocused = (id: string) => focusedStreamId.value === id;

  /**
   * @brief Clear focus
   *
   * Resets focus, returning to the normal grid layout.
   */
  const clearFocus = () => {
    focusedStreamId.value = null;
  };

  const isAudioActive = (id: string) => audioStreamId.value === id;

  /**
   * @brief Select a stream the user clicked
   *
   * Gives it the audio (unmuting it and muting the others). With the big viewer on, it also
   * moves into the big viewer.
   *
   * @param id The stream ID
   */
  const activateStream = (id: string) => {
    if (focusedStreamId.value !== null) focusedStreamId.value = id;
    audioStreamId.value = id;
  };

  /** True when a click on the tile should select it rather than reach the player. */
  const needsActivation = (id: string) =>
    !isAudioActive(id) || (focusedStreamId.value !== null && !isFocused(id));

  const clearAudio = () => {
    audioStreamId.value = null;
  };

  return {
    focusedStreamId,
    audioStreamId,
    toggleFocus,
    isFocused,
    clearFocus,
    isAudioActive,
    activateStream,
    needsActivation,
    clearAudio,
  };
};

export const useFocusedStream = createSharedComposable(_useFocusedStream);
