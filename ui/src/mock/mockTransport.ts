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
  UserPresence,
} from "../../../contracts/index.ts";
import { involves, userOf, type ConnectHandlers, type Transport } from "../lib.ts";

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
  addUser("alex", true, "192.168.1.20", [
    session("alex", "orchestrator", "orchestrator", "working", "Splitting the billing API into three tasks", 40_000),
    session("alex", "worker-1", "worker", "working", "Writing invoice endpoint handlers", 15_000),
    session("alex", "worker-2", "worker", "idle", "", 9 * 60_000),
    session("alex", "reviewer", "worker", "waiting", "Waiting on schema decision from sam", 4 * 60_000),
  ]);
  addUser("sam", true, "192.168.1.34", [
    session("sam", "orchestrator", "orchestrator", "working", "Integrating payments client", 25_000),
    session("sam", "worker-1", "worker", "idle", "", 6 * 60_000),
    session("sam", "worker-2", "worker", "error", "Migration 0042 failed on CI", 2 * 60_000),
  ]);
  addUser("priya", false, "192.168.1.51", [
    session("priya", "orchestrator", "orchestrator", "offline", "Load-testing webhooks", 48 * 60_000),
  ]);

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
  store("alex/orchestrator", "alex/human", "result", "Plan is ready:\n\n1. `worker-1`: invoice endpoints\n2. `worker-2`: PDF rendering\n3. `reviewer`: contract tests\n\nI've asked sam/orchestrator for the schema.", 28 * 60_000, t1.id);
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
  store("alex/reviewer", "alex/orchestrator", "chat", "Contract tests are blocked until sam confirms whether `currency` can be null.", 4 * 60_000);
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
      const m = sendMsg(`${other}/orchestrator`, `${me}/orchestrator`, "task", "Can your reviewer run the contract tests against our staging payments client? No rush.");
      touch(`${other}/orchestrator`, { status: "waiting", task: `Waiting on ${me}/reviewer` });
      setTimeout(() => sendMsg(`${me}/orchestrator`, `${other}/orchestrator`, "result", "Queued it for the reviewer. I'll post results to shared context.", m.id), 2200);
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
      const u = users.get("priya")!;
      u.connected = !u.connected;
      emit(u.connected ? { type: "user.connected", user: "priya", hub_address: u.hub_address } : { type: "user.disconnected", user: "priya" });
      const s = u.sessions[0];
      s.status = u.connected ? "idle" : "offline";
      s.last_activity = iso();
      emit({ type: "session.updated", session: { ...s } });
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
  let scriptIdx = 0;
  let scriptTimer: number | undefined;
  const runScript = () => {
    scriptTimer = window.setTimeout(() => {
      if (connected) script[scriptIdx++ % script.length]();
      runScript();
    }, 4000 + Math.random() * 4000);
  };

  const snapshot = (): ServerFrame => ({
    op: "snapshot",
    users: [...users.values()].map((u) => ({ ...u, sessions: u.sessions.map((s) => ({ ...s })) })),
    context: [...context.values()].map((e) => ({ ...e })),
    last_seq: seq,
  });

  const api = {
    disconnect(ms = 4000) {
      connected = false;
      handlers?.onState("reconnecting", "hub connection lost");
      setTimeout(() => open(true), ms);
    },
  };
  (window as unknown as { __mock: typeof api }).__mock = api;

  let sinceFn: () => number | undefined = () => undefined;
  function open(re: boolean) {
    if (!handlers) return;
    const h = handlers;
    h.onState(re ? "reconnecting" : "connecting");
    setTimeout(() => {
      connected = true;
      h.onState("connected");
      h.onFrame({ op: "welcome", hub_id: "mock-hub", hub_name: "mock hub", server_time: iso(), protocol: PROTOCOL_VERSION });
      h.onFrame(snapshot());
      const since = sinceFn();
      if (since != null) for (const f of log) if (f.seq > since) h.onFrame({ op: "event", frame: f });
    }, re ? 300 : 600);
  }

  return {
    mock: true,
    async bootstrap() {
      return { user: me, hub_http: "http://mock-hub:7700", hub_ws: "ws://mock-hub:7700/ws", token: "mock", daemon: `http://127.0.0.1:${daemonPort}` };
    },
    connect(h, since) {
      handlers = h;
      sinceFn = since;
      open(false);
      runScript();
      return () => {
        connected = false;
        handlers = null;
        window.clearTimeout(scriptTimer);
      };
    },
    async messages(q) {
      await new Promise((r) => setTimeout(r, 350));
      return [...messages.values()]
        .filter((m) => involves(m, q.address) && (!q.with || involves(m, q.with)))
        .filter((m) => !q.before || m.timestamp < q.before)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, q.limit ?? 50);
    },
    async send(req) {
      const env: Envelope = {
        id: uuid(), from: `${me}/${req.from_agent ?? "orchestrator"}`, to: req.to, reply_to: req.reply_to ?? null,
        hops: req.hops ?? 0, type: req.type, body: req.body, timestamp: iso(),
      };
      const m = sendMsg(env.from, env.to, env.type, env.body, env.reply_to);
      // a local agent answers its human
      if (userOf(req.to) === me && req.to !== `${me}/human`) {
        setTimeout(() => {
          touch(req.to, { status: "working", task: "Handling your request" });
          sendMsg(req.to, `${me}/human`, "result", `On it. I'll treat this as a **${req.type}** and report back here.`, m.id);
        }, 1400);
      }
      return { id: m.id, queued: true as const };
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
