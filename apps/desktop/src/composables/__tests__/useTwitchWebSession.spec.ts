import { effectScope, type EffectScope } from "vue";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

vi.mock("@/composables/useUpdater", () => ({
  isTauri: () => true,
}));

vi.mock("@vueuse/core", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@vueuse/core");
  return {
    ...actual,
    createSharedComposable: (fn: unknown) => fn,
  };
});

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTwitchWebSession, type TwitchWebSession } from "../useTwitchWebSession";

const invokeMock = invoke as ReturnType<typeof vi.fn>;
const listenMock = listen as ReturnType<typeof vi.fn>;

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("useTwitchWebSession", () => {
  let scope: EffectScope;
  let sut: ReturnType<typeof useTwitchWebSession>;
  let emitSessionChanged: (payload: TwitchWebSession) => void;
  const dispatchEvent = vi.fn();

  const setup = async (initial: TwitchWebSession) => {
    invokeMock.mockResolvedValueOnce(initial);
    scope = effectScope();
    sut = scope.run(() => useTwitchWebSession())!;
    await flush();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", { dispatchEvent });
    listenMock.mockImplementation((_name: string, handler: (e: { payload: unknown }) => void) => {
      emitSessionChanged = (payload) => handler({ payload });
      return Promise.resolve(vi.fn());
    });
  });

  afterEach(() => {
    scope?.stop();
    vi.unstubAllGlobals();
  });

  it("should load the current twitch.tv session on start", async () => {
    // Arrange / Act
    await setup({ connected: true, login: "jacob", hasTurbo: true });

    // Assert
    expect(invokeMock).toHaveBeenCalledWith("twitch_web_session_state");
    expect(sut.session.value).toEqual({ connected: true, login: "jacob", hasTurbo: true });
  });

  it("should fall back to signed out when the state check fails", async () => {
    // Arrange
    invokeMock.mockRejectedValueOnce(new Error("offline"));
    scope = effectScope();

    // Act
    sut = scope.run(() => useTwitchWebSession())!;
    await flush();

    // Assert
    expect(sut.session.value).toEqual({ connected: false, hasTurbo: false });
  });

  it("should reload built-in players when the user signs in", async () => {
    // Arrange
    await setup({ connected: false, hasTurbo: false });
    invokeMock.mockResolvedValueOnce(undefined);
    await sut.signIn();

    // Assert (waiting for the sign-in window)
    expect(sut.isSigningIn.value).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("twitch_web_login");

    // Act
    emitSessionChanged({ connected: true, login: "jacob", hasTurbo: true });

    // Assert
    expect(sut.isSigningIn.value).toBe(false);
    expect(sut.session.value.login).toBe("jacob");
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it("should not reload players when the sign-in window closes without a change", async () => {
    // Arrange
    await setup({ connected: false, hasTurbo: false });
    invokeMock.mockResolvedValueOnce(undefined);
    await sut.signIn();

    // Act
    emitSessionChanged({ connected: false, hasTurbo: false });

    // Assert
    expect(sut.isSigningIn.value).toBe(false);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it("should reset the signing-in flag when the window cannot open", async () => {
    // Arrange
    await setup({ connected: false, hasTurbo: false });
    invokeMock.mockRejectedValueOnce(new Error("no window"));

    // Act
    const result = sut.signIn();

    // Assert
    await expect(result).rejects.toThrow("no window");
    expect(sut.isSigningIn.value).toBe(false);
  });

  it("should reload players after signing out", async () => {
    // Arrange
    await setup({ connected: true, login: "jacob", hasTurbo: false });
    invokeMock.mockResolvedValueOnce(undefined);

    // Act
    await sut.signOut();
    emitSessionChanged({ connected: false, hasTurbo: false });

    // Assert
    expect(invokeMock).toHaveBeenCalledWith("twitch_web_logout");
    expect(sut.session.value.connected).toBe(false);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });
});
