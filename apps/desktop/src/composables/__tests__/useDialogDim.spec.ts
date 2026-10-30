import { effectScope, ref, type EffectScope } from "vue";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DIALOG_OPEN_CLASS, useDialogDim } from "../useDialogDim";

const flush = () => Promise.resolve();

describe("useDialogDim", () => {
  const classes = new Set<string>();
  const scopes: EffectScope[] = [];

  const mountDialog = (open: boolean) => {
    const isOpen = ref(open);
    const scope = effectScope();
    scope.run(() => useDialogDim(() => isOpen.value));
    scopes.push(scope);
    return { isOpen, scope };
  };

  beforeEach(() => {
    classes.clear();
    vi.stubGlobal("document", {
      body: {
        classList: {
          toggle: (name: string, force: boolean) =>
            force ? classes.add(name) : classes.delete(name),
        },
      },
    });
  });

  afterEach(() => {
    scopes.splice(0).forEach((scope) => scope.stop());
    vi.unstubAllGlobals();
  });

  it("should dim the app while a dialog is open and undim once it closes", async () => {
    // Arrange
    const { isOpen } = mountDialog(true);

    // Assert
    expect(classes.has(DIALOG_OPEN_CLASS)).toBe(true);

    // Act
    isOpen.value = false;
    await flush();

    // Assert
    expect(classes.has(DIALOG_OPEN_CLASS)).toBe(false);
  });

  it("should stay dimmed until every open dialog has closed", async () => {
    // Arrange
    const settings = mountDialog(true);
    const confirm = mountDialog(true);

    // Act
    confirm.isOpen.value = false;
    await flush();

    // Assert
    expect(classes.has(DIALOG_OPEN_CLASS)).toBe(true);

    // Act
    settings.isOpen.value = false;
    await flush();

    // Assert
    expect(classes.has(DIALOG_OPEN_CLASS)).toBe(false);
  });

  it("should undim when an open dialog is unmounted", () => {
    // Arrange
    const { scope } = mountDialog(true);

    // Act
    scope.stop();

    // Assert
    expect(classes.has(DIALOG_OPEN_CLASS)).toBe(false);
  });

  it("should not dim for a dialog that is mounted closed", () => {
    // Act
    mountDialog(false);

    // Assert
    expect(classes.has(DIALOG_OPEN_CLASS)).toBe(false);
  });
});
