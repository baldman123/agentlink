// Test helper: a stand-in for the agentlink website's API (contracts/cloud-api.md) plus a fake
// Supabase Realtime on the same port (fake-realtime.ts). In memory; tests poke its state directly.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Envelope, ScreenUpdate } from "../../contracts/index.ts";
import { attachFakeRealtime, type FakeRealtime } from "./fake-realtime.ts";

export interface FakeCloud {
  url: string;
  rt: FakeRealtime;
  /** Every API request: method, path (with query), whether it carried a bearer, the body. */
  requests: Array<{ method: string; path: string; bearer: string | null; body: unknown }>;
  codes: Map<string, string>; // user -> access code (the real API keeps only sha256(code))
  revoked: Set<string>; // users whose code is revoked
  sessions: Map<string, { user: string; expires: number }>;
  /** Accepted envelopes, in order. */
  sent: Envelope[];
  /** Deliveries per user, seq ascending; acked ids. */
  deliveries: Array<{ seq: number; message_id: string; username: string; hops: number; envelope: Envelope }>;
  acked: Set<string>;
  agentSessions: Map<string, { kind: string; status: string; task: string }>; // "user/agent"
  heartbeats: number;
  screens: Array<{ at: number; screen: ScreenUpdate }>;
  screensGone: string[]; // agents
  /** Pane inputs the "website" sent, and the results daemons reported (contracts/cloud-api.md "Typing into your own panes"). */
  inputs: Map<string, { username: string; state: string; results?: Record<string, string> }>;
  /** Send an input frame on input:<user>, signed like the API does. `tamper` changes it after signing (tests). */
  sendInput(user: string, agents: string[], text: string, opts?: { submit?: boolean; at?: string; id?: string; signAs?: string; channelUser?: string; tamper?: (f: Record<string, unknown>) => void }): string;
  jwtTtlMs: number;
  /** Next N API calls (except login) answer 503. */
  failNext: number;
  /** Store a delivery for `user` and push it over Realtime (unless `push` is false, as when Realtime is down). */
  deliver(user: string, env: Envelope, push?: boolean): number;
  /** Invalidate every session (as after a deploy that rotates the session secret). */
  expireSessions(): void;
  /** Revoke a person's code: refuse their calls and kick them on user:<name>. */
  revoke(user: string): void;
  close(): Promise<void>;
}

export async function startFakeCloud(opts: { codes?: Record<string, string>; jwtTtlMs?: number } = {}): Promise<FakeCloud> {
  const server = createServer((req, res) => void handle(req, res));
  const rt = attachFakeRealtime(server);
  let n = 0;
  let seq = 0;
  const c: FakeCloud = {
    url: "",
    rt,
    requests: [],
    codes: new Map(Object.entries(opts.codes ?? { alex: "code-alex" })),
    revoked: new Set(),
    sessions: new Map(),
    sent: [],
    deliveries: [],
    acked: new Set(),
    agentSessions: new Map(),
    heartbeats: 0,
    screens: [],
    jwtTtlMs: opts.jwtTtlMs ?? 15 * 60_000,
    failNext: 0,
    deliver(user, env, push = true) {
      const d = { seq: ++seq, message_id: env.id, username: user, hops: env.hops, envelope: env };
      c.deliveries.push(d);
      if (push) rt.insert("deliveries", { ...d, acked: false, acked_at: null, created_at: new Date().toISOString() });
      return d.seq;
    },
    screensGone: [],
    inputs: new Map(),
    sendInput(user, agents, text, opts = {}) {
      const id = opts.id ?? randomUUID();
      const at = opts.at ?? new Date().toISOString();
      const submit = opts.submit ?? true;
      const code = c.codes.get(opts.signAs ?? user) ?? "";
      const key = createHash("sha256").update(code).digest("hex");
      const msg = ["agentlink-input-v1", user, id, at, agents.join(","), submit ? "1" : "0", text].join("\n");
      const frame: Record<string, unknown> = { id, user, agents, text, submit, at, sig: createHmac("sha256", key).update(msg).digest("hex") };
      opts.tamper?.(frame);
      c.inputs.set(id, { username: user, state: "pending" });
      rt.broadcast(`realtime:input:${opts.channelUser ?? user}`, "input", frame);
      return id;
    },
    expireSessions() {
      c.sessions.clear();
    },
    revoke(user) {
      c.revoked.add(user);
      rt.broadcast(`realtime:user:${user}`, "revoked", { user, at: new Date().toISOString() });
    },
    close: () =>
      new Promise((resolve) => {
        rt.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };

  const loginBody = (user: string) => {
    const session = `sess-${user}-${++n}`;
    c.sessions.set(session, { user, expires: Date.now() + 24 * 3600_000 });
    return {
      session,
      session_expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
      hub_id: "cloud-hub-1",
      hub_name: "agentlink cloud (fake)",
      realtime: { url: c.url, anon_key: "anon-test", jwt: `jwt-${user}-${n}`, jwt_expires_at: new Date(Date.now() + c.jwtTtlMs).toISOString() },
      user,
      owner: false,
    };
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body: unknown = undefined;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "bad_json" });
      }
    }
    const auth = req.headers.authorization ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    c.requests.push({ method: req.method ?? "GET", path: url.pathname + url.search, bearer, body });
    const p = url.pathname;
    const m = req.method;

    if (m === "POST" && p === "/api/auth/login") {
      // the code alone identifies the user; a `user` in the body must match it
      const b = (body ?? {}) as { user?: string; code?: string };
      const who = [...c.codes.entries()].find(([, code]) => code === b.code)?.[0];
      if (!who || (b.user !== undefined && b.user !== who)) return send(res, 401, { error: "bad_code" });
      if (c.revoked.has(who)) return send(res, 403, { error: "revoked" });
      return send(res, 200, loginBody(who));
    }
    if (c.failNext > 0) {
      c.failNext--;
      return send(res, 503, { error: "unavailable" });
    }
    const s = bearer ? c.sessions.get(bearer) : undefined;
    if (!s) return send(res, 401, { error: "unauthorized" });
    if (c.revoked.has(s.user)) return send(res, 401, { error: "revoked" }); // contract: 401 revoked on any route = stop
    const user = s.user;

    if (m === "POST" && p === "/api/auth/refresh") {
      c.sessions.delete(bearer!);
      return send(res, 200, loginBody(user));
    }
    if (m === "POST" && p === "/api/messages") {
      const env = (body as { envelope?: Envelope } | undefined)?.envelope;
      if (!env || typeof env.id !== "string") return send(res, 400, { error: "bad_envelope" });
      if (!env.from.startsWith(`${user}/`)) return send(res, 422, { id: env.id, rejected: true, reason: "from_mismatch" });
      if (env.to.startsWith("nobody/")) return send(res, 422, { id: env.id, rejected: true, reason: "unknown_target" });
      if (!c.sent.some((e) => e.id === env.id)) c.sent.push(env); // idempotent on id
      return send(res, 200, { id: env.id, accepted: true });
    }
    if (m === "GET" && p === "/api/deliveries") {
      // contract: every unacked delivery for the caller with seq > N, oldest first; last_seq = highest returned (or N)
      const since = Number(url.searchParams.get("since_seq") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 500);
      const out = c.deliveries.filter((d) => d.username === user && d.seq > since && !c.acked.has(`${user}|${d.message_id}`)).slice(0, limit);
      return send(res, 200, { deliveries: out.map(({ seq, envelope }) => ({ seq, envelope })), last_seq: out.length ? out[out.length - 1].seq : since });
    }
    if (m === "POST" && p === "/api/deliveries/ack") {
      const ids = (body as { ids?: string[] }).ids ?? [];
      for (const id of ids) {
        c.acked.add(id);
        c.acked.add(`${user}|${id}`);
      }
      return send(res, 200, { acked: ids.length });
    }
    const sm = /^\/api\/sessions\/([^/]+)$/.exec(p);
    if (sm && m === "PUT") {
      c.agentSessions.set(`${user}/${decodeURIComponent(sm[1])}`, body as { kind: string; status: string; task: string });
      return send(res, 200, { ok: true });
    }
    if (sm && m === "DELETE") {
      c.agentSessions.delete(`${user}/${decodeURIComponent(sm[1])}`);
      return send(res, 204, null);
    }
    if (m === "POST" && p === "/api/heartbeat") {
      c.heartbeats++;
      return send(res, 204, null);
    }
    if (m === "POST" && p === "/api/screens") {
      c.screens.push({ at: Date.now(), screen: (body as { screen: ScreenUpdate }).screen });
      return send(res, 204, null);
    }
    if (m === "POST" && p === "/api/screens/gone") {
      c.screensGone.push((body as { agent: string }).agent);
      return send(res, 204, null);
    }
    const im = /^\/api\/panes\/input\/([0-9a-f-]{36})\/result$/.exec(p);
    if (im && m === "POST") {
      const inp = c.inputs.get(im[1]);
      if (!inp || inp.username !== user) return send(res, 404, { error: "not_found" });
      const b = body as { state?: string; results?: Record<string, string> };
      inp.state = b.state ?? "done";
      inp.results = b.results;
      return send(res, 204, null);
    }
    if (m === "GET" && p === "/api/sessions") {
      return send(res, 200, { users: [...c.agentSessions.entries()].map(([address, v]) => ({ address, ...v })) });
    }
    return send(res, 404, { error: "not_found" });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  c.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return c;
}

function send(res: ServerResponse, status: number, body: unknown) {
  if (body === null) return void res.writeHead(status).end();
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
