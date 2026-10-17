// The composers' files (contracts/uploads.md): the paperclip, pasting a screenshot, dropping files, the ✕, errors,
// and what each composer sends. Mock mode: the mock transport "uploads" with progress and records what was sent.
import { expect, test, type Locator, type Page } from "@playwright/test";

type MockApi = { uploads: { id: string; name: string; path: string }[]; deletedUploads: string[]; paneTexts: string[] };
const mock = (page: Page) => page.evaluate(() => (window as unknown as { __mock: MockApi }).__mock);

const files = [
  { name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 test") },
  { name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(300_000, 1) },
  { name: "tool.jar", mimeType: "application/java-archive", buffer: Buffer.from("PK..") },
];

/** Builds a DataTransfer holding files inside the page, for paste and drop events. */
async function dataTransfer(page: Page, list: { name: string; type: string; text?: string }[], plain?: string) {
  return page.evaluateHandle(
    ({ list, plain }) => {
      const dt = new DataTransfer();
      for (const f of list) dt.items.add(new File([f.text ?? "x".repeat(2048)], f.name, { type: f.type }));
      if (plain) dt.setData("text/plain", plain);
      return dt;
    },
    { list, plain },
  );
}

async function openChat(page: Page) {
  await page.goto("/?mock=1");
  const box = page.locator(".composer textarea");
  if (!(await box.isVisible().catch(() => false))) await page.locator(".chatlist button, .chatlist a, [role=listitem] button").first().click();
  await expect(box).toBeVisible();
  return page.locator(".composer");
}

const chips = (scope: Locator) => scope.locator(".att-chip");

test("paperclip: several files of any type upload with progress, then send with the message", async ({ page }) => {
  const composer = await openChat(page);
  await composer.locator("[data-testid=attach-input]").setInputFiles(files);
  await expect(chips(composer)).toHaveCount(3);
  for (const f of files) await expect(composer.locator(".att-chip", { hasText: f.name })).toBeVisible();
  await expect(composer.locator(".att-chip .att-size").first()).toHaveText(/B$/);
  await expect(composer.locator(".att-uploading")).toHaveCount(0); // all three finished
  // files alone are enough to send
  const send = composer.getByRole("button", { name: "Send" });
  await expect(send).toBeEnabled();
  await composer.locator("textarea").fill("three files");
  await send.click();
  await expect(chips(composer)).toHaveCount(0);
  const sent = page.locator(".msg", { hasText: "three files" }).last();
  for (const f of files) await expect(sent.locator(".msg-files", { hasText: f.name })).toBeVisible();
  expect((await mock(page)).uploads.map((u) => u.name)).toEqual(files.map((f) => f.name));
});

test("pasting a screenshot attaches it; pasting text still pastes text", async ({ page }) => {
  const composer = await openChat(page);
  const box = composer.locator("textarea");
  const shot = await dataTransfer(page, [{ name: "image.png", type: "image/png" }]);
  const prevented = await box.evaluate((el, dt) => {
    const e = new ClipboardEvent("paste", { clipboardData: dt as DataTransfer, bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  }, shot);
  expect(prevented).toBe(true);
  await expect(composer.locator(".att-chip", { hasText: /^screenshot-\d{4}-\d{2}-\d{2}-\d{6}\.png/ })).toBeVisible();

  const text = await dataTransfer(page, [], "plain words");
  const textPrevented = await box.evaluate((el, dt) => {
    const e = new ClipboardEvent("paste", { clipboardData: dt as DataTransfer, bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  }, text);
  expect(textPrevented).toBe(false); // the browser's own text paste goes ahead
  await expect(chips(composer)).toHaveCount(1);

  // a spreadsheet copy carries text and a picture of it: the text wins
  const sheet = await dataTransfer(page, [{ name: "image.png", type: "image/png" }], "a\tb\n1\t2");
  expect(await box.evaluate((el, dt) => {
    const e = new ClipboardEvent("paste", { clipboardData: dt as DataTransfer, bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  }, sheet)).toBe(false);
  await expect(chips(composer)).toHaveCount(1);
});

test("dropping files on the composer attaches them; ✕ removes one", async ({ page }) => {
  const composer = await openChat(page);
  const dt = await dataTransfer(page, [
    { name: "archive.zip", type: "application/zip" },
    { name: "song.mp3", type: "audio/mpeg" },
  ]);
  await composer.dispatchEvent("dragenter", { dataTransfer: dt });
  await expect(composer.locator(".drop-hint")).toBeVisible();
  await composer.dispatchEvent("dragover", { dataTransfer: dt });
  await composer.dispatchEvent("drop", { dataTransfer: dt });
  await expect(composer.locator(".drop-hint")).toHaveCount(0);
  await expect(chips(composer)).toHaveCount(2);
  await expect(composer.locator(".att-uploading")).toHaveCount(0);
  await composer.getByRole("button", { name: "Remove archive.zip" }).click();
  await expect(chips(composer)).toHaveCount(1);
  await expect(composer.locator(".att-chip", { hasText: "song.mp3" })).toBeVisible();
  const m = await mock(page);
  const zip = m.uploads.find((u) => u.name === "archive.zip");
  expect(zip && m.deletedUploads.includes(zip.id)).toBeTruthy();
});

test("a failed upload shows its error and blocks sending until removed", async ({ page }) => {
  await page.goto("/?mock=1&mockupload=fail");
  const composer = page.locator(".composer");
  if (!(await composer.locator("textarea").isVisible().catch(() => false))) await page.locator(".chatlist button, .chatlist a, [role=listitem] button").first().click();
  await composer.locator("[data-testid=attach-input]").setInputFiles(files[0]);
  await expect(composer.locator(".att-chip.att-bad .att-err")).toContainText("upload failed");
  await composer.locator("textarea").fill("text too");
  await expect(composer.getByRole("button", { name: "Send" })).toBeDisabled();
  await expect(composer.locator(".att-hint")).toHaveText("Remove the files that didn't upload.");
  await composer.getByRole("button", { name: "Remove notes.pdf" }).click();
  await expect(composer.getByRole("button", { name: "Send" })).toBeEnabled();
});

test("the boss panel sends files to the boss", async ({ page }) => {
  await page.goto("/?mock=1&mockboss=off");
  const bp = page.locator(".bp-composer");
  await expect(bp).toBeVisible();
  await bp.locator("[data-testid=attach-input]").setInputFiles(files[0]);
  await expect(bp.locator(".att-chip", { hasText: "notes.pdf" })).toBeVisible();
  await expect(bp.locator(".att-uploading")).toHaveCount(0);
  await bp.getByRole("button", { name: "Send" }).click();
  await expect(bp.locator(".att-chip")).toHaveCount(0);
  await expect(page.locator(".bosspanel .msg-files", { hasText: "notes.pdf" })).toBeVisible();
});

test("the command bar types each file's path into the panes", async ({ page }) => {
  await page.goto("/?mock=1&view=terminals");
  const bar = page.locator(".cmdbar");
  await expect(bar).toBeVisible();
  await bar.locator("[data-testid=attach-input]").setInputFiles(files[0]);
  await expect(bar.locator(".att-chip", { hasText: "notes.pdf" })).toBeVisible();
  await expect(bar.locator(".att-uploading")).toHaveCount(0);
  await bar.locator("input[aria-label^='Text to type']").fill("read this");
  await bar.getByRole("button", { name: /Send/ }).click();
  await expect.poll(async () => (await mock(page)).paneTexts.at(-1) ?? "").toMatch(/^read this \[attached: \/mock\/agentlink\/data\/uploads\/\d{4}-\d{2}-\d{2}\/notes\.pdf\]$/);
  await expect(bar.locator(".att-chip")).toHaveCount(0);
});
