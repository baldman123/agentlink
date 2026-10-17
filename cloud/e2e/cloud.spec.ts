import { expect, test, type Page } from "@playwright/test";
import { callRow, messageRow, MockCloud, OWNER } from "./mock.ts";

let cloud: MockCloud;

test.beforeEach(async ({ context, page, baseURL }) => {
  cloud = new MockCloud(context, baseURL!);
  await cloud.install(page);
});

async function openApp(page: Page) {
  await cloud.signIn();
  await page.goto("/");
  await expect(page.locator(".topbar .who")).toContainText(`signed in as ${OWNER}`);
}

/** The form's own error line (Next adds a second role="alert", its route announcer). */
const formError = (page: Page) => page.locator(".form-error");

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("sign-in gate", () => {
  test("nothing but the sign-in page without a session", async ({ page }) => {
    for (const path of ["/", "/admin", "/?view=terminals"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole("heading", { name: "Sign in with your access code" })).toBeVisible();
    }
    await expect(page.locator(".app")).toHaveCount(0);
    expect(cloud.calls.filter((c) => !c.endsWith("/api/config"))).toEqual([]); // the login page asks the API for nothing
  });

  test("a wrong code says so; the right one opens the app", async ({ page }) => {
    await page.goto("/login");
    const code = page.getByLabel("Access code");
    await expect(code).toHaveAttribute("type", "password");
    await code.fill("alc_wrong");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(formError(page)).toHaveText("That code doesn't work. Check it and try again.");
    await expect(code).toHaveAttribute("aria-invalid", "true");

    await page.getByLabel("Show code").check();
    await expect(code).toHaveAttribute("type", "text");
    await code.fill("alc_master");
    await code.press("Enter");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator(".topbar .who")).toContainText(`signed in as ${OWNER}`);
  });

  test("rate limited and revoked codes get plain answers", async ({ page }) => {
    await page.goto("/login");
    cloud.loginStatus = { status: 429, body: { error: "rate_limited", retry_after_s: 600 } };
    await page.getByLabel("Access code").fill("alc_x");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(formError(page)).toHaveText("Too many tries. Wait 10 minutes and try again.");
    cloud.loginStatus = { status: 403, body: { error: "revoked" } };
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(formError(page)).toHaveText("This code was turned off. Ask Bryant for a new one.");
  });

  test("sign out clears the session and returns to sign-in", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(cloud.calls).toContain("POST /api/auth/logout");
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("a revoke pushed over Realtime signs the page out", async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => window.__rt!.revoke());
    await expect(page).toHaveURL(/\/login\?reason=revoked$/);
    await expect(formError(page)).toContainText("Your access was turned off or replaced");
  });
});

test.describe("the app", () => {
  test("boss chat: send, then the boss's answer arrives live", async ({ page }) => {
    await openApp(page);
    const panel = page.locator(".bosspanel");
    await expect(panel).toBeVisible();
    await panel.getByLabel("Message the boss").fill("status of the login page?");
    await panel.getByLabel("Message the boss").press("Enter");
    await expect.poll(() => cloud.sent.length).toBe(1);
    expect(cloud.sent[0]).toMatchObject({ to: `${OWNER}/orchestrator`, type: "chat", body: "status of the login page?", from_agent: "human" });
    await expect(panel).toContainText("status of the login page?");
    await expect(panel.locator(".boss-wait")).toBeVisible();

    const asked = cloud.messages[0];
    const answer = messageRow({ id: "a1", from: `${OWNER}/orchestrator`, to: `${OWNER}/human`, type: "result", body: "Worker 1 is **halfway** there.", reply_to: asked.id });
    cloud.messages.push(answer);
    await page.evaluate((r) => window.__rt!.db({ table: "messages", type: "INSERT", row: r }), answer);
    await expect(panel).toContainText("Worker 1 is halfway there.");
    await expect(panel.locator(".boss-wait")).toHaveCount(0);
  });

  test("teams, sessions and presence follow Realtime", async ({ page }) => {
    await openApp(page);
    await page.getByRole("tab", { name: "Team" }).first().click();
    await expect(page.locator(".center")).toContainText("sam");
    await expect(page.locator(".topbar .who")).toContainText("your laptop is connected");

    // a session row changes
    await page.evaluate(() =>
      window.__rt!.db({ table: "sessions", type: "UPDATE", row: { address: "sam/worker-2", username: "sam", agent: "worker-2", kind: "worker", status: "working", task: "write the docs", last_activity: new Date().toISOString(), last_heartbeat: new Date().toISOString() } }),
    );
    await expect(page.locator(".center")).toContainText("write the docs");

    // my daemon leaves presence: the header says so
    await page.evaluate(() => window.__rt!.presence([{ user: "sam", kind: "daemon" }, { user: "bryant", kind: "web" }]));
    await expect(page.locator(".topbar .who")).toContainText("your laptop isn't connected");
  });

  test("terminals: live screen, and typing into my own pane", async ({ page }) => {
    await openApp(page);
    await page.getByRole("tab", { name: "Terminals" }).first().click();
    await expect(page.locator(".cmdbar")).toBeVisible(); // the team-wide command bar
    await expect.poll(() => page.evaluate(() => window.__rt!.watching)).toContain(`${OWNER}/worker-1`);

    await page.evaluate(() =>
      window.__rt!.screen("screen", { address: "bryant/worker-1", at: new Date().toISOString(), screen: { agent: "worker-1", text: "\u001b[32m✓\u001b[0m 12 tests passed", cols: 100, rows: 30, busy: false } }),
    );
    const pane = page.locator(".tpane-tl");
    await expect(pane).toContainText("12 tests passed");

    await pane.click();
    const box = page.getByLabel("Text to type into worker 1");
    await expect(box).toBeVisible();
    await box.fill("run the e2e suite");
    await box.press("Enter");
    await expect.poll(() => cloud.inputs.length).toBe(1);
    expect(cloud.inputs[0].body).toEqual({ agents: ["worker-1"], text: "run the e2e suite", submit: true });
    expect(cloud.inputs[0].headers["x-agentlink-input"]).toBe("1");
    await expect(page.locator(".tzoom .rchip-ok")).toContainText("sent");

    // another person's pane: no typing box
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: /^sam/ }).click();
    await page.locator(".tpane-tl").click();
    await expect(page.locator(".tzoom")).toBeVisible();
    await expect(page.locator(".tzoom .tinput")).toHaveCount(0);
  });

  test("the command bar types into the checked panes", async ({ page }) => {
    await openApp(page);
    await page.getByRole("tab", { name: "Terminals" }).first().click();
    await page.getByLabel("Text to type into the checked panes").fill("git status");
    await page.getByLabel("Text to type into the checked panes").press("Enter");
    await expect.poll(() => cloud.inputs.length).toBe(1);
    expect(cloud.inputs[0].body).toMatchObject({ agents: ["orchestrator", "worker-1", "worker-2", "worker-3", "worker-4"], text: "git status" });
  });

  test("no People link for someone who isn't the owner", async ({ page }) => {
    cloud.me = { user: "sam", owner: false };
    await cloud.signIn();
    await page.goto("/");
    await expect(page.locator(".topbar .who")).toContainText("signed in as sam");
    await expect(page.getByRole("link", { name: "People" })).toHaveCount(0);
  });
});

test.describe("admin", () => {
  test("make a code, see it once, copy it", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openApp(page);
    await page.getByRole("link", { name: "People" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByTestId("person-sam")).toContainText("online now");
    await expect(page.getByTestId("person-lee")).toContainText("last seen 3 h ago");
    await expect(page.getByTestId(`person-${OWNER}`)).toContainText("owner");

    await page.getByLabel("Name").fill("Kai");
    await page.getByRole("button", { name: "Create code" }).click();
    const code = page.getByTestId("new-code");
    await expect(code).toHaveText(/^alc_kai_/);
    await page.getByRole("button", { name: "Copy" }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await code.textContent());
    await expect(page.getByTestId("person-kai")).toContainText("hasn't signed in yet");

    await page.getByRole("button", { name: "Done" }).click();
    await expect(code).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("person-kai")).toBeVisible();
    await expect(page.getByTestId("new-code")).toHaveCount(0); // shown once only
  });

  test("names are checked, and a second code for someone asks first", async ({ page }) => {
    await openApp(page);
    await page.goto("/admin");
    await page.getByLabel("Name").fill("bad name!");
    await expect(page.getByRole("button", { name: "Create code" })).toBeDisabled();
    await expect(formError(page)).toContainText("Lowercase letters");
    await page.getByLabel("Name").fill("sam");
    await page.getByRole("button", { name: "Make a new code" }).click();
    await expect(page.getByRole("alertdialog")).toContainText("sam's current code stops working");
    await page.getByRole("button", { name: "Make new code" }).click();
    await expect(page.getByTestId("new-code")).toHaveText(/^alc_sam_/);
    await expect(page.locator(".reveal")).toContainText("their old code no longer works");
  });

  test("revoke asks, then turns the person off", async ({ page }) => {
    await openApp(page);
    await page.goto("/admin");
    await page.getByTestId("person-sam").getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByRole("alertdialog")).toContainText("Revoke sam?");
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByTestId("person-sam")).toContainText("turned off");
    expect(cloud.calls).toContain("POST /api/admin/people/sam/revoke");
    await expect(page.getByTestId("person-sam").getByRole("button", { name: "New code" })).toBeVisible();
  });

  test("someone who isn't the owner sees no people", async ({ page }) => {
    cloud.me = { user: "sam", owner: false };
    await cloud.signIn();
    await page.goto("/admin");
    await expect(page.getByText("Only Bryant manages people.")).toBeVisible();
    await expect(page.locator(".people")).toHaveCount(0);
    expect(cloud.calls).not.toContain("GET /api/admin/people");
  });
});

test.describe("your calls", () => {
  const DELETE_BUILD = {
    id: "0jww8",
    summary: "Let worker 2 delete the old build folder?",
    why: "It frees 2 GB; the folder is rebuilt on the next deploy.",
    details: "rm -rf ~/agentlink/cloud/.next-old",
    from: "quarter 2",
    minsAgo: 3,
  };
  /** The panel polls every 5s and on focus; a focus event makes it fetch now. */
  const refetch = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("focus")));

  test("nothing waiting: no badge, and the panel says so", async ({ page }) => {
    await openApp(page);
    await expect(page.getByTestId("calls-btn")).toHaveAccessibleName("Your calls");
    await expect(page.locator(".calls-badge")).toHaveCount(0);
    await page.getByTestId("calls-btn").click();
    await expect(page.getByRole("heading", { name: "Your calls" })).toBeVisible();
    await expect(page.getByTestId("calls-empty")).toContainText("Nothing needs you right now.");
    await page.locator(".calls").getByRole("button", { name: "Close" }).click();
    await expect(page.locator(".calls")).toHaveCount(0);
  });

  test("a pending call: question first, why, details folded; Yes sends, then it's answered and leaves", async ({ page }) => {
    cloud.yourCalls = [callRow(DELETE_BUILD), callRow({ id: "1abcd", summary: "Push the login fix to the shared branch?", minsAgo: 1 })];
    await openApp(page);
    await expect(page.getByTestId("calls-btn")).toHaveAccessibleName("Your calls, 2 waiting");
    await expect(page.getByTestId("calls-btn").locator(".calls-badge")).toHaveText("2");
    await expect(page).toHaveTitle(/^\(2\) /);
    await page.getByTestId("calls-btn").click();

    const card = page.getByTestId("call-0jww8");
    await expect(page.locator(".call").first()).toHaveAttribute("data-testid", "call-0jww8"); // oldest first
    await expect(card.getByRole("heading", { level: 3 })).toHaveText("Let worker 2 delete the old build folder?");
    await expect(card).toContainText("It frees 2 GB");
    await expect(card).toContainText("Quarter 2 asks");
    await expect(card).toContainText("3 min ago");
    await expect(card.getByText("rm -rf ~/agentlink/cloud/.next-old")).toBeHidden();
    await card.getByText("Details").click();
    await expect(card.getByText("rm -rf ~/agentlink/cloud/.next-old")).toBeVisible();

    await card.getByLabel("Note (optional)").fill("keep the logs");
    await card.getByRole("button", { name: "Yes" }).click();
    await expect(card.getByRole("status")).toContainText("You said Yes. Sending to your laptop");
    await expect(card.getByRole("button", { name: "Yes" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "No" })).toBeDisabled();
    expect(cloud.answers).toEqual([{ id: "0jww8", body: { choice: "yes", note: "keep the logs" } }]);
    await expect(page.getByTestId("calls-btn").locator(".calls-badge")).toHaveText("1");

    // the laptop delivers it: the row leaves the list, the card says answered, then disappears
    cloud.yourCalls = cloud.yourCalls.filter((c) => c.id !== "0jww8");
    await refetch(page);
    await expect(card.getByRole("status")).toContainText("Answered Yes");
    await expect(card).toHaveCount(0, { timeout: 8_000 });
    await expect(page.getByTestId("call-1abcd")).toBeVisible();
  });

  test("an open question gets only an answer box; a yes/no question gets Yes and No too", async ({ page }) => {
    cloud.yourCalls = [
      callRow({ id: "q07579", kind: "question", summary: "Which port should the dev server use?", details: "3000 or 3137", minsAgo: 3 }),
      callRow({ id: "q11111", kind: "question", summary: "Should the sim reuse yesterday's database?", minsAgo: 2 }),
      callRow({ id: "q22222", kind: "question", summary: "Keep the old logs (yes/no)", minsAgo: 1 }),
    ];
    await cloud.signIn();
    await page.goto("/?view=calls");
    for (const id of ["q11111", "q22222"]) {
      const yn = page.getByTestId(`call-${id}`);
      await expect(yn.getByRole("button", { name: "Yes" })).toBeVisible();
      await expect(yn.getByRole("button", { name: "No" })).toBeVisible();
      await expect(yn.getByLabel("Your answer or a note")).toBeVisible();
    }

    const card = page.getByTestId("call-q07579");
    await expect(card.getByText("question", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Yes" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "No" })).toHaveCount(0);
    const send = card.getByRole("button", { name: "Send" });
    await expect(send).toHaveClass(/btn-primary/);
    await expect(send).toBeDisabled();
    await card.getByLabel("Your answer", { exact: true }).fill("3137, 3000 is taken");
    await send.click();
    await expect(card.getByRole("status")).toContainText("Answer saved. Sending to your laptop");
    await expect(card).toContainText("Your answer: 3137, 3000 is taken");
    expect(cloud.answers).toEqual([{ id: "q07579", body: { note: "3137, 3000 is taken" } }]);
  });

  test("answered elsewhere, and a failed send can be retried", async ({ page }) => {
    cloud.yourCalls = [callRow(DELETE_BUILD), callRow({ id: "2wxyz", summary: "Restart the scoring laptop?" })];
    await cloud.signIn();
    await page.goto("/?view=calls");

    cloud.answerStatus = { status: 500, body: { error: "internal" } };
    const card = page.getByTestId("call-2wxyz");
    await card.getByRole("button", { name: "No" }).click();
    await expect(card.locator(".form-error")).toHaveText("Couldn't send your answer. Check your connection and try again.");
    await expect(card.getByRole("button", { name: "No" })).toBeEnabled();

    // meanwhile it was answered on the boss circle: the server refuses, and stops listing it
    cloud.answerStatus = { status: 409, body: { error: "already_answered" } };
    cloud.yourCalls = cloud.yourCalls.filter((c) => c.id !== "2wxyz");
    await card.getByRole("button", { name: "No" }).click();
    await expect(card.getByRole("status")).toContainText("Already answered somewhere else");
    await expect(card).toHaveCount(0, { timeout: 8_000 });

    // answered on the boss circle: the row just leaves the list
    cloud.yourCalls = [];
    await refetch(page);
    await expect(page.getByTestId("call-0jww8").getByRole("status")).toContainText("Already answered somewhere else");
    await expect(page.getByTestId("calls-empty")).toBeVisible({ timeout: 8_000 });
  });
});

test.describe("phone @phone", () => {
  test("sign-in fits the screen @phone", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByLabel("Access code")).toBeVisible();
    await noHorizontalScroll(page);
    await page.screenshot({ path: "e2e/screenshots/phone-login.png" });
  });

  test("the app opens on the boss, with tabs for the rest @phone", async ({ page }) => {
    await openApp(page); // the "who" line is hidden on phones, but its text is there
    await expect(page.locator(".bosspanel")).toBeVisible();
    await expect(page.locator(".chatlist")).toBeHidden();
    await noHorizontalScroll(page);
    await page.screenshot({ path: "e2e/screenshots/phone-boss.png" });

    await page.locator(".mtabs").getByRole("tab", { name: /Chats/ }).click();
    await expect(page.locator(".chatlist")).toBeVisible();
    await expect(page.locator(".bosspanel")).toBeHidden();

    await page.locator(".mtabs").getByRole("tab", { name: /Chat$|Team|Terminals/ }).click();
    await page.locator(".center").getByRole("tab", { name: "Terminals" }).click();
    await expect(page.locator(".cmdbar")).toBeVisible();
    await noHorizontalScroll(page);
    await page.screenshot({ path: "e2e/screenshots/phone-terminals.png" });
  });

  test("your calls has its own tab with a badge @phone", async ({ page }) => {
    cloud.yourCalls = [
      callRow({ id: "0jww8", summary: "Let worker 2 delete the old build folder?", why: "It frees 2 GB.", details: "rm -rf ~/agentlink/cloud/.next-old-" + "x".repeat(120), from: "quarter 2" }),
    ];
    await openApp(page);
    const tab = page.locator(".mtabs").getByRole("tab", { name: "Calls, 1 waiting" });
    await expect(tab.locator(".calls-badge")).toHaveText("1");
    await tab.click();
    const card = page.getByTestId("call-0jww8");
    await expect(card).toBeVisible();
    await card.getByText("Details").click();
    await noHorizontalScroll(page);
    for (const b of [card.getByRole("button", { name: "Yes" }), card.getByRole("button", { name: "No" }), page.getByTestId("calls-btn"), tab]) {
      const box = (await b.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(40);
      expect(box.width).toBeGreaterThanOrEqual(40);
    }
    const box = (await card.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.screenshot({ path: "e2e/screenshots/phone-calls.png" });
    await card.getByRole("button", { name: "Yes" }).click();
    await expect(card.getByRole("status")).toContainText("Sending to your laptop");
  });

  test("admin works on a phone @phone", async ({ page }) => {
    await cloud.signIn();
    await page.goto("/admin");
    await expect(page.getByTestId("person-sam")).toBeVisible();
    await noHorizontalScroll(page);
    await page.screenshot({ path: "e2e/screenshots/phone-admin.png" });
  });
});
