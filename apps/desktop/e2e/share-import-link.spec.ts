import { test, expect, type Page } from "@playwright/test";

// share and import links live in Settings → Data
async function openLinkDialog(page: Page, testId: "share-dialog-btn" | "import-dialog-btn") {
  await page.getByTestId("settings-btn").click();
  await page.getByRole("tab", { name: "Data" }).click();
  await page.getByTestId(testId).click();
  // Settings fades out while the link dialog opens; wait so only one dialog is on screen
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
}

test.describe("Share and Import Link E2E Test", () => {
  test.beforeEach(async ({ page }) => {
    // Arrange: clean persistent state and mark onboarding as complete
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem("locale", "en");
      localStorage.setItem("preferences.onboardingCompleted", "true");
      localStorage.setItem("preferences.sidebarOpen", "true");
    });
    // Reload to apply localStorage changes
    await page.reload();
  });

  test("share link: generates link with streams -> copy link works", async ({ page, context }) => {
    // Arrange: grant clipboard permissions
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    // Arrange: add a stream first
    await page.getByTestId("add-stream-btn").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByTestId("platform-kick").click();
    await page.getByTestId("channel-input").fill("xqc");
    await page.getByTestId("add-submit-btn").click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByTestId("stream-item-xqc")).toBeVisible();

    // Act: open share dialog
    await openLinkDialog(page, "share-dialog-btn");
    await expect(page.getByRole("dialog")).toBeVisible();

    // Assert: share link input contains the stream
    const shareLinkInput = page.getByTestId("share-link-input");
    await expect(shareLinkInput).toBeVisible();
    const shareLink = await shareLinkInput.inputValue();
    expect(shareLink).toContain("xqc");
    expect(shareLink).toContain("kick");

    // Act: click copy button
    await page.getByTestId("copy-link-btn").click();

    // Assert: link is copied to clipboard
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe(shareLink);

    // Cleanup: dialog should close after copy
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("share link: no streams -> shows warning message in input and doesn't copy/close", async ({
    page,
  }) => {
    // Act: open share dialog when no streams are selected
    await openLinkDialog(page, "share-dialog-btn");
    await expect(page.getByRole("dialog")).toBeVisible();

    // Assert: share link input displays warning message
    const shareLinkInput = page.getByTestId("share-link-input");
    await expect(shareLinkInput).toBeVisible();
    const shareLink = await shareLinkInput.inputValue();
    expect(shareLink).toBe("No streams to share");

    // Act: click copy button (it should show toast and do nothing)
    await page.getByTestId("copy-link-btn").click();

    // Assert: dialog remains open since copy was prevented
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("import link: imports valid link -> streams appear in grid", async ({ page }) => {
    // Act: open import dialog and submit a valid link
    await openLinkDialog(page, "import-dialog-btn");
    await expect(page.getByRole("dialog")).toBeVisible();

    const importLink = "https://multistreams-pi.vercel.app/?streams=kick:xqc,twitch:shroud";
    await page.getByTestId("import-link-input").fill(importLink);
    await page.getByTestId("import-submit-btn").click();

    // Assert: streams appear in grid and dialog closes
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByTestId("stream-item-xqc")).toBeVisible();
    await expect(page.getByTestId("stream-item-shroud")).toBeVisible();
    await expect(page.getByTestId("empty-state")).not.toBeVisible();
  });

  test("import link: imports invalid link -> shows error and keeps dialog open", async ({
    page,
  }) => {
    // Act: open import dialog
    await openLinkDialog(page, "import-dialog-btn");
    await expect(page.getByRole("dialog")).toBeVisible();

    // Act: fill and submit invalid link
    const invalidLink = "https://example.com/not-a-valid-share-link";
    await page.getByTestId("import-link-input").fill(invalidLink);
    await page.getByTestId("import-submit-btn").click();

    // Assert: dialog remains open and no streams are added to grid
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByTestId("empty-state")).toBeVisible();
  });

  test("import link: imports custom streams -> custom streams appear in grid", async ({ page }) => {
    // Act: open import dialog
    await openLinkDialog(page, "import-dialog-btn");
    await expect(page.getByRole("dialog")).toBeVisible();

    // Act: fill and submit link containing custom base64 encoded stream
    const importLink =
      "https://multistreams-pi.vercel.app/?streams=twitch:shroud&c=W3sibiI6IkN1c3RvbSBHb29nbGUiLCJ1IjoiaHR0cHM6Ly93d3cuZ29vZ2xlLmNvbSJ9XQ==";
    await page.getByTestId("import-link-input").fill(importLink);
    await page.getByTestId("import-submit-btn").click();

    // Assert: streams appear in grid and dialog closes
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByTestId("stream-item-shroud")).toBeVisible();
    await expect(page.getByTestId("stream-item-Custom Google")).toBeVisible();
    await expect(page.getByTestId("empty-state")).not.toBeVisible();
  });
});
