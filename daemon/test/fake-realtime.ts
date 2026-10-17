// Test helper: a stand-in for Supabase Realtime that speaks the Phoenix protocol realtime-js uses
// (vsn 2.0.0: every text frame is [join_ref, ref, topic, event, payload]). Enough for the daemon's
// cloud link: channel joins with postgres_changes bindings, INSERT pushes filtered by `col=eq.value`,
// presence state/diffs, broadcasts, access_token refreshes, and dropping every socket to test reconnects.
// It never stores anything: tests push rows into it as if Postgres had committed them.
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

type Frame = [string | null, string | null, string, string, Record<string, unknown>];
interface PgBinding { id: number; event: string; schema: string; table?: string; filter?: string }
interface Join { ws: WebSocket; topic: string; joinRef: string; token: string | null; pg: PgBinding[]; presenceKey: string | null }

export interface FakeRealtime {
  /** Every channel currently joined. */
  joins(): Array<{ topic: string; token: string | null; pg: PgBinding[] }>;
  /** Push a committed INSERT to every subscriber whose binding matches. Returns how many sockets got it. */
  insert(table: string, record: Record<string, unknown>, schema?: string): number;
  /** Presence on a topic: replaces that topic's state (key -> metas) and sends presence_diff to joined sockets. */
  setPresence(topic: string, state: Record<string, Array<Record<string, unknown>>>): void;
  /** What the clients themselves tracked (event "presence" track): topic -> key -> meta. */
  tracked(): Record<string, Record<string, unknown>>;
  broadcast(topic: string, event: string, payload: Record<string, unknown>): void;
  /** Tokens received in access_token messages (JWT refreshes pushed by the client). */
  tokenPushes(): string[];
  /** Close every socket (as when Realtime restarts); clients reconnect and rejoin. */
  dropAll(): void;
  /** Tokens the server refuses at join (an expired or revoked JWT). */
  refuse(token: string): void;
  connections(): number;
  close(): void;
}

/** Attach to an http.Server; serves ws at /realtime/v1/websocket. */
export function attachFakeRealtime(server: Server): FakeRealtime {
  const wss = new WebSocketServer({ noServer: true });
  const joins: Join[] = [];
  const presence = new Map<string, Record<string, Array<Record<string, unknown>>>>();
  const tracked: Record<string, Record<string, unknown>> = {};
  const pushes: string[] = [];
  const refused = new Set<string>();
  let nextBinding = 1000;
  let ref = 0;

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/realtime/v1/websocket") return; // someone else's upgrade
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });

  const send = (ws: WebSocket, f: Frame) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(f));
  };
  const reply = (ws: WebSocket, f: Frame, status: "ok" | "error", response: Record<string, unknown>) =>
    send(ws, [f[0], f[1], f[2], "phx_reply", { status, response }]);

  wss.on("connection", (ws) => {
    ws.on("message", (data, isBinary) => {
      if (isBinary) return; // client broadcasts are binary-encoded; the daemon sends none
      let f: Frame;
      try {
        f = JSON.parse(data.toString());
      } catch {
        return;
      }
      const [joinRef, , topic, event, payload] = f;
      if (topic === "phoenix" && event === "heartbeat") return reply(ws, f, "ok", {});
      if (event === "phx_join") {
        const token = typeof payload.access_token === "string" ? payload.access_token : null;
        if (token && refused.has(token)) return reply(ws, f, "error", { reason: "Invalid token" });
        const cfg = (payload.config ?? {}) as { postgres_changes?: Array<Omit<PgBinding, "id">>; presence?: { key?: string } };
        const pg = (cfg.postgres_changes ?? []).map((b) => ({ ...b, id: nextBinding++ }));
        for (let i = joins.length - 1; i >= 0; i--) if (joins[i].ws === ws && joins[i].topic === topic) joins.splice(i, 1);
        joins.push({ ws, topic, joinRef: joinRef ?? "", token, pg, presenceKey: cfg.presence?.key || null });
        reply(ws, f, "ok", { postgres_changes: pg });
        // like Realtime: the current presence state right after a join
        send(ws, [joinRef, null, topic, "presence_state", wrap(presence.get(topic) ?? {})]);
        return;
      }
      if (event === "phx_leave") {
        for (let i = joins.length - 1; i >= 0; i--) if (joins[i].ws === ws && joins[i].topic === topic) joins.splice(i, 1);
        return reply(ws, f, "ok", {});
      }
      if (event === "access_token") {
        if (typeof payload.access_token === "string") {
          pushes.push(payload.access_token);
          for (const j of joins) if (j.ws === ws && j.topic === topic) j.token = payload.access_token;
        }
        return;
      }
      if (event === "presence") {
        const p = payload as { type?: string; event?: string; payload?: Record<string, unknown> };
        const j = joins.find((x) => x.ws === ws && x.topic === topic);
        const key = j?.presenceKey ?? "anon";
        tracked[topic] ??= {};
        if (p.event === "track") tracked[topic][key] = p.payload ?? {};
        else if (p.event === "untrack") delete tracked[topic][key];
        return reply(ws, f, "ok", {});
      }
    });
    ws.on("close", () => {
      for (let i = joins.length - 1; i >= 0; i--) if (joins[i].ws === ws) joins.splice(i, 1);
    });
  });

  const matches = (b: PgBinding, table: string, schema: string, record: Record<string, unknown>) => {
    if (b.event !== "*" && b.event !== "INSERT") return false;
    if (b.schema !== "*" && b.schema !== schema) return false;
    if (b.table && b.table !== "*" && b.table !== table) return false;
    if (b.filter) {
      const m = /^([a-z_]+)=(eq|in)\.(.+)$/.exec(b.filter);
      if (!m) return false;
      const v = String(record[m[1]] ?? "");
      if (m[2] === "eq" && v !== m[3]) return false;
      if (m[2] === "in" && !m[3].replace(/^\(|\)$/g, "").split(",").includes(v)) return false;
    }
    return true;
  };

  return {
    joins: () => joins.map((j) => ({ topic: j.topic, token: j.token, pg: j.pg })),
    insert(table, record, schema = "public") {
      let n = 0;
      for (const j of joins) {
        const ids = j.pg.filter((b) => matches(b, table, schema, record)).map((b) => b.id);
        if (!ids.length) continue;
        n++;
        const columns = Object.keys(record).map((name) => ({ name, type: typeof record[name] === "number" ? "int8" : typeof record[name] === "object" ? "jsonb" : "text" }));
        send(j.ws, [null, null, j.topic, "postgres_changes", {
          ids,
          data: { schema, table, type: "INSERT", commit_timestamp: new Date().toISOString(), columns, record, errors: null },
        }]);
      }
      return n;
    },
    setPresence(topic, state) {
      const before = presence.get(topic) ?? {};
      presence.set(topic, state);
      const joinsDiff: typeof state = {};
      const leaves: typeof state = {};
      // a key whose metas changed leaves and joins again, as Realtime does on a re-track
      for (const k of Object.keys(state)) if (JSON.stringify(before[k]) !== JSON.stringify(state[k])) joinsDiff[k] = state[k];
      for (const k of Object.keys(before)) if (JSON.stringify(before[k]) !== JSON.stringify(state[k])) leaves[k] = before[k];
      for (const j of joins) if (j.topic === topic) send(j.ws, [null, null, topic, "presence_diff", { joins: wrap(joinsDiff), leaves: wrap(leaves) }]);
    },
    tracked: () => tracked,
    broadcast(topic, event, payload) {
      for (const j of joins) if (j.topic === topic) send(j.ws, [null, String(++ref), topic, "broadcast", { type: "broadcast", event, payload }]);
    },
    tokenPushes: () => pushes,
    dropAll() {
      for (const ws of wss.clients) ws.terminate();
      joins.length = 0;
    },
    refuse: (t) => void refused.add(t),
    connections: () => wss.clients.size,
    close() {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

/**
 * presence_state/presence_diff carry {key: {metas: [...]}}, each meta with a phx_ref. Refs are unique per
 * meta object (as in Realtime), and stable, so a leave removes exactly the meta that joined earlier.
 */
const refs = new WeakMap<object, string>();
let refN = 0;
function wrap(state: Record<string, Array<Record<string, unknown>>>) {
  const out: Record<string, { metas: Array<Record<string, unknown>> }> = {};
  for (const [k, metas] of Object.entries(state)) {
    out[k] = {
      metas: metas.map((m) => {
        if (!refs.has(m)) refs.set(m, `ref-${++refN}`);
        return { phx_ref: refs.get(m), ...m };
      }),
    };
  }
  return out;
}
