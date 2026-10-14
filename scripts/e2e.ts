// Full-system end-to-end test against a running demo (scripts/demo-up.sh):
// hub on BASE, alex daemon on BASE+1, sam daemon on BASE+2. BASE = AGENTLINK_BASE_PORT, default 7700.
//
//   scripts/demo-up.sh && npx tsx scripts/e2e.ts && scripts/demo-down.sh
//
// Prints PASS/FAIL per check and exits non-zero on any failure. Leaves the demo running (check 6
// restarts sam through demo-up.sh, so the pidfile stays accurate for demo-down.sh).
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import type { DaemonHealth, EventFrame, HubEvent, InboxItem, ServerFrame, UiBootstrap } from "../contracts/index.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASE = Number(process.env.AGENTLINK_BASE_PORT ?? 7700);
const PORT = { hub: BASE, alex: BASE + 1, sam: BASE + 2 } as const;
type User = "alex" | "sam";
const DEMO_DIR = path.join(ROOT, "data", `demo-${BASE}`);
const ORCH_LOG_DIR = path.join(DEMO_DIR, "logs", "orchestrator");
const CLI = path.join(ROOT, "orchestrator", "bin", "agentlink.mjs");
const TAG = `e2e-${randomUUID().slice(0, 8)}`;
const run = promisify(execFile);

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `\n        ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${(last as Error).message ?? last})` : ""}`);
}

/** Run a step; a thrown error counts as a FAIL for that step and the run continues. */
async function step(name: string, fn: () => Promise<void>) {
  console.log(`\n== ${name}`);
  try {
    await fn();
  } catch (err) {
    check(`${name}: ${(err as Error).message}`, false);
  }
}

// ---------------------------------------------------------------- daemon API + CLI

async function api(user: User, method: string, p: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${PORT[user]}${p}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const health = async (u: User) => (await api(u, "GET", "/v1/health")).body as DaemonHealth;
const inbox = async (u: User, agent: string) =>
  (await api(u, "GET", `/v1/inbox?agent=${agent}&limit=1000`)).body.messages as InboxItem[];

/** The orchestrator CLI (orchestrator/bin/agentlink.mjs) against one daemon. */
async function cli(user: User, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await run(process.execPath, [CLI, "--port", String(PORT[user]), ...args], {
      env: { ...process.env, AGENTLINK_ORCH_LOG_DIR: ORCH_LOG_DIR },
      timeout: 20_000,
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}
async function cliInbox(user: User, agent: string): Promise<InboxItem[]> {
  const r = await cli(user, ["--json", "inbox", "--agent", agent, "--all"]);
  if (r.code !== 0) throw new Error(`agentlink inbox exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => normalizeCliItem(JSON.parse(l)));
}

/** The CLI prints either an InboxItem or a flat, trust-annotated record; map both to InboxItem. */
function normalizeCliItem(x: Record<string, any>): InboxItem {
  if (x.envelope) return x as InboxItem;
  return {
    envelope: {
      id: x.id,
      from: x.from,
      to: x.to,
      reply_to: x.reply_to ?? null,
      hops: x.hops,
      type: x.type,
      body: x.untrusted_body ?? x.body,
      timestamp: x.timestamp,
    },
    received_at: x.received_at,
    handled: x.handled,
    remote: x.remote,
  };
}

function logLines(file: string): Record<string, unknown>[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

// ---------------------------------------------------------------- UI socket

class UiSocket {
  events: EventFrame[] = [];
  private ws!: WebSocket;

  async open(token: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT.hub}/ws`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ui socket: no welcome within 5s")), 5000);
      this.ws.on("open", () =>
        this.ws.send(JSON.stringify({ op: "hello", token, role: "ui", user: "e2e-ui", protocol: 1 })),
      );
      this.ws.on("message", (raw) => {
        const f = JSON.parse(raw.toString()) as ServerFrame;
        if (f.op === "welcome") {
          clearTimeout(timer);
          resolve();
        } else if (f.op === "event") this.events.push(f.frame);
      });
      this.ws.on("close", (code) => reject(new Error(`ui socket closed ${code}`)));
      this.ws.on("error", reject);
    });
  }

  wait<T extends HubEvent["type"]>(type: T, pred: (e: Extract<HubEvent, { type: T }>) => boolean, ms = 10_000) {
    return until(`ui event ${type}`, async () =>
      this.events.map((f) => f.event).find((e): e is Extract<HubEvent, { type: T }> => e.type === type && pred(e as never)),
    ms);
  }

  close() {
    this.ws?.close();
  }
}

// ---------------------------------------------------------------- checks

async function main() {
  console.log(`agentlink e2e: hub ${PORT.hub}, alex ${PORT.alex}, sam ${PORT.sam}, tag ${TAG}`);
  const ui = new UiSocket();

  await step("1. discovery: both daemons connected via mDNS", async () => {
    for (const u of ["alex", "sam"] as const) {
      const h = await until(`${u} connected`, async () => {
        const x = await health(u);
        return x.hub.state === "connected" ? x : null;
      });
      check(`${u}: hub.state=connected, via=mdns (${h.hub.url}, ${h.hub.hub_name})`, h.hub.via === "mdns", h.hub);
      check(`${u}: connected to this demo's hub on port ${PORT.hub}`, h.hub.url?.endsWith(`:${PORT.hub}`) === true, h.hub);
    }
    const boot = (await api("alex", "GET", "/v1/ui-bootstrap")).body as UiBootstrap;
    await ui.open(boot.token);
    check("ui socket (role ui) opened with the ui-bootstrap token", true);
    for (const u of ["alex", "sam"] as const) {
      const r = await api(u, "PUT", "/v1/sessions/orchestrator", { kind: "orchestrator", status: "idle", task: "" });
      if (r.status !== 200) throw new Error(`PUT session on ${u} -> ${r.status}`);
    }
  });

  await step("2. task and result between alex and sam via the agentlink CLI", async () => {
    const sent = await cli("alex", ["--json", "send", "sam/orchestrator", "task", `${TAG}: summarise the hub schema`]);
    check("alex: agentlink send exits 0", sent.code === 0, sent.stderr);
    const taskId = JSON.parse(sent.stdout).id as string;
    const task = await until("task in sam's inbox", async () =>
      (await cliInbox("sam", "orchestrator")).find((i) => i.envelope.id === taskId),
    );
    check("sam: task arrived from alex/orchestrator", task.envelope.from === "alex/orchestrator" && task.envelope.type === "task", task.envelope);
    check("sam: task is marked remote", task.remote === true, task);

    const reply = await cli("sam", ["--json", "send", "alex/orchestrator", "result", `${TAG}: done`, "--reply-to", taskId]);
    check("sam: agentlink send result exits 0", reply.code === 0, reply.stderr);
    const resultId = JSON.parse(reply.stdout).id as string;
    const result = await until("result in alex's inbox", async () =>
      (await cliInbox("alex", "orchestrator")).find((i) => i.envelope.id === resultId),
    );
    check("alex: result arrived with reply_to = task id", result.envelope.reply_to === taskId && result.envelope.type === "result", result.envelope);
    check("alex: result is marked remote", result.remote === true);
    const acks = await Promise.all([cli("sam", ["ack", taskId]), cli("alex", ["ack", resultId])]);
    check("both sides ack via the CLI", acks.every((a) => a.code === 0), acks.map((a) => a.stderr));
  });

  await step("3. shared context: PUT from alex reaches the ui socket and sam's inbox", async () => {
    const key = `${TAG}.notes`;
    const put = await api("alex", "PUT", `/v1/context/${key}`, { title: `E2E ${TAG}`, kind: "note", body: "hello from e2e" });
    check("alex: PUT /v1/context -> 200, author alex/orchestrator", put.status === 200 && put.body.author === "alex/orchestrator", put);
    const ev = await ui.wait("context.updated", (e) => e.entry.key === key);
    check("ui socket: context.updated event for the key", ev.entry.version === put.body.version, ev);
    const note = await until("context_update in sam's inbox", async () =>
      (await inbox("sam", "orchestrator")).find(
        (i) => i.envelope.type === "context_update" && (i.envelope.body as { context_key?: string }).context_key === key,
      ),
    );
    check(`sam: context_update in inbox (to ${note.envelope.to}, from ${note.envelope.from})`, note.envelope.from === "alex/orchestrator", note.envelope);
  });

  await step("4. session status change reaches the ui socket", async () => {
    const r = await api("alex", "PUT", "/v1/sessions/orchestrator", { kind: "orchestrator", status: "working", task: `${TAG} running` });
    check("alex: PUT /v1/sessions/orchestrator status=working -> 200", r.status === 200 && r.body.status === "working", r);
    const ev = await ui.wait(
      "session.updated",
      (e) => e.session.address === "alex/orchestrator" && e.session.status === "working" && e.session.task === `${TAG} running`,
    );
    check("ui socket: session.updated alex/orchestrator working", !!ev);
    await api("alex", "PUT", "/v1/sessions/orchestrator", { kind: "orchestrator", status: "idle", task: "" });
  });

  await step("5. hop limit: a forwarded message that passes the limit is dropped", async () => {
    const agent = "e2e-hops";
    const orchLog = (u: User) => path.join(ORCH_LOG_DIR, `orchestrator-${u}.log`);
    const first = await cli("alex", ["--json", "--from", agent, "send", `sam/${agent}`, "chat", `${TAG}: loop (safe to ignore)`]);
    if (first.code !== 0) throw new Error(`initial send failed: ${first.stderr}`);
    let at: User = "sam";
    const seen = new Set<string>();
    const hopsSeen: number[] = [];
    let refused: { code: number; stderr: string; hops: number; id: string } | null = null;
    for (let i = 0; i < 6 && !refused; i++) {
      // wait for the next copy of the loop message (forwards carry the original text), then forward it on
      const item = await until(`loop message at ${at}`, async () =>
        (await inbox(at, agent)).find(
          (m) => !seen.has(m.envelope.id) && m.envelope.type === "chat" && JSON.stringify(m.envelope.body).includes(`${TAG}: loop`),
        ),
      );
      seen.add(item.envelope.id);
      hopsSeen.push(item.envelope.hops);
      const other: User = at === "alex" ? "sam" : "alex";
      // A remote chat can't be relayed until the local user approves it (trust boundary); the test
      // plays that user here.
      const ok = await cli(at, ["approve", item.envelope.id, "--note", "e2e hop test"]);
      if (ok.code !== 0) throw new Error(`approve at ${at} exited ${ok.code}: ${ok.stderr.trim()}`);
      const fwd = await cli(at, ["--json", "--from", agent, "forward", item.envelope.id, `${other}/${agent}`]);
      if (fwd.code !== 0) {
        refused = { code: fwd.code, stderr: fwd.stderr.trim(), hops: item.envelope.hops, id: item.envelope.id };
        break;
      }
      at = other;
    }
    check(`hops seen at each receiver: ${hopsSeen.join(", ")}`, hopsSeen.join(",") === "1,3,5", hopsSeen);
    check("CLI forward refused at the limit (exit 3)", refused?.code === 3 && refused.hops === 5, refused);
    const orchDrop = logLines(orchLog(at)).find((l) => l.event === "msg.dropped" && l.reason === "hop_limit");
    check(`orchestrator log has msg.dropped hop_limit (${path.relative(ROOT, orchLog(at))})`, !!orchDrop);

    // The CLI is the polite path. A relay that ignores it and posts the hops-5 copy straight to its
    // daemon is stopped by the hub: its delivery would be hops 6.
    const raw = await api(at, "POST", "/v1/send", {
      from_agent: agent,
      to: `${at === "alex" ? "sam" : "alex"}/${agent}`,
      type: "chat",
      body: `${TAG}: raw relay of ${refused?.id}`,
      hops: 5,
    });
    check("daemon queues the hops-5 send (202)", raw.status === 202, raw);
    const rawId = raw.body.id as string;
    const dropped = await ui.wait("message.dropped", (e) => e.message.id === rawId);
    check("ui socket: message.dropped with drop_reason hop_limit", dropped.message.drop_reason === "hop_limit", dropped.message);
    const hubDrop = await until("hub log line", async () =>
      logLines(path.join(DEMO_DIR, "logs", "hub.log")).find((l) => l.id === rawId && /dropped|rejected/.test(String(l.event))),
    );
    check(`hub log: ${hubDrop.event} for ${rawId.slice(0, 8)}`, true);
    const daemonLog = path.join(DEMO_DIR, "logs", `daemon-${at}.log`);
    const dLine = await until("daemon log line", async () =>
      logLines(daemonLog).find((l) => l.id === rawId && l.event === "msg.rejected"),
    );
    check(`daemon log: msg.rejected reason ${dLine.reason}`, dLine.reason === "hop_limit", dLine);
    const noteItem = await until("rejection note", async () =>
      (await inbox(at, agent)).find((m) => m.envelope.type === "status" && m.envelope.reply_to === rawId),
    );
    check("sender's inbox has the hop_limit status note", (noteItem.envelope.body as { text?: string }).text === "hop_limit", noteItem.envelope);
    const r422 = await api(at, "POST", "/v1/send", { from_agent: agent, to: `alex/${agent}`, type: "chat", body: "x", hops: 6 });
    check("daemon refuses hops 6 outright (422 hop_limit)", r422.status === 422 && r422.body.error === "hop_limit", r422);
  });

  await step("6. kill -9 sam, send alex -> sam, restart sam, message arrives", async () => {
    const pidfile = path.join(DEMO_DIR, "pids");
    const line = fs.readFileSync(pidfile, "utf8").split("\n").find((l) => l.startsWith("sam "));
    if (!line) throw new Error(`no sam pid in ${pidfile}`);
    const pid = Number(line.split(" ")[1]);
    process.kill(pid, "SIGKILL");
    await until("sam's port to close", async () => health("sam").then(() => false, () => true));
    check(`sam daemon killed (pid ${pid})`, true);
    await until("hub to notice sam is gone", async () =>
      ui.events.some((f) => f.event.type === "user.disconnected" && f.event.user === "sam"),
    );

    const sent = await cli("alex", ["--json", "send", "sam/orchestrator", "task", `${TAG}: while you were down`]);
    check("alex: send while sam is down exits 0", sent.code === 0, sent.stderr);
    const id = JSON.parse(sent.stdout).id as string;
    await until("alex outbox to drain (hub accepted)", async () => (await health("alex")).outbox_depth === 0);
    check("hub accepted it while sam was down", true);

    const { DEMO_FRESH: _fresh, ...env } = process.env; // a restart must never wipe the demo's state
    await run(path.join(ROOT, "scripts", "demo-up.sh"), ["sam"], {
      env: { ...env, AGENTLINK_BASE_PORT: String(BASE) },
      timeout: 30_000,
    });
    const h = await health("sam");
    check("sam restarted via demo-up.sh sam and reconnected over mDNS", h.hub.state === "connected" && h.hub.via === "mdns", h.hub);
    const item = await until("queued message at sam", async () => (await inbox("sam", "orchestrator")).find((i) => i.envelope.id === id), 20_000);
    check("sam: message sent while it was down has arrived", item.envelope.from === "alex/orchestrator", item.envelope);
  });

  ui.close();
}

main()
  .catch((err) => {
    failures++;
    console.log(`FAIL  ${(err as Error).stack ?? err}`);
  })
  .finally(() => {
    console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
    process.exit(failures ? 1 : 0);
  });
