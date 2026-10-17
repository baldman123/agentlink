// Real end-to-end run of the website against a LOCAL Supabase: next dev, two daemons in cloud mode
// (scripts/team-up.sh, AGENTLINK_HUB_MODE=cloud) with fake `cat` claude4 teams on a private tmux server,
// and a real Chrome driving the pages. Never touches the real claude4 sessions or the live 7700/7701/7780.
//
//   npx tsx cloud/e2e/live-e2e.ts        (LIVE_PORT web, default 3141; LIVE_DAEMON_BASE default 7761)
// Needs a local Supabase (supabase start) with cloud/.env.local pointing at it. The run uses its own owner
// (alex) and a random master code, set as env so they override .env.local.
//
// Prints PASS/FAIL per check, always tears down, exits non-zero on any failure.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const CLOUD = path.join(ROOT, "cloud");
const WEB_PORT = Number(process.env.LIVE_PORT ?? 3141);
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const DBASE = Number(process.env.LIVE_DAEMON_BASE ?? 7761);
const USERS = ["alex", "sam"] as const;
type User = (typeof USERS)[number];
const PORT: Record<User, number> = { alex: DBASE, sam: DBASE + 1 };
const OWNER: User = "alex";
// The second person gets a fresh name each run: the local database outlives runs (and other workers share it).
const NAME: Record<User, string> = { alex: "alex", sam: `sam${randomBytes(2).toString("hex")}` };
const SAM = NAME.sam;
const RUN = randomBytes(3).toString("hex");
const MASTER = `master-${randomBytes(12).toString("hex")}`;
const codes: Record<User, string> = { alex: MASTER, sam: "" };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-cloud-live-"));
const SOCKET = "c4cloud";
const session = (u: User) => `c4cloud-${u}`;
const dataDir = (u: User) => path.join(TMP, u);
const c4Dir = (u: User) => path.join(TMP, "claude4", session(u));
const panes: Record<User, Record<number, string>> = { alex: {}, sam: {} };
const SHOTS = path.join(CLOUD, "e2e", "screenshots");

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  const d = detail === undefined ? undefined : typeof detail === "string" ? detail : JSON.stringify(detail);
  results.push({ name, ok, detail: d });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && d ? `\n        ${d.slice(0, 700)}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last: ${(last as Error).message ?? last})` : ""}`);
}
async function step(name: string, fn: () => Promise<void>) {
  console.log(`\n== ${name}`);
  try {
    await fn();
  } catch (err) {
    check(`${name}: ${(err as Error).message.split("\n")[0]}`, false, (err as Error).message);
  }
}

// ---------------------------------------------------------------- helpers
const tmux = async (...args: string[]) => (await run("tmux", ["-L", SOCKET, ...args])).stdout;
const screen = (u: User, slot: number) => tmux("capture-pane", "-p", "-J", "-S", "-3000", "-t", panes[u][slot]);

async function daemon(u: User, method: string, p: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${PORT[u]}${p}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** The orchestrator CLI as a team's boss runs it (bin/agentlink reads the user and port from the data dir). */
const cli = (u: User, ...args: string[]) =>
  run(path.join(ROOT, "bin", "agentlink"), args, { env: { ...process.env, AGENTLINK_DATA_DIR: dataDir(u), AGENTLINK_AGENT: "orchestrator" }, timeout: 20_000 });

async function makeFakeTeam(u: User) {
  const s = session(u);
  await tmux("kill-session", "-t", s).catch(() => {});
  await tmux("new-session", "-d", "-s", s, "-x", "160", "-y", "40", "cat > /dev/null");
  for (let i = 0; i < 4; i++) await tmux("new-window", "-d", "-t", `${s}:`, "cat > /dev/null");
  const ids = (await tmux("list-panes", "-s", "-t", s, "-F", "#{pane_id}")).trim().split("\n");
  const slots = [1, 2, 3, 4, 0];
  slots.forEach((slot, i) => (panes[u][slot] = ids[i]));
  fs.mkdirSync(c4Dir(u), { recursive: true });
  fs.writeFileSync(path.join(c4Dir(u), "panes"), slots.map((slot, i) => `${slot} ${ids[i]}`).join("\n") + "\n");
  for (const slot of slots) {
    const p = panes[u][slot];
    await tmux("set", "-p", "-t", p, "@role", slot === 0 ? "orchestrator" : "worker");
    await tmux("set", "-p", "-t", p, "@state", slot === 0 ? "idle" : "working");
    if (slot !== 0) await tmux("set", "-p", "-t", p, "@task", `${u} task ${slot}`);
  }
}

async function teamUp(u: User) {
  const r = await run(
    path.join(ROOT, "scripts", "team-up.sh"),
    ["--user", NAME[u], "--hub-url", WEB, "--daemon-port", String(PORT[u]), "--c4-session", session(u), "--no-ui", "--share-screens"],
    {
      env: { ...process.env, AGENTLINK_HUB_MODE: "cloud", AGENTLINK_DATA_DIR: dataDir(u), AGENTLINK_TOKEN: codes[u], C4_TMUX_SOCKET: SOCKET, C4_STATE_DIR: c4Dir(u) },
      timeout: 90_000,
    },
  );
  return r.stdout;
}
const teamDown = (u: User) => run(path.join(ROOT, "scripts", "team-down.sh"), [], { env: { ...process.env, AGENTLINK_DATA_DIR: dataDir(u) }, timeout: 30_000 }).catch((e) => e);

let web: ChildProcess | null = null;
const webLog: string[] = [];
async function startWeb() {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENTLINK_OWNER: OWNER,
    AGENTLINK_MASTER_CODE: MASTER,
    AGENTLINK_SESSION_SECRET: randomBytes(32).toString("hex"),
    AGENTLINK_HUB_NAME: "agentlink-live-test",
  };
  // Supabase settings come from cloud/.env.local, which next dev loads itself; variables set here win over it.
  web = spawn("npx", ["next", "dev", "--hostname", "127.0.0.1", "--port", String(WEB_PORT)], { cwd: CLOUD, env, stdio: ["ignore", "pipe", "pipe"] });
  web.stdout!.on("data", (d) => webLog.push(String(d)));
  web.stderr!.on("data", (d) => webLog.push(String(d)));
  await until("the website to answer /api/health", async () => (await fetch(`${WEB}/api/health`)).ok, 90_000).catch((e) => {
    throw new Error(`${(e as Error).message}\n--- next dev output ---\n${webLog.join("").slice(-3000)}`);
  });
}

async function login(page: Page, code: string) {
  await page.goto(`${WEB}/login`);
  await page.getByLabel("Access code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${WEB}/`);
}
const pageErrors: string[] = [];
function watchErrors(page: Page, who: string) {
  page.on("pageerror", (e) => pageErrors.push(`${who}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && pageErrors.push(`${who} console: ${m.text()}`));
}

// ---------------------------------------------------------------- the run
async function main() {
  console.log(`cloud live e2e: web ${WEB}, daemons alex ${PORT.alex} sam ${PORT.sam}, tmp ${TMP}`);
  for (const p of [WEB_PORT, PORT.alex, PORT.sam]) {
    const busy = await run("lsof", ["-nP", `-iTCP:${p}`, "-sTCP:LISTEN"]).then(() => true, () => false);
    if (busy) throw new Error(`port ${p} is in use`);
  }
  fs.mkdirSync(SHOTS, { recursive: true });
  let browser: Browser | null = null;
  try {
    await startWeb();
    browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? "chrome", headless: process.env.HEADED !== "1" });
    const alexCtx: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await alexCtx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: WEB });
    const alex = await alexCtx.newPage();
    watchErrors(alex, "alex");
    let samCtx: BrowserContext | null = null;
    let samPage: Page | null = null;

    await step("login as owner", async () => {
      await alex.goto(`${WEB}/`);
      check("no session: / redirects to /login", alex.url().startsWith(`${WEB}/login`), alex.url());
      // (the wrong-code message is covered by the mocked suite: every failed login here counts toward the
      // API's per-IP limit of 10 in 15 minutes, shared with anyone else testing on this machine)
      await login(alex, MASTER);
      await alex.locator(".topbar .who", { hasText: "signed in as alex" }).waitFor();
      check("master code signs in as the owner", true);
      check("owner sees the People link", (await alex.getByRole("link", { name: "People" }).count()) === 1);
    });

    await step("admin: make a code for sam", async () => {
      await alex.goto(`${WEB}/admin`);
      await alex.getByLabel("Name").fill(SAM);
      await alex.getByRole("button", { name: "Create code" }).click();
      const code = (await alex.getByTestId("new-code").textContent({ timeout: 10_000 }))?.trim() ?? "";
      codes.sam = code;
      check("a code for sam is shown once (alc_…)", /^alc_[A-Za-z0-9_-]{20,}$/.test(code), code);
      await alex.getByRole("button", { name: "Copy" }).click();
      check("Copy puts it on the clipboard", (await alex.evaluate(() => navigator.clipboard.readText())) === code);
      await alex.getByTestId(`person-${SAM}`).waitFor();
      check("sam is listed (not connected yet)", (await alex.getByTestId(`person-${SAM}`).textContent())?.includes("hasn't signed in yet") ?? false, await alex.getByTestId(`person-${SAM}`).textContent());
      await alex.screenshot({ path: path.join(SHOTS, "live-admin.png") });
    });

    await step("two daemons in cloud mode with fake teams", async () => {
      for (const u of USERS) await makeFakeTeam(u);
      for (const u of USERS) {
        const out = await teamUp(u);
        check(`${u}: team-up.sh (cloud) finished`, !out.includes(codes[u]), "summary printed the code");
      }
      for (const u of USERS) {
        const h = await until(`${u} daemon connected`, async () => {
          const r = await daemon(u, "GET", "/v1/health");
          return r.body?.hub?.state === "connected" ? r.body : null;
        }, 45_000).catch((e) => ({ error: String(e) }));
        check(`${u}: daemon logged in to the website`, (h as { hub?: { state?: string } }).hub?.state === "connected", h);
      }
    });

    await step("both teams visible in the browser", async () => {
      await alex.goto(`${WEB}/?view=team`);
      await alex.locator(".topbar .who", { hasText: "your laptop is connected" }).waitFor({ timeout: 20_000 });
      check("header: alex's laptop is connected (presence)", true);
      const center = alex.locator(".center");
      await until("both teams in the Team view", async () => {
        const t = (await center.textContent()) ?? "";
        return t.includes("alex task 1") && t.includes("sam task 1");
      }, 20_000);
      check("Team view shows alex's and sam's workers with their tasks", true);
      await alex.screenshot({ path: path.join(SHOTS, "live-team.png") });
    });

    await step("boss chat round trip", async () => {
      await alex.goto(`${WEB}/?view=chat`);
      const panel = alex.locator(".bosspanel");
      // alex outlives runs in the shared local database, so this run's texts carry a marker
      const ask = `live test ${RUN}: are you there?`;
      const answer = `yes, the boss is here (live test ${RUN})`;
      await panel.getByLabel("Message the boss").fill(ask);
      await panel.getByLabel("Message the boss").press("Enter");
      await panel.getByText(ask).waitFor({ timeout: 15_000 });
      check("the message shows in the Boss panel (stored, came back over Realtime)", true);
      // your own message only (the boss's answer quotes it, so a plain "article with this text" matches both)
      const asked = panel.locator("article.msg-self", { hasText: ask });
      const marked = await until("this message marked waiting", async () => ((await asked.count()) === 1 && (await asked.locator(".boss-wait").count()) === 1 ? true : null), 8_000).catch(() => false);
      check("...once, and marked 'waiting for the boss'", marked, { articles: await asked.count() });
      const pasted = await until("the message in alex's boss pane", async () => {
        const s = await screen("alex", 0);
        return s.includes(ask) ? s : null;
      }, 30_000);
      check("the bridge pasted it into alex's orchestrator pane, labelled as from the UI", pasted.includes("[agentlink message from you (UI)]"), pasted.slice(-400));
      const id8 = pasted.match(/agentlink reply ([0-9a-f]{8})/)?.[1];
      check("the paste carries a reply id", !!id8, pasted.slice(-400));
      await cli("alex", "reply", id8!, answer);
      await panel.getByText(answer).waitFor({ timeout: 20_000 });
      const replyArticle = panel.locator("article", { hasText: answer });
      check("the boss's `agentlink reply` arrives in the Boss panel live, once", (await replyArticle.count()) === 1);
      check("...shown as a reply to the question (quote)", ((await replyArticle.locator(".quote").textContent()) ?? "").includes(ask.slice(0, 30)));
      const cleared = await until("waiting note gone", async () => ((await asked.locator(".boss-wait").count()) === 0 ? true : null), 8_000).catch(() => false);
      check("'waiting for the boss' clears on the answered message", cleared, await asked.first().innerText().catch(() => "?"));
      await alex.screenshot({ path: path.join(SHOTS, "live-boss.png") });
    });

    await step("live screens", async () => {
      await tmux("send-keys", "-t", panes.sam[1], "-l", "sam screen marker 7731");
      await tmux("send-keys", "-t", panes.alex[1], "-l", "alex screen marker 4412");
      await alex.goto(`${WEB}/?view=terminals`);
      await alex.locator(".tpane-tl", { hasText: "alex screen marker 4412" }).waitFor({ timeout: 25_000 });
      check("alex's worker-1 screen streams into Terminals", true);
      await alex.getByRole("tab", { name: new RegExp(`^${SAM}`) }).click();
      await alex.locator(".tpane-tl", { hasText: "sam screen marker 7731" }).waitFor({ timeout: 25_000 });
      check("sam's worker-1 screen is visible to alex (sam shares)", true);
      await alex.screenshot({ path: path.join(SHOTS, "live-terminals.png") });
    });

    await step("typing into my own pane; not into theirs", async () => {
      // still on sam's team: zooming sam's pane shows no typing box
      await alex.locator(".tpane-tl").click();
      await alex.locator(".tzoom").waitFor();
      check("no typing box on sam's zoomed pane", (await alex.locator(".tzoom .tinput").count()) === 0);
      await alex.keyboard.press("Escape");
      await alex.getByRole("tab", { name: /^alex/ }).click();
      await alex.locator(".tpane-tr").click();
      const box = alex.getByLabel("Text to type into worker 2");
      await box.fill("typed from the website 5531");
      await box.press("Enter");
      await alex.locator(".tzoom .rchip-ok", { hasText: "sent" }).waitFor({ timeout: 20_000 });
      check("the website reports 'sent' for alex/worker-2", true);
      const s = await until("text in alex's worker-2 tmux pane", async () => ((await screen("alex", 2)).includes("typed from the website 5531") ? true : null), 15_000).catch(() => false);
      check("the text arrived in alex's worker-2 tmux pane", !!s, (await screen("alex", 2)).slice(-300));
      let leaked = false;
      for (const slot of [0, 1, 2, 3, 4]) if ((await screen("sam", slot)).includes("typed from the website 5531")) leaked = true;
      check("nothing reached any of sam's panes", !leaked);
      // the API only types into the caller's own team: a request naming sam's agents still lands on alex's team
      const forged = await alex.evaluate(async (sam) => {
        const r = await fetch("/api/panes/input", { method: "POST", headers: { "content-type": "application/json", "x-agentlink-input": "1" }, body: JSON.stringify({ agents: [`${sam}/worker-1`], text: "forged 9090" }) });
        return r.status;
      }, SAM);
      check("a request naming another team's agent is refused (4xx)", forged >= 400 && forged < 500, forged);
      await alex.keyboard.press("Escape");
    });

    await step("cross-team messages", async () => {
      await alex.goto(`${WEB}/?view=chat`);
      await alex.locator(".bosspanel").waitFor();
      await sleep(1_500); // let the Realtime channels join before the message goes out
      await cli("sam", "send", "alex/orchestrator", "chat", "hello alex, from sam's boss (live)");
      const s = await until("sam's message in alex's boss pane", async () => {
        const t = await screen("alex", 0);
        return t.includes("hello alex, from sam's boss (live)") ? t : null;
      }, 30_000).catch(() => "");
      check("sam's boss -> alex's boss is pasted into alex's orchestrator pane", !!s);
      check("...as a remote request (REMOTE banner)", s.includes("REMOTE"), s.slice(-500));
      const wire = await until("the message on alex's 'on the wire' strip", async () => {
        const t = (await alex.locator(".strip").textContent()) ?? "";
        return t.includes(SAM) ? t : null;
      }, 15_000).catch(() => "");
      check("alex's open page shows sam -> alex live on the wire strip", !!wire, await alex.locator(".strip").textContent());
      // the website's own send path (what the chat composer calls), to the other team's boss
      const sent = await alex.evaluate(async (sam) => {
        const r = await fetch("/api/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: `${sam}/orchestrator`, type: "chat", body: "hi sam, from alex on the website (live)" }) });
        return { status: r.status, body: await r.json().catch(() => null) };
      }, SAM);
      check("POST /api/messages from the browser to sam/orchestrator is accepted", sent.status === 200, sent);
      const t = await until("alex's web message in sam's boss pane", async () => {
        const x = await screen("sam", 0);
        return x.includes("hi sam, from alex on the website (live)") ? x : null;
      }, 30_000).catch(() => "");
      check("the website message reaches sam's orchestrator pane, as a remote request", !!t && t.includes("REMOTE"), t.slice(-500));
    });

    await step("sam signs in on the website", async () => {
      samCtx = await browser!.newContext({ viewport: { width: 1280, height: 800 } });
      samPage = await samCtx.newPage();
      watchErrors(samPage, "sam");
      await login(samPage, codes.sam);
      await samPage.locator(".topbar .who", { hasText: `signed in as ${SAM}` }).waitFor();
      check("sam's code signs in as sam", true);
      check("sam (not the owner) has no People link", (await samPage.getByRole("link", { name: "People" }).count()) === 0);
      await samPage.goto(`${WEB}/admin`);
      await samPage.getByText("Only Bryant manages people.").waitFor();
      check("sam's /admin shows no people", true);
      const r = await samPage.evaluate(async () => (await fetch("/api/admin/people")).status);
      check("GET /api/admin/people as sam is 403", r === 403, r);
      await samPage.goto(`${WEB}/`);
    });

    await step("revoke kicks sam", async () => {
      await alex.goto(`${WEB}/admin`);
      await alex.getByTestId(`person-${SAM}`).getByRole("button", { name: "Revoke" }).click();
      await alex.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
      await alex.getByTestId(`person-${SAM}`).getByText("turned off").waitFor({ timeout: 10_000 });
      check("admin shows sam turned off", true);
      await samPage!.waitForURL(/\/login\?reason=revoked/, { timeout: 20_000 }).then(
        () => check("sam's open page is signed out (revoked broadcast)", true),
        () => check("sam's open page is signed out (revoked broadcast)", false, samPage!.url()),
      );
      const h = await until("sam's daemon offline", async () => {
        const r = await daemon("sam", "GET", "/v1/health");
        return r.body?.hub?.state !== "connected" ? r.body : null;
      }, 30_000).catch((e) => ({ error: String(e) }));
      check("sam's daemon goes offline", (h as { hub?: { state?: string } }).hub?.state !== undefined && (h as { hub: { state: string } }).hub.state !== "connected", h);
      await samPage!.goto(`${WEB}/login`);
      await samPage!.getByLabel("Access code").fill(codes.sam);
      await samPage!.getByRole("button", { name: "Sign in" }).click();
      await samPage!.locator(".form-error", { hasText: "turned off" }).waitFor({ timeout: 8_000 }).then(
        () => check("sam's old code no longer signs in", true),
        async () => check("sam's old code no longer signs in", false, await samPage!.locator(".form-error").textContent()),
      );
    });

    // The run provokes exactly these on purpose: the forged pane input (400), and sam's /admin visit and
    // revoked-code login (403s). Anything else is a real error.
    const expected = [/^alex console: .*status of 400/, /^sam console: .*status of 403/];
    const stray = pageErrors.filter((e) => !expected.some((re) => re.test(e)));
    check("no uncaught page errors (besides the ones the test provokes)", stray.length === 0, { stray: stray.slice(0, 8), all: pageErrors.length });
  } finally {
    await browser?.close().catch(() => {});
    for (const u of USERS) await teamDown(u);
    await run("tmux", ["-L", SOCKET, "kill-server"]).catch(() => {});
    if (web?.pid) {
      try {
        process.kill(web.pid, "SIGTERM");
      } catch {}
    }
    await sleep(500);
    await run("pkill", ["-f", `next dev --hostname 127.0.0.1 --port ${WEB_PORT}`]).catch(() => {});
    if (process.env.KEEP_TMP !== "1") fs.rmSync(TMP, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length && webLog.length) console.log(`\n--- last web server output ---\n${webLog.join("").split("\n").slice(-40).join("\n")}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
