// In-memory stand-in for hub + daemon. Emits contract-shaped frames so the UI can be built
// and demoed without the real services. Enable with ?mock=1 (?daemon=7702 makes you "sam").
import { PROTOCOL_VERSION } from "../../../contracts/index.ts";
import type {
  ContextEntry,
  Envelope,
  EventFrame,
  HubEvent,
  MessageType,
  RichBody,
  ServerFrame,
  Session,
  SessionStatus,
  StoredMessage,
  UploadResult,
  UserPresence,
} from "../../../contracts/index.ts";
import { involves, PANE_INPUT_MAX, params, userOf, type ConnectHandlers, type PaneInputStatus, type PaneResult, type Transport } from "../lib.ts";
import { screenStore } from "../screens.ts";
import { makeScreenSim } from "./screens.ts";
import { clientProof, IMPOSTOR_MSG, randomHex, sameHex, serverProof } from "../auth.ts";

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const uuid = () => crypto.randomUUID();
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

function session(user: string, agent: string, kind: Session["kind"], status: SessionStatus, task: string, msAgo: number): Session {
  return { address: `${user}/${agent}`, user, agent, kind, status, task, last_activity: iso(msAgo) };
}

export function mockTransport(daemonPort: number): Transport {
  const me = daemonPort === 7702 ? "sam" : "alex";
  const other = me === "alex" ? "sam" : "alex";

  const users = new Map<string, UserPresence>();
  const addUser = (user: string, connected: boolean, ip: string, sessions: Session[]) =>
    users.set(user, { user, connected, hub_address: ip, sessions });
  // two claude4 teams: an orchestrator plus worker-1..4 on each laptop
  addUser("alex", true, "192.168.1.20", [
    session("alex", "orchestrator", "orchestrator", "working", "coordinating 4 workers", 40_000),
    session("alex", "worker-1", "worker", "working", "Writing invoice endpoint handlers", 15_000),
    session("alex", "worker-2", "worker", "idle", "", 9 * 60_000),
    session("alex", "worker-3", "worker", "working", "PDF rendering for invoices", 30_000),
    session("alex", "worker-4", "worker", "waiting", "Waiting on schema decision from sam", 4 * 60_000),
  ]);
  addUser("sam", true, "192.168.1.34", [
    session("sam", "orchestrator", "orchestrator", "working", "coordinating 4 workers", 25_000),
    session("sam", "worker-1", "worker", "idle", "", 6 * 60_000),
    session("sam", "worker-2", "worker", "error", "Migration 0042 failed on CI", 2 * 60_000),
    session("sam", "worker-3", "worker", "working", "Payments client: read invoices", 20_000),
    session("sam", "worker-4", "worker", "working", "Webhook load test", 50_000),
  ]);
  // ?mockteams=N (3..6): more claude4 teams on the hub, for the Terminals "all" grid
  const EXTRA = ["kim", "ravi", "jo", "mei"];
  const teamCount = Math.min(6, Math.max(2, Number(params.get("mockteams")) || 2));
  EXTRA.slice(0, teamCount - 2).forEach((u, i) =>
    addUser(u, true, `192.168.1.${50 + i}`, [
      session(u, "orchestrator", "orchestrator", "working", "coordinating 4 workers", 30_000 + i * 5000),
      session(u, "worker-1", "worker", "working", "Search indexing", 12_000),
      session(u, "worker-2", "worker", "idle", "", 5 * 60_000),
      session(u, "worker-3", "worker", "waiting", `Waiting on ${me}/orchestrator`, 90_000),
      session(u, "worker-4", "worker", "working", "Load-testing the API", 40_000),
    ]),
  );

  const context = new Map<string, ContextEntry>();
  const ctx = (e: Omit<ContextEntry, "updated_at"> & { ago: number }) =>
    context.set(e.key, { key: e.key, title: e.title, kind: e.kind, body: e.body, author: e.author, version: e.version, updated_at: iso(e.ago) });
  ctx({
    key: "api-schema",
    title: "API schema",
    kind: "api_spec",
    author: "sam/orchestrator",
    version: 3,
    ago: 12 * 60_000,
    body:
      "Invoices are created by the billing service and read by payments.\n\n```ts\ninterface Invoice {\n  id: string;          // inv_…\n  customer_id: string;\n  amount_cents: number;\n  currency: \"usd\" | \"eur\";\n  status: \"draft\" | \"open\" | \"paid\";\n}\n```\n\n`POST /invoices` returns 201 with the full object.",
  });
  ctx({
    key: "auth-decision",
    title: "Service auth uses short-lived JWTs",
    kind: "decision",
    author: "alex/orchestrator",
    version: 1,
    ago: 55 * 60_000,
    body: "Services sign 5-minute JWTs with the shared key. No long-lived API keys between services.\n\n- Rotation: weekly\n- Clock skew allowance: 30s",
  });
  ctx({
    key: "ci-notes",
    title: "CI flakiness log",
    kind: "note",
    author: "sam/worker-2",
    version: 5,
    ago: 3 * 60_000,
    body: "Migration tests flake when two suites share the same DB. Run `npm test -- --runInBand` locally until we split them.",
  });

  const messages = new Map<string, StoredMessage>();
  const store = (from: string, to: string, type: MessageType, body: string | RichBody, msAgo: number, reply_to: string | null = null) => {
    const m: StoredMessage = {
      id: uuid(),
      from,
      to,
      reply_to,
      hops: 1,
      type,
      body,
      timestamp: iso(msAgo),
      state: "delivered",
      accepted_at: iso(msAgo),
      delivered_at: iso(msAgo - 200),
      drop_reason: null,
    };
    messages.set(m.id, m);
    return m;
  };

  // seed history
  const t1 = store("alex/human", "alex/orchestrator", "task", "Plan the billing API split. Ask sam for the invoice schema before workers start.", 30 * 60_000);
  store("alex/orchestrator", "alex/human", "result", "Plan is ready:\n\n1. `worker-1`: invoice endpoints\n2. `worker-3`: PDF rendering\n3. `worker-4`: contract tests\n\nI've asked sam/orchestrator for the schema.", 28 * 60_000, t1.id);
  const t2 = store("alex/orchestrator", "sam/orchestrator", "task", "Can you share the current `Invoice` shape? Our workers start on endpoints next.", 27 * 60_000);
  store("sam/orchestrator", "alex/orchestrator", "result", "Posted it to shared context as **API schema** (v3). `amount_cents` is an integer, never a float.", 25 * 60_000, t2.id);
  store("alex/worker-1", "alex/orchestrator", "status", { status: "working", task: "Writing invoice endpoint handlers" }, 14 * 60_000);
  store("alex/worker-1", "alex/orchestrator", "chat", {
    text: "Running the endpoint tests.",
    tool: { name: "bash", input: { command: "npm test -- invoices" }, output: "PASS  test/invoices.test.ts (14 tests)\nTime: 2.31s", state: "ok" },
  }, 9 * 60_000);
  store("alex/worker-1", "alex/orchestrator", "chat", {
    text: "Handler draft for `POST /invoices`:\n\n```ts\napp.post(\"/invoices\", async (req, res) => {\n  const inv = await billing.create(req.body);\n  res.status(201).json(inv);\n});\n```",
  }, 7 * 60_000);
  store("sam/worker-2", "*", "chat", {
    text: "Heads up: migration 0042 fails on CI. Don't merge schema changes for now.",
    log: "Error: relation \"invoices\" already exists\n    at Migrator.up (migrate.ts:88)\n    at async run (migrate.ts:21)\nexit code 1",
  }, 2 * 60_000);
  store("alex/worker-4", "alex/orchestrator", "chat", "Contract tests are blocked until sam confirms whether `currency` can be null.", 4 * 60_000);
  store("sam/orchestrator", "sam/worker-1", "task", "Wire the payments client to read invoices from alex's endpoints.", 20 * 60_000);

  // event log
  let seq = 100;
  const log: EventFrame[] = [];
  let handlers: ConnectHandlers | null = null;
  let connected = false;

  const emit = (event: HubEvent) => {
    const frame: EventFrame = { seq: ++seq, at: iso(), event };
    log.push(frame);
    if (log.length > 500) log.shift();
    if (connected) handlers?.onFrame({ op: "event", frame });
  };

  const touch = (address: string, patch: Partial<Session>) => {
    const u = users.get(userOf(address));
    const s = u?.sessions.find((x) => x.address === address);
    if (!s) return;
    Object.assign(s, patch, { last_activity: iso() });
    emit({ type: "session.updated", session: { ...s } });
  };

  const sendMsg = (from: string, to: string, type: MessageType, body: string | RichBody, reply_to: string | null = null) => {
    const m: StoredMessage = {
      id: uuid(), from, to, reply_to, hops: 0, type, body, timestamp: iso(),
      state: "accepted", accepted_at: iso(), delivered_at: null, drop_reason: null,
    };
    messages.set(m.id, m);
    emit({ type: "message.accepted", message: m });
    setTimeout(() => {
      m.state = "delivered";
      m.delivered_at = iso();
      emit({ type: "message.delivered", id: m.id, to, at: m.delivered_at });
    }, 250 + Math.random() * 500);
    return m;
  };

  // scripted background activity
  const script: Array<() => void> = [
    () => {
      const m = sendMsg(`${other}/orchestrator`, `${me}/orchestrator`, "task", "Can your worker-4 run the contract tests against our staging payments client? No rush.");
      touch(`${other}/orchestrator`, { status: "waiting", task: `Waiting on ${me}/worker-4` });
      setTimeout(() => sendMsg(`${me}/orchestrator`, `${me}/worker-4`, "task", "Run the contract tests against sam's staging payments client."), 1200);
      setTimeout(() => sendMsg(`${me}/orchestrator`, `${other}/orchestrator`, "result", "Queued it for worker-4. I'll post results to shared context.", m.id), 2200);
    },
    () => {
      touch(`${me}/worker-2`, { status: "working", task: "Rendering invoice PDFs" });
      sendMsg(`${me}/worker-2`, `${me}/orchestrator`, "chat", {
        tool: { name: "edit_file", input: { path: "src/pdf/render.ts", lines: "+42 −7" }, output: "ok", state: "ok" },
      });
    },
    () => {
      const e = context.get("api-schema")!;
      e.version++;
      e.author = `${other}/orchestrator`;
      e.updated_at = iso();
      e.body = e.body.replace(/currency: [^;]+;/, `currency: "usd" | "eur" | "gbp";`);
      emit({ type: "context.updated", entry: { ...e } });
    },
    () => {
      touch(`sam/worker-2`, { status: pick<SessionStatus>(["working", "idle", "error"]), task: pick(["Re-running migration 0042", "Splitting test DBs", ""]) });
    },
    () => {
      sendMsg(`${me}/worker-1`, `${me}/orchestrator`, "chat", {
        text: "Tests running again after the schema bump.",
        tool: { name: "bash", input: { command: "npm test -- invoices" }, state: "running" },
      });
      touch(`${me}/worker-1`, { status: "working" });
    },
    () => {
      // a remote worker asks one of our workers directly (bridge DIRECT mode)
      sendMsg(`${other}/worker-3`, `${me}/worker-1`, "chat", "Is `GET /invoices/:id` stable enough to code against?");
      setTimeout(() => sendMsg(`${me}/worker-1`, `${other}/worker-3`, "result", "Yes. Shape matches **API schema** v3."), 1600);
    },
    () => {
      sendMsg(`${other}/worker-1`, "*", "chat", "Payments client now reads `amount_cents` as an integer. Ping me if anything breaks.");
    },
    () => {
      const e = context.get("ci-notes")!;
      e.version++;
      e.author = "sam/worker-2";
      e.updated_at = iso();
      e.body += `\n\n- ${new Date().toLocaleTimeString()}: still flaky on the 3rd run.`;
      emit({ type: "context.updated", entry: { ...e } });
    },
  ];
  // steady team chatter: orchestrators hand out work, workers report back, statuses flip
  const TASKS = ["Add pagination to /invoices", "Fix flaky migration test", "Write PDF snapshot tests", "Retry webhook deliveries", "Review payments client PR", "Profile invoice query"];
  const chatter = () => {
    const team = pick([...users.keys()]);
    const w = `${team}/worker-${1 + Math.floor(Math.random() * 4)}`;
    const roll = Math.random();
    if (roll < 0.4) {
      const task = pick(TASKS);
      sendMsg(`${team}/orchestrator`, w, "task", task);
      touch(w, { status: "working", task });
    } else if (roll < 0.75) {
      sendMsg(w, `${team}/orchestrator`, "result", pick(["Done, tests pass.", "Pushed to branch, PR open.", "Blocked: need the schema decision.", "Fixed; it was a race in setup."]));
      touch(w, { status: pick<SessionStatus>(["idle", "idle", "waiting"]), task: "" });
    } else if (roll < 0.9) {
      const peer = `${pick([...users.keys()].filter((u) => u !== team))}/orchestrator`;
      sendMsg(`${team}/orchestrator`, peer, "chat", "Status: two workers busy, two free. Anything for us?");
    } else {
      touch(`${team}/orchestrator`, { status: pick<SessionStatus>(["working", "working", "waiting"]) });
    }
  };

  let scriptIdx = 0;
  let scriptTimer: number | undefined;
  let chatterTimer: number | undefined;
  const runScript = () => {
    scriptTimer = window.setTimeout(() => {
      if (connected) script[scriptIdx++ % script.length]();
      runScript();
    }, 4000 + Math.random() * 4000);
  };
  const runChatter = () => {
    chatterTimer = window.setTimeout(() => {
      if (connected) chatter();
      runChatter();
    }, 900 + Math.random() * 1400);
  };

  const snapshot = (): ServerFrame => ({
    op: "snapshot",
    users: [...users.values()].map((u) => ({ ...u, sessions: u.sessions.map((s) => ({ ...s })) })),
    context: [...context.values()].map((e) => ({ ...e })),
    last_seq: seq,
  });

  // the daemon's hub link (DaemonHealth.hub). The hub's identity is its id; its address can change.
  const HUB_ID = "7f3a9c21-4d0e-4b8a-9f61-2c5e8d1a0b37";
  let hubIp = "192.168.1.20";
  const hubLink: { via: "mdns" | "last_known" | "scan" | "manual" | null; searching: boolean } = { via: "mdns", searching: false };
  const hubUrl = () => `http://${hubIp}:7700`;

  let mockSession: string | null = null;
  const uploads = new Map<string, UploadResult>();
  const api = {
    /** files "uploaded" so far, and ids removed with ✕ (tests check the composer) */
    uploads: [] as UploadResult[],
    deletedUploads: [] as string[],
    /** text typed into panes through the command bar */
    paneTexts: [] as string[],
    /** v2 handshakes attempted (tests check an impostor is not retried) */
    handshakes: 0,
    /** current REST session from the last welcome (REST calls are refused without one) */
    session: () => mockSession,
    /** GET /v1/health calls so far (tests check the UI polls only while the hub socket is down) */
    healthCalls: 0,
    /** The hub vanishes (its IP changed): the daemon searches for `ms`, then finds it again at a new address. */
    search(ms = 8000, via: "last_known" | "scan" | "mdns" = "scan") {
      connected = false;
      hubLink.searching = true;
      hubLink.via = null;
      handlers?.onState("reconnecting", "hub connection lost");
      setTimeout(() => {
        hubIp = `192.168.1.${30 + Math.floor(Math.random() * 200)}`;
        hubLink.searching = false;
        hubLink.via = via;
        open(true);
      }, ms);
    },
    disconnect(ms = 4000) {
      connected = false;
      handlers?.onState("reconnecting", "hub connection lost");
      setTimeout(() => open(true), ms);
    },
    /** current live-screen subscription (for tests) */
    screenSubs: () => [...screenSubs],
  };

  // live screens: every subscribed address of a sharing user gets a new screen about once a second.
  // ?mockshare=alex limits sharing to those users (to see the "screen not shared" frames).
  const shareParam = params.get("mockshare");
  const sharing = new Set(shareParam ? shareParam.split(",") : [...users.keys()]);
  const findSession = (a: string) => users.get(userOf(a))?.sessions.find((s) => s.address === a);
  const sim = makeScreenSim(findSession);
  let screenSubs: string[] = [];
  const inputs = new Map<string, PaneInputStatus>();
  const pushScreen = (a: string, fresh: boolean) => {
    if (!connected || !handlers || !sharing.has(userOf(a)) || !findSession(a)) return;
    handlers.onFrame({ op: "screen", address: a, screen: fresh ? sim.render(a) : sim.tick(a), at: iso() });
  };
  window.setInterval(() => {
    for (const a of screenSubs) pushScreen(a, false);
  }, 1000);

  let sinceFn: () => number | undefined = () => undefined;
  // protocol v2 handshake, both sides in-process: the "hub" half here, the client half via ../auth.ts
  // (the same functions realTransport uses). ?mockimpostor=1: wrong server_proof. ?mockwronghub=1: challenge
  // from a different hub_id than the daemon's pin. Either way the UI must refuse and not retry.
  const MOCK_TOKEN = "mock-shared-token";
  let impostorSeen = false;
  async function handshake(): Promise<{ ok: true; session: string } | { ok: false; detail: string }> {
    const nonce = randomHex(32);
    const hubId = params.get("mockwronghub") === "1" ? "deadbeef-0000-4000-8000-000000000000" : HUB_ID;
    // client: check the pin before sending anything
    if (hubId !== HUB_ID) return { ok: false, detail: `${IMPOSTOR_MSG}: hub id ${hubId.slice(0, 8)} is not the pinned ${HUB_ID.slice(0, 8)}` };
    const cnonce = randomHex(32);
    const proof = await clientProof(MOCK_TOKEN, nonce, hubId, me, "ui", cnonce);
    // hub: verify the client's proof
    if (!sameHex(proof, await clientProof(MOCK_TOKEN, nonce, hubId, me, "ui", cnonce))) return { ok: false, detail: "hub refused our proof" };
    const sp = params.get("mockimpostor") === "1" ? randomHex(32) : await serverProof(MOCK_TOKEN, cnonce, nonce, hubId);
    // client: verify the hub's proof before trusting anything
    if (!sameHex(sp, await serverProof(MOCK_TOKEN, cnonce, nonce, hubId))) return { ok: false, detail: IMPOSTOR_MSG };
    return { ok: true, session: randomHex(24) };
  }
  api.handshakes = 0;

  function open(re: boolean) {
    if (!handlers) return;
    const h = handlers;
    h.onState(re ? "reconnecting" : "connecting");
    if (impostorSeen) {
      h.onState("offline", `${IMPOSTOR_MSG} at ${hubUrl()}; not reconnecting there`);
      return;
    }
    setTimeout(async () => {
      api.handshakes++;
      const hs = await handshake();
      if (!hs.ok) {
        impostorSeen = hs.detail.startsWith(IMPOSTOR_MSG);
        h.onState("offline", impostorSeen ? `${hs.detail}; not reconnecting there` : hs.detail);
        if (!impostorSeen) setTimeout(() => open(true), 2000);
        return;
      }
      mockSession = hs.session;
      connected = true;
      h.onState("connected");
      h.onFrame({ op: "welcome", hub_id: HUB_ID, hub_name: "mock hub", server_time: iso(), protocol: PROTOCOL_VERSION, server_proof: "verified-in-handshake", session: hs.session });
      h.onFrame(snapshot());
      const since = sinceFn();
      if (since != null) for (const f of log) if (f.seq > since) h.onFrame({ op: "event", frame: f });
      if (screenSubs.length) {
        screenStore.resetGrace();
        for (const a of screenSubs) pushScreen(a, true);
      }
    }, re ? 300 : 600);
  }

  return {
    mock: true,
    async bootstrap() {
      return { user: me, hub_http: hubUrl(), hub_ws: hubUrl().replace("http", "ws") + "/ws", token: "mock", daemon: `http://127.0.0.1:${daemonPort}` };
    },
    async health() {
      api.healthCalls++;
      return {
        ok: true as const,
        user: me,
        hub: {
          state: hubLink.searching ? ("reconnecting" as const) : connected ? ("connected" as const) : ("connecting" as const),
          url: hubLink.searching ? null : hubUrl(),
          via: hubLink.via,
          hub_name: "mock hub",
          hub_id: HUB_ID,
          searching: hubLink.searching,
        },
        outbox_depth: 0,
        inbox_unhandled: 0,
      };
    },
    connect(h, since) {
      // StrictMode may build two transports; the test hook belongs to the one that actually connects
      (window as unknown as { __mock: typeof api }).__mock = api;
      handlers = h;
      sinceFn = since;
      open(false);
      // ?mocksearch=<ms>: a searching phase 3s after connecting (the hub's IP changes), then found by scan
      const ms = Number(params.get("mocksearch"));
      if (ms > 0) setTimeout(() => api.search(ms), 3000);
      runScript();
      runChatter();
      return () => {
        connected = false;
        handlers = null;
        window.clearTimeout(scriptTimer);
        window.clearTimeout(chatterTimer);
      };
    },
    async messages(q) {
      await new Promise((r) => setTimeout(r, 350));
      // v2: hub REST needs the session from a verified welcome
      if (!mockSession) throw new Error("not connected to the hub");
      return [...messages.values()]
        .filter((m) => involves(m, q.address) && (!q.with || involves(m, q.with)))
        .filter((m) => !q.before || m.timestamp < q.before)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, q.limit ?? 50);
    },
    upload(file, name, onProgress, signal) {
      // pretends to stream: 5 progress steps over ~0.5s. ?mockupload=fail makes every upload fail.
      return new Promise<UploadResult>((resolve, reject) => {
        let step = 0;
        const t = window.setInterval(() => {
          if (signal.aborted) {
            window.clearInterval(t);
            return reject(new DOMException("upload cancelled", "AbortError"));
          }
          step++;
          onProgress(Math.round((file.size * step) / 5));
          if (step < 5) return;
          window.clearInterval(t);
          if (params.get("mockupload") === "fail") return reject(new Error("the daemon answered 507"));
          const day = new Date().toISOString().slice(0, 10);
          const u: UploadResult = { id: uuid(), name, size: file.size, sha256: "0".repeat(64), path: `/mock/agentlink/data/uploads/${day}/${name}`, created_at: iso(), ...(file.type ? { mime: file.type } : {}) };
          uploads.set(u.id, u);
          api.uploads.push(u);
          resolve(u);
        }, 100);
      });
    },
    async deleteUpload(id) {
      uploads.delete(id);
      api.deletedUploads.push(id);
    },
    async send(req) {
      const files = (req.attachments ?? []).map((id) => uploads.get(id)).filter((u): u is UploadResult => !!u);
      const body: Envelope["body"] = files.length ? { ...(typeof req.body === "string" ? { text: req.body } : req.body), attachments: files } : req.body;
      const env: Envelope = {
        id: uuid(), from: `${me}/${req.from_agent ?? "orchestrator"}`, to: req.to, reply_to: req.reply_to ?? null,
        hops: req.hops ?? 0, type: req.type, body, timestamp: iso(),
      };
      const m = sendMsg(env.from, env.to, env.type, env.body, env.reply_to);
      // the boss: thinks for a few seconds (status flips to working), then answers with reply_to.
      // ?mockboss=off: it never answers, so "waiting for the boss…" stays up.
      if (req.to === `${me}/orchestrator` && env.from === `${me}/human`) {
        if (params.get("mockboss") === "off") return { id: m.id, queued: true as const };
        const boss = `${me}/orchestrator`;
        setTimeout(() => touch(boss, { status: "working", task: "Reading your message" }), 500);
        setTimeout(() => {
          const ask = typeof req.body === "string" ? req.body : "that";
          const short = ask.length > 60 ? `${ask.slice(0, 57)}…` : ask;
          sendMsg(boss, `${me}/human`, "result", `On it: *${short}*\n\nI've split it up: **worker-1** takes the first part, **worker-3** checks it. I'll report back here when they're done.`, m.id);
          touch(boss, { status: "working", task: `coordinating: ${short}` });
        }, 2500 + Math.random() * 2000);
        return { id: m.id, queued: true as const };
      }
      // a local agent answers its human
      if (userOf(req.to) === me && req.to !== `${me}/human`) {
        setTimeout(() => {
          touch(req.to, { status: "working", task: "Handling your request" });
          sendMsg(req.to, `${me}/human`, "result", `On it. I'll treat this as a **${req.type}** and report back here.`, m.id);
        }, 1400);
      }
      return { id: m.id, queued: true as const };
    },
    async paneInput(req) {
      await new Promise((r) => setTimeout(r, 150));
      if (params.get("mockbridge") === "0")
        return { ok: false as const, kind: "no_bridge" as const, message: "No bridge is connected on this laptop, so nothing can be typed into the panes. Start it with scripts/team-up.sh, then try again." };
      if (!req.agents.length || !req.text || req.text.length > PANE_INPUT_MAX) return { ok: false as const, kind: "bad_request" as const, message: "Bad input request." };
      const id = uuid();
      api.paneTexts.push(req.text);
      inputs.set(id, { id, state: "pending" });
      // the "bridge" types it a moment later, one pane at a time
      setTimeout(() => {
        const results: Record<string, PaneResult> = {};
        for (const agent of req.agents) {
          const a = `${me}/${agent}`;
          const s = findSession(a);
          if (!s) results[agent] = "skipped: no_pane";
          else if (s.status === "waiting") results[agent] = "skipped: prompt_open";
          else {
            results[agent] = "sent";
            sim.typed(a, req.text);
            if (req.text.trim() === "/clear") touch(a, { status: "idle", task: "" });
            else if (req.submit !== false) touch(a, { status: "working", task: req.text.slice(0, 60) });
            pushScreen(a, true);
          }
        }
        inputs.set(id, { id, state: "done", results });
      }, 700 + Math.random() * 500);
      return { ok: true as const, id };
    },
    async paneInputStatus(id) {
      return inputs.get(id) ?? null;
    },
    subscribeScreens(addresses) {
      const next = [...new Set(addresses)].sort();
      if (next.join() === screenSubs.join()) return;
      const added = next.filter((a) => !screenSubs.includes(a));
      screenSubs = next;
      screenStore.subscribed(next);
      // like the hub: the current screen of each newly subscribed address right away
      setTimeout(() => added.forEach((a) => pushScreen(a, true)), 120);
    },
    async putContext(key, w) {
      await new Promise((r) => setTimeout(r, 250));
      const cur = context.get(key);
      if (w.base_version != null && cur && cur.version !== w.base_version) return { ok: false as const, conflict: { ...cur } };
      const entry: ContextEntry = {
        key, title: w.title, kind: w.kind, body: w.body, author: `${me}/${w.agent ?? "orchestrator"}`,
        version: (cur?.version ?? 0) + 1, updated_at: iso(),
      };
      context.set(key, entry);
      emit({ type: "context.updated", entry: { ...entry } });
      return { ok: true as const, entry };
    },
  };
}
