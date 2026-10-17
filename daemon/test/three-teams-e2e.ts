// Three people, three laptop teams, one website: bryant (the owner), sam and lee each run a daemon with a boss
// (orchestrator) and workers, all in cloud mode against local-cloud.ts (the real cloud/app/api routes on an in-memory
// store + fake Realtime; never the live Supabase). Every daemon is a real child process on its own port with its own
// throwaway DB; usage probes and the calls relay are off so nothing touches this laptop's Claude or claude4 state.
//
// Matrix: worker -> worker across every pair of teams, boss -> boss for every pair, replies routed back,
// a broadcast to all bosses, presence + status seen by all three, shared context edits seen by all three,
// and one person going offline and coming back without losing anything sent meanwhile.
//
// Run: npx tsx test/three-teams-e2e.ts   (from daemon/)
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { InboxItem, UserPresence } from "../../contracts/index.ts";
import { MASTER_CODE, startLocalCloud, type LocalCloud } from "./local-cloud.ts";

const PEOPLE = ["bryant", "sam", "lee"] as const;
type Who = (typeof PEOPLE)[number];
const PORT: Record<Who, number> = { bryant: 7791, sam: 7792, lee: 7793 };
const WORKERS = ["worker-1", "worker-2"];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-3teams-"));
const daemonDir = path.resolve(import.meta.dirname, "..");
const TSX_LOADER = pathToFileURL(path.resolve(daemonDir, "../node_modules/tsx/dist/loader.mjs")).href;
const procs = new Map<Who, ChildProcess>();
const results: Array<{ group: string; name: string; ok: boolean }> = [];
let group = "";

function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ group, name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  [${group}] ${name}${!ok && detail !== undefined ? `  -> ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | Promise<T>, ms = 10_000, step = 100): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let v: T | undefined;
    try {
      v = await f();
    } catch {
      v = undefined; // a daemon restarting: keep polling
    }
    if (v) return v;
    await sleep(step);
  }
  return undefined;
}

const api = async (who: Who, method: string, p: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${PORT[who]}${p}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
};
const inbox = async (who: Who, agent?: string) =>
  ((await api(who, "GET", `/v1/inbox?limit=1000${agent ? `&agent=${agent}` : ""}`)).body as { messages: InboxItem[] }).messages;
const hubState = async (who: Who) => (await api(who, "GET", "/v1/health").catch(() => null))?.body?.hub?.state as string | undefined;
const peers = async (who: Who) => ((await api(who, "GET", "/v1/peers")).body as { users: UserPresence[] }).users;
const send = async (who: Who, from_agent: string, to: string, body: string, extra: Record<string, unknown> = {}) => {
  const r = await api(who, "POST", "/v1/send", { from_agent, to, type: "chat", body, ...extra });
  if (r.status !== 202) throw new Error(`send ${who}/${from_agent} -> ${to}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id as string;
};
/** Waits until `who`'s inbox view for `agent` holds message `id`; returns the item. */
const arrives = (who: Who, agent: string, id: string, ms = 10_000) => until(async () => (await inbox(who, agent)).find((i) => i.envelope.id === id), ms);

function startDaemon(who: Who, code: string) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const k of Object.keys(env)) if (k.startsWith("AGENTLINK_") || k.startsWith("C4_")) delete env[k];
  const p = spawn(process.execPath, ["--import", TSX_LOADER, path.join(daemonDir, "src/index.ts")], {
    cwd: tmp, // the daemon's ./logs land here
    env: {
      ...env,
      AGENTLINK_USER: who,
      AGENTLINK_TOKEN: code,
      AGENTLINK_HUB_URL: cloud.url,
      AGENTLINK_HUB_MODE: "cloud",
      AGENTLINK_DAEMON_PORT: String(PORT[who]),
      AGENTLINK_DAEMON_DB: path.join(tmp, `${who}.sqlite`),
      AGENTLINK_USAGE: "0",
      AGENTLINK_CALLS: "0",
      C4_STATE_DIR: path.join(tmp, `c4-${who}`),
      C4_SESSION: `c4-3teams-${who}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = fs.createWriteStream(path.join(tmp, `daemon-${who}.out`), { flags: "a" });
  p.stdout!.pipe(out);
  p.stderr!.pipe(out);
  procs.set(who, p);
}
async function stopDaemon(who: Who) {
  const p = procs.get(who);
  if (!p || p.exitCode !== null) return;
  p.kill("SIGTERM");
  await until(() => p.exitCode !== null, 4_000);
  if (p.exitCode === null) p.kill("SIGKILL");
}
async function registerTeam(who: Who) {
  await api(who, "PUT", "/v1/sessions/orchestrator", { kind: "orchestrator", status: "working", task: `${who} plans` });
  for (const w of WORKERS) await api(who, "PUT", `/v1/sessions/${w}`, { kind: "worker", status: "idle", task: "" });
}

let cloud!: LocalCloud;
const codes = {} as Record<Who, string>;

async function main() {
  cloud = await startLocalCloud({ owner: "bryant" });
  codes.bryant = MASTER_CODE;
  codes.sam = await cloud.invite("sam");
  codes.lee = await cloud.invite("lee");
  for (const who of PEOPLE) startDaemon(who, codes[who]);

  // ---------------------------------------------------------------- connect + presence
  group = "presence";
  for (const who of PEOPLE) {
    await until(async () => (await api(who, "GET", "/v1/health").catch(() => null))?.status === 200);
    await registerTeam(who);
  }
  for (const who of PEOPLE) check(`${who}'s daemon connects to the site`, !!(await until(async () => (await hubState(who)) === "connected")), await hubState(who));

  await api("sam", "PUT", "/v1/sessions/worker-1", { kind: "worker", status: "working", task: "invoice schema" });
  for (const viewer of PEOPLE) {
    const seen = await until(async () => {
      const us = await peers(viewer);
      const ok = PEOPLE.every((p) => {
        const u = us.find((x) => x.user === p);
        return u?.connected && ["orchestrator", ...WORKERS].every((a) => u.sessions.some((s) => s.agent === a));
      });
      return ok ? us : undefined;
    });
    check(`${viewer} sees all three people online with their boss and workers`, !!seen, await peers(viewer));
    const samW1 = (await peers(viewer)).find((u) => u.user === "sam")?.sessions.find((s) => s.agent === "worker-1");
    check(`${viewer} sees sam/worker-1's status (working, "invoice schema")`, samW1?.status === "working" && samW1.task === "invoice schema", samW1);
  }

  // ---------------------------------------------------------------- worker -> worker, every ordered pair
  group = "worker->worker";
  for (const a of PEOPLE)
    for (const b of PEOPLE) {
      if (a === b) continue;
      const id = await send(a, "worker-1", `${b}/worker-2`, `from ${a}/worker-1 to ${b}/worker-2`);
      const got = await arrives(b, "worker-2", id);
      check(`${a}/worker-1 -> ${b}/worker-2 arrives, marked remote, from intact`, !!got && got.remote === true && got.envelope.from === `${a}/worker-1`, got);
      check(`${a} -> ${b}: not in ${b}/worker-1's inbox (addressed to worker-2 only)`, !(await inbox(b, "worker-1")).some((i) => i.envelope.id === id));
    }

  // ---------------------------------------------------------------- boss -> boss, every pair, with replies
  group = "boss->boss + replies";
  for (const [a, b] of [["bryant", "sam"], ["bryant", "lee"], ["sam", "lee"]] as [Who, Who][]) {
    for (const [x, y] of [[a, b], [b, a]] as [Who, Who][]) {
      const id = await send(x, "orchestrator", `${y}/orchestrator`, `${x} boss asks ${y} boss`);
      const got = await arrives(y, "orchestrator", id);
      check(`${x}/orchestrator -> ${y}/orchestrator arrives`, !!got && got.envelope.from === `${x}/orchestrator`, got);
      const rid = await send(y, "orchestrator", got?.envelope.from ?? `${x}/orchestrator`, `${y} answers ${x}`, { type: "result", reply_to: id });
      const back = await arrives(x, "orchestrator", rid);
      check(`${y}'s reply comes back to ${x}/orchestrator with reply_to = the question`, !!back && back.envelope.reply_to === id && back.envelope.type === "result", back);
    }
  }
  // a worker's reply to another team's boss goes to that boss, not to the replier's own boss
  const ask = await send("lee", "orchestrator", "bryant/worker-1", "lee boss asks bryant's worker-1");
  const asked = await arrives("bryant", "worker-1", ask);
  const ans = await send("bryant", "worker-1", asked?.envelope.from ?? "lee/orchestrator", "worker-1 answers lee", { type: "result", reply_to: ask });
  check("lee/orchestrator -> bryant/worker-1, and the worker's reply reaches lee/orchestrator", !!asked && !!(await arrives("lee", "orchestrator", ans)));
  check("...and not bryant's own orchestrator", !(await inbox("bryant", "orchestrator")).some((i) => i.envelope.id === ans));

  // ---------------------------------------------------------------- broadcast to every boss
  group = "broadcast";
  const bc = await send("bryant", "orchestrator", "*", "all bosses: freeze main at 5pm", { type: "task" });
  for (const who of ["sam", "lee"] as Who[]) check(`bryant's broadcast "*" reaches ${who}/orchestrator`, !!(await arrives(who, "orchestrator", bc)));
  await sleep(500);
  check("the sender's own team doesn't receive its broadcast", !(await inbox("bryant")).some((i) => i.envelope.id === bc));
  const bc2 = await send("lee", "orchestrator", "*", "lee to all bosses");
  for (const who of ["bryant", "sam"] as Who[]) check(`lee's broadcast "*" reaches ${who}/orchestrator`, !!(await arrives(who, "orchestrator", bc2)));
  const scoped = await send("sam", "orchestrator", "lee/*", "everyone on lee's team");
  check(`sam -> "lee/*" reaches lee's boss and workers`, !!(await arrives("lee", "orchestrator", scoped)) && !!(await arrives("lee", "worker-1", scoped)));
  check(`"lee/*" doesn't reach bryant`, !(await inbox("bryant")).some((i) => i.envelope.id === scoped));

  // ---------------------------------------------------------------- shared context
  group = "context";
  const put = await api("sam", "PUT", "/v1/context/invoice-schema", { agent: "orchestrator", title: "Invoice schema", kind: "api_spec", body: "id, total, currency" });
  check("sam writes a context entry (v1)", put.status === 200 && put.body?.version === 1, put);
  for (const who of PEOPLE) {
    const e = await api(who, "GET", "/v1/context/invoice-schema");
    check(`${who} reads it: v1 by sam/orchestrator`, e.status === 200 && e.body?.version === 1 && e.body?.author === "sam/orchestrator", e);
    const note = await until(async () => (await inbox(who, "orchestrator")).find((i) => i.envelope.type === "context_update" && (i.envelope.body as { context_key?: string }).context_key === "invoice-schema"));
    check(`${who}'s team gets a context_update for it`, !!note, note);
  }
  const edit = await api("lee", "PUT", "/v1/context/invoice-schema", { agent: "worker-2", title: "Invoice schema", kind: "api_spec", body: "id, total, currency, due_date", base_version: 1 });
  check("lee edits it on top of v1 (v2)", edit.status === 200 && edit.body?.version === 2, edit);
  const stale = await api("bryant", "PUT", "/v1/context/invoice-schema", { title: "Invoice schema", kind: "api_spec", body: "stale edit", base_version: 1 });
  check("bryant's edit on a stale base is refused (409), not lost silently", stale.status === 409, stale);
  for (const who of PEOPLE) {
    const e = await api(who, "GET", "/v1/context/invoice-schema");
    check(`${who} sees lee's v2`, e.body?.version === 2 && /due_date/.test(e.body?.body) && e.body?.author === "lee/worker-2", e.body);
  }
  const list = await api("bryant", "GET", "/v1/context");
  check("the context list shows the entry", JSON.stringify(list.body).includes("invoice-schema"), list.body);

  // ---------------------------------------------------------------- one person offline and back
  group = "offline + back";
  await stopDaemon("lee");
  const leeOff = await until(async () => (await peers("bryant")).find((u) => u.user === "lee" && !u.connected), 45_000, 1_000);
  check("the others see lee go offline", !!leeOff, (await peers("bryant")).find((u) => u.user === "lee"));
  const missed = [
    await send("bryant", "orchestrator", "lee/orchestrator", "while you were away 1"),
    await send("sam", "worker-2", "lee/worker-1", "while you were away 2"),
    await send("sam", "orchestrator", "*", "broadcast while lee is away"),
    await send("bryant", "worker-1", "lee/worker-2", "while you were away 3"),
  ];
  const ctx = await api("sam", "PUT", "/v1/context/release-plan", { title: "Release plan", kind: "decision", body: "ship friday" });
  check("a context write while lee is offline succeeds", ctx.status === 200, ctx);
  check("the site accepted all four (each sender's outbox drained)", !!(await until(async () => {
    const o = [...(await api("bryant", "GET", "/v1/outbox")).body.items, ...(await api("sam", "GET", "/v1/outbox")).body.items];
    return o.length === 0;
  })));

  startDaemon("lee", codes.lee);
  check("lee's daemon comes back and reconnects", !!(await until(async () => (await hubState("lee")) === "connected", 15_000)));
  await registerTeam("lee");
  const all = await until(async () => {
    const items = await inbox("lee");
    return missed.every((id) => items.some((i) => i.envelope.id === id)) ? items : undefined;
  }, 15_000);
  check("every message sent while lee was offline arrives after reconnect", !!all, { missing: missed.filter((id) => !(all ?? []).some((i) => i.envelope.id === id)) });
  check("...each exactly once", !!all && missed.every((id) => all.filter((i) => i.envelope.id === id).length === 1));
  check("...in the right agents' inboxes", !!(await arrives("lee", "orchestrator", missed[0])) && !!(await arrives("lee", "worker-1", missed[1])) && !!(await arrives("lee", "worker-2", missed[3])));
  check("the context_update for release-plan arrives too", !!(await until(async () => (await inbox("lee")).find((i) => (i.envelope.body as { context_key?: string }).context_key === "release-plan"))));
  check("lee can read the entry written while offline", (await api("lee", "GET", "/v1/context/release-plan")).body?.body === "ship friday");
  check("the site has nothing left undelivered for lee", !!(await until(() => !cloud.store.deliveries.some((d) => d.username === "lee" && !d.acked))), cloud.store.deliveries.filter((d) => d.username === "lee" && !d.acked).map((d) => d.message_id));
  check("the others see lee online again", !!(await until(async () => (await peers("sam")).find((u) => u.user === "lee" && u.connected))));
  const after = await send("lee", "orchestrator", "bryant/orchestrator", "back now", { reply_to: missed[0], type: "result" });
  check("lee replies after coming back, and it reaches bryant", !!(await arrives("bryant", "orchestrator", after)));
  const later = await send("sam", "orchestrator", "lee/orchestrator", "live again?");
  check("live delivery to lee works again after the reconnect", !!(await arrives("lee", "orchestrator", later, 5_000)));

  // ---------------------------------------------------------------- nothing stuck anywhere
  group = "totals";
  for (const who of PEOPLE) check(`${who}: outbox empty`, (await api(who, "GET", "/v1/outbox")).body.items.length === 0);
  check("no API call ended in a 5xx", !cloud.requests.some((r) => r.status >= 500), cloud.requests.filter((r) => r.status >= 500));
}

let crashed: unknown = null;
try {
  await main();
} catch (err) {
  crashed = err;
  console.error("CRASH", err);
} finally {
  for (const who of PEOPLE) await stopDaemon(who);
  await cloud?.close();
}
const failed = results.filter((r) => !r.ok);
console.log("\n=== matrix ===");
const groups = [...new Set(results.map((r) => r.group))];
for (const g of groups) {
  const rs = results.filter((r) => r.group === g);
  console.log(`${rs.every((r) => r.ok) ? "PASS" : "FAIL"}  ${g}  (${rs.filter((r) => r.ok).length}/${rs.length})`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed${crashed ? ", CRASHED" : ""}. Logs: ${tmp}`);
process.exit(failed.length || crashed ? 1 : 0);
