import { ref, onScopeDispose } from "vue";
import { createSharedComposable } from "@vueuse/core";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "./useUpdater";

export interface TwitchWebSession {
  connected: boolean;
  login?: string;
  displayName?: string;
  hasTurbo: boolean;
}

const SIGNED_OUT: TwitchWebSession = { connected: false, hasTurbo: false };

async function signOut() {
  if (!isTauri()) return;
  await invoke("twitch_web_logout");
}

/**
 * @brief twitch.tv website sign-in used for ad-free (Turbo / subscriber) playback
 *
 * Separate from useTwitchAuth: Twitch only honors ad benefits and sub-only VOD access for playback
 * tokens requested with a twitch.tv session, so the user signs in on twitch.tv itself. Whenever the
 * session changes, built-in players reload so their next token carries the new session.
 */
const _useTwitchWebSession = () => {
  const session = ref<TwitchWebSession>({ ...SIGNED_OUT });
  const isSigningIn = ref(false);

  let unlisten: UnlistenFn | null = null;
  let disposed = false;

  const apply = (next: TwitchWebSession) => {
    const changed =
      next.connected !== session.value.connected || next.login !== session.value.login;
    session.value = next;
    isSigningIn.value = false;
    if (changed) window.dispatchEvent(new CustomEvent("multistream-reload-stream"));
  };

  const refresh = async () => {
    if (!isTauri()) return;
    try {
      session.value = await invoke<TwitchWebSession>("twitch_web_session_state");
    } catch {
      session.value = { ...SIGNED_OUT };
    }
  };

  const signIn = async () => {
    if (!isTauri() || isSigningIn.value) return;
    isSigningIn.value = true;
    try {
      await invoke("twitch_web_login");
    } catch (err) {
      isSigningIn.value = false;
      throw err;
    }
  };

  if (isTauri()) {
    listen<TwitchWebSession>("twitch-web-session-changed", (event) => apply(event.payload)).then(
      (fn) => {
        if (disposed) fn();
        else unlisten = fn;
      }
    );
    refresh();
  }

  onScopeDispose(() => {
    disposed = true;
    unlisten?.();
  });

  return { session, isSigningIn, refresh, signIn, signOut };
};

export const useTwitchWebSession = createSharedComposable(_useTwitchWebSession);
