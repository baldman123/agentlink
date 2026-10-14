// Minimal stand-in for the real hub, for daemon testing only. In-memory; implements just enough of
// contracts/hub-api.md: hello/welcome/snapshot, send -> accepted/rejected, routing with hops+1,
// pending delivery for offline users, ack, heartbeat/ping, and a few REST endpoints.
// Usage: AGENTLINK_TOKEN=x FAKE_HUB_PORT=7790 tsx test/fake-hub.ts
import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ADDRESS_RE,
  HOP_LIMIT,
  PROTOCOL_VERSION,
  type ClientFrame,
  type ContextEntry,
  type Envelope,
  type ServerFrame,
} from "../../contracts/index.ts";

const token = process.env.AGENTLINK_TOKEN ?? "";
const port = Number(process.env.FAKE_HUB_PORT ?? 7790);
const HUB_ID = process.env.FAKE_HUB_ID ?? "fake";
if (!token) throw new Error("AGENTLINK_TOKEN required");

const daemons = new Map<string, WebSocket>();
const seen = new Set<string>();
const pending = new Map<string, Envelope[]>(); // user -> unacked deliveries
const sessions = new Map<string, Record<string, unknown>>();
const context = new Map<string, ContextEntry>();
let seq = 0;

const out = (ws: WebSocket, f: ServerFrame) => ws.send(JSON.stringify(f));
const flog = (event: string, extra: object) => console.log(JSON.stringify({ component: "fake-hub", event, ...extra }));

function deliver(user: string, env: Envelope) {
  const list = pending.get(user) ?? [];
  if (!list.some((e) => e.id === env.id)) list.push(env);
  pending.set(user, list);
  const ws = daemons.get(user);
  if (ws) out(ws, { op: "deliver", envelope: env });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/api/health") return res.end(JSON.stringify({ ok: true, hub_id: HUB_ID, hub_name: "fake-hub", protocol: 1 }));
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  if (url.pathname === "/api/sessions") return res.end(JSON.stringify({ users: [...sessions.values()] }));
  if (url.pathname === "/api/messages") return res.end(JSON.stringify({ messages: [], query: url.search }));
  if (url.pathname === "/api/context") return res.end(JSON.stringify({ entries: [...context.values()] }));
  const m = url.pathname.match(/^\/api\/context\/(.+)$/);
  if (m && req.method === "GET") {
    const e = context.get(m[1]);
    res.writeHead(e ? 200 : 404).end(JSON.stringify(e ?? { error: "not_found" }));
    return;
  }
  if (m && req.method === "PUT") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const w = JSON.parse(body);
      const cur = context.get(m[1]);
      if (w.base_version !== undefined && w.base_version !== (cur?.version ?? 0)) {
        res.writeHead(409).end(JSON.stringify({ error: "conflict", current: cur }));
        return;
      }
      const e: ContextEntry = { key: m[1], title: w.title, kind: w.kind, body: w.body, author: w.author, version: (cur?.version ?? 0) + 1, updated_at: new Date().toISOString() };
      context.set(m[1], e);
      res.end(JSON.stringify(e));
    });
    return;
  }
  res.writeHead(404).end(JSON.stringify({ error: "not_found" }));
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  let user: string | null = null;
  const helloTimer = setTimeout(() => ws.close(4001, "no hello"), 5000);
  ws.on("message", (raw) => {
    const f = JSON.parse(raw.toString()) as ClientFrame;
    if (!user) {
      if (f.op !== "hello" || f.token !== token) {
        out(ws, { op: "error", code: "auth_failed", message: "bad token" });
        ws.close(4001, "auth failed");
        return;
      }
      clearTimeout(helloTimer);
      user = f.user;
      daemons.get(user)?.close(4003, "replaced");
      daemons.set(user, ws);
      flog("hello", { user, since_seq: f.since_seq });
      out(ws, { op: "welcome", hub_id: HUB_ID, hub_name: "fake-hub", server_time: new Date().toISOString(), protocol: PROTOCOL_VERSION });
      out(ws, { op: "snapshot", users: [], context: [...context.values()], last_seq: seq });
      for (const env of pending.get(user) ?? []) out(ws, { op: "deliver", envelope: env });
      return;
    }
    switch (f.op) {
      case "send": {
        const env = f.envelope;
        flog("send", { id: env.id, from: env.from, to: env.to });
        if (seen.has(env.id)) return out(ws, { op: "accepted", id: env.id });
        if (env.from.split("/")[0] !== user) return out(ws, { op: "rejected", id: env.id, reason: "from_mismatch" });
        // "reject/me" is a test hook so the daemon's rejected path can be exercised.
        if (env.to === "reject/me" || !(env.to === "*" || ADDRESS_RE.test(env.to))) return out(ws, { op: "rejected", id: env.id, reason: "bad_address" });
        if (env.hops > HOP_LIMIT) return out(ws, { op: "rejected", id: env.id, reason: "hop_limit" });
        seen.add(env.id);
        seq++;
        out(ws, { op: "accepted", id: env.id });
        const fwd = { ...env, hops: env.hops + 1 };
        if (fwd.hops > HOP_LIMIT) return;
        if (env.to === "*") {
          for (const u of daemons.keys()) if (u !== user) deliver(u, fwd);
        } else deliver(env.to.split("/")[0], fwd);
        return;
      }
      case "ack": {
        const list = pending.get(user) ?? [];
        pending.set(user, list.filter((e) => e.id !== f.id));
        flog("ack", { user, id: f.id });
        return;
      }
      case "session.upsert":
        sessions.set(`${user}/${f.session.agent}`, { user, ...f.session });
        flog("session.upsert", { user, agent: f.session.agent });
        return;
      case "session.remove":
        sessions.delete(`${user}/${f.agent}`);
        return;
      case "heartbeat":
        flog("heartbeat", { user, agents: f.agents });
        return;
      case "ping":
        return out(ws, { op: "pong" });
    }
  });
  ws.on("close", () => {
    clearTimeout(helloTimer);
    if (user && daemons.get(user) === ws) daemons.delete(user);
  });
});

server.listen(port, "127.0.0.1", () => flog("listening", { port }));
