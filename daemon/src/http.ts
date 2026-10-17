import http from "node:http";
import { randomUUID } from "node:crypto";
import {
  ADDRESS_RE,
  HOP_LIMIT,
  SCREEN_MAX_BYTES,
  type DaemonHealth,
  type Envelope,
  type InboxItem,
  type MessageType,
  type SendRequest,
  type SendResponse,
  type SessionKind,
  type SessionStatus,
  type UiBootstrap,
} from "../../contracts/index.ts";
import type { Config } from "./config.ts";
import { HubOffline } from "./hublink.ts";
import type { DaemonHubLink } from "./link.ts";
import { InputChannel } from "./input.ts";
import { log, logMsg } from "./log.ts";
import type { Store } from "./store.ts";

const AGENT_RE = /^[a-z0-9_-]{1,32}$/;
const MESSAGE_TYPES: MessageType[] = ["task", "result", "chat", "context_update", "status"];
const SESSION_KINDS: SessionKind[] = ["orchestrator", "worker", "human"];
const SESSION_STATUSES: SessionStatus[] = ["idle", "working", "waiting", "error", "offline"];
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const MAX_BODY = 1_000_000;
const SSE_KEEPALIVE_MS = 15_000;

class HttpError extends Error {
  constructor(
    public status: number,
    public error: string,
    public detail?: string,
  ) {
    super(error);
  }
}

// contracts/input.md request shapes (no shared types for these in contracts/index.ts)
interface InputRequestBody {
  agents: string[];
  text: string;
  submit?: boolean;
}
interface InputResultBody {
  results: Record<string, string>; // "sent" | "skipped: prompt_open" | "skipped: no_pane" | "failed: <why>"
}

interface SseClient {
  res: http.ServerResponse;
  agent: string | null;
}

export function createServer(cfg: Config, store: Store, hub: DaemonHubLink) {
  const sse = new Set<SseClient>();
  const input = new InputChannel(); // only these HTTP handlers can reach it; the hub link has no reference
  // ...except in cloud mode, where the website's signed frames come in through CloudInputGate (input.md)
  hub.attachInput?.(input);
  const allowedHosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`, `[::1]:${cfg.port}`]);

  hub.on("inbox", (item: InboxItem) => {
    const data = `event: message\ndata: ${JSON.stringify(item)}\n\n`;
    for (const c of sse) if (matchesAgent(item, c.agent, cfg.user)) c.res.write(data);
  });
  const keepalive = setInterval(() => {
    for (const c of sse) c.res.write(": keepalive\n\n");
  }, SSE_KEEPALIVE_MS);

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    try {
      // DNS-rebinding guard: only answer requests addressed to the loopback name.
      if (!req.headers.host || !allowedHosts.has(req.headers.host)) throw new HttpError(403, "forbidden_host");
      if (origin !== undefined) {
        if (!LOCAL_ORIGIN_RE.test(origin) && origin !== cfg.uiOrigin) throw new HttpError(403, "forbidden_origin");
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        // X-Agentlink-Input is allowed only on the input endpoint and only for the UI's exact origin,
        // so no other page's preflight for it can succeed.
        const inputPreflight = new URL(req.url ?? "/", "http://localhost").pathname === "/v1/panes/input" && origin === cfg.uiOrigin;
        res.writeHead(204, {
          "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
          "access-control-allow-headers": inputPreflight ? "content-type, x-agentlink-input" : "content-type",
          "access-control-max-age": "600",
        });
        res.end();
        return;
      }
      await route(req, res);
    } catch (err) {
      if (err instanceof HttpError) return json(res, err.status, { error: err.error, ...(err.detail ? { detail: err.detail } : {}) });
      if (err instanceof HubOffline) return json(res, 503, { error: "hub_offline" });
      log("http.error", { method: req.method, url: req.url, detail: String(err) });
      if (!res.headersSent) json(res, 502, { error: "hub_error", detail: String((err as Error)?.message ?? err) });
      else res.end();
    }
  });

  async function route(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    const m = req.method ?? "GET";
    let match: RegExpMatchArray | null;

    if (m === "GET" && p === "/v1/health") {
      const body: DaemonHealth = {
        ok: true,
        user: cfg.user,
        hub: {
          state: hub.state,
          url: hub.target?.url ?? null,
          via: hub.target?.via ?? null,
          hub_name: hub.hubName,
          hub_id: hub.hubId,
          searching: hub.searching,
        },
        outbox_depth: store.outboxDepth(),
        inbox_unhandled: store.inboxUnhandled(),
      };
      return json(res, 200, body);
    }

    if (m === "GET" && p === "/v1/ui-bootstrap") {
      const httpUrl = hub.target?.url ?? null;
      const body: UiBootstrap = {
        user: cfg.user,
        hub_http: httpUrl,
        // the website has no hub socket; its live feed is Supabase Realtime (contracts/cloud-api.md)
        hub_ws: httpUrl && cfg.hubMode === "lan" ? httpUrl.replace(/^http/, "ws") + "/ws" : null,
        token: cfg.token,
        daemon: `http://127.0.0.1:${cfg.port}`,
      };
      return json(res, 200, body);
    }

    if (m === "POST" && p === "/v1/send") return send(req, res);

    if (m === "GET" && p === "/v1/inbox") {
      const agent = url.searchParams.get("agent");
      if (agent !== null && !AGENT_RE.test(agent)) throw new HttpError(400, "bad_agent");
      const since = url.searchParams.get("since");
      if (since !== null && Number.isNaN(Date.parse(since))) throw new HttpError(400, "bad_since");
      const limit = clampInt(url.searchParams.get("limit"), 100, 1, 1000);
      const unhandled = ["1", "true"].includes(url.searchParams.get("unhandled") ?? "");
      const messages = store.inboxList({
        agent: agent ?? undefined,
        unhandled,
        since: since ? new Date(since).toISOString() : undefined,
        limit,
      });
      return json(res, 200, { messages });
    }

    if (m === "GET" && p === "/v1/inbox/stream") {
      const agent = url.searchParams.get("agent");
      if (agent !== null && !AGENT_RE.test(agent)) throw new HttpError(400, "bad_agent");
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      const client: SseClient = { res, agent };
      sse.add(client);
      req.on("close", () => sse.delete(client));
      return;
    }

    if (m === "POST" && (match = p.match(/^\/v1\/inbox\/([^/]+)\/ack$/))) {
      if (!store.inboxAck(decodeURIComponent(match[1]))) throw new HttpError(404, "not_found");
      res.writeHead(204).end();
      return;
    }

    if (m === "GET" && p === "/v1/outbox") return json(res, 200, { items: store.outboxAll() });

    // ---- hub proxies ----
    if (m === "GET" && p === "/v1/context") {
      const q = url.searchParams.get("q");
      return proxy(res, "GET", "/api/context" + (q !== null ? `?q=${encodeURIComponent(q)}` : ""));
    }
    if ((match = p.match(/^\/v1\/context\/([^/]+)$/))) {
      const key = match[1]; // still URI-encoded; passed through as-is
      if (m === "GET") return proxy(res, "GET", `/api/context/${key}`);
      if (m === "PUT") {
        const b = (await readJson(req)) as Record<string, unknown>;
        const agent = b.agent ?? "orchestrator";
        if (typeof agent !== "string" || !AGENT_RE.test(agent)) throw new HttpError(400, "bad_agent");
        const write = {
          title: b.title,
          kind: b.kind,
          body: b.body,
          author: `${cfg.user}/${agent}`, // the LAN hub reads author
          agent, // the website reads agent and sets author itself (contracts/cloud-api.md "Shared context")
          ...(b.base_version !== undefined ? { base_version: b.base_version } : {}),
        };
        return proxy(res, "PUT", `/api/context/${key}`, write);
      }
    }
    if (m === "GET" && p === "/v1/peers") return proxy(res, "GET", "/api/sessions");
    if (m === "GET" && p === "/v1/messages") return proxy(res, "GET", "/api/messages" + url.search);

    // ---- local terminal input (input.md): the local person typing into their own panes ----
    if (p === "/v1/panes/input" && m === "POST") {
      // exact UI origin (a missing Origin fails too), plus the custom header that forces a preflight
      if (req.headers.origin !== cfg.uiOrigin) throw new HttpError(403, "forbidden_origin", "input is accepted only from the agentlink UI");
      if (req.headers["x-agentlink-input"] !== "1") throw new HttpError(403, "missing_header", "X-Agentlink-Input: 1 is required");
      const b = (await readJson(req)) as Partial<InputRequestBody>;
      const agents = b.agents;
      if (!Array.isArray(agents) || agents.length < 1 || agents.length > 16 || !agents.every((a) => typeof a === "string" && AGENT_RE.test(a)))
        throw new HttpError(400, "bad_agents", "agents must be 1-16 local agent names");
      if (new Set(agents).size !== agents.length) throw new HttpError(400, "bad_agents", "duplicate agent");
      if (typeof b.text !== "string" || b.text.length < 1 || b.text.length > 4000) throw new HttpError(400, "bad_text", "text must be 1-4000 characters");
      if (b.submit !== undefined && typeof b.submit !== "boolean") throw new HttpError(400, "bad_submit");
      if (!input.bridgeConnected) throw new HttpError(503, "no_bridge", "no bridge is connected to this daemon");
      const id = input.submit(agents, b.text, b.submit ?? true);
      return json(res, 202, { id });
    }
    // The bridge's endpoints refuse anything with an Origin header: a browser always sends one, the
    // bridge (a node process) never does. So no web page can read the typed text or forge results.
    if (p === "/v1/panes/input/stream" && m === "GET") {
      if (req.headers.origin !== undefined) throw new HttpError(403, "forbidden_origin", "bridge only");
      input.attachBridge(req, res);
      return;
    }
    if ((match = p.match(/^\/v1\/panes\/input\/([0-9a-f-]{36})\/result$/)) && m === "POST") {
      if (req.headers.origin !== undefined) throw new HttpError(403, "forbidden_origin", "bridge only");
      const b = (await readJson(req)) as Partial<InputResultBody>;
      const results = b.results;
      if (!results || typeof results !== "object" || Array.isArray(results) || !Object.values(results).every((v) => typeof v === "string"))
        throw new HttpError(400, "bad_results");
      const r = input.result(match[1], results);
      if (r === "unknown") throw new HttpError(404, "not_found");
      if (r === "finished") throw new HttpError(409, "already_finished");
      res.writeHead(204).end();
      return;
    }
    if ((match = p.match(/^\/v1\/panes\/input\/([0-9a-f-]{36})$/)) && m === "GET") {
      const s = input.status(match[1]);
      if (!s) throw new HttpError(404, "not_found");
      return json(res, 200, s);
    }

    // ---- screens (screens.md): memory only, forwarded to the hub as {op:"screen"} ----
    if ((match = p.match(/^\/v1\/screens\/([^/]+)$/))) {
      const agent = decodeURIComponent(match[1]);
      if (!AGENT_RE.test(agent)) throw new HttpError(400, "bad_agent");
      if (m === "GET") {
        const s = hub.getScreen(agent);
        if (!s) throw new HttpError(404, "not_found");
        return json(res, 200, { ...s.screen, at: s.at });
      }
      if (m === "DELETE") {
        hub.deleteScreen(agent);
        res.writeHead(204).end();
        return;
      }
      if (m === "PUT") {
        const b = (await readJson(req)) as Record<string, unknown>;
        if (b.agent !== undefined && b.agent !== agent) throw new HttpError(400, "bad_agent", "body agent differs from the path");
        if (typeof b.text !== "string") throw new HttpError(400, "bad_text");
        if (Buffer.byteLength(b.text, "utf8") > SCREEN_MAX_BYTES) throw new HttpError(413, "screen_too_large", `max ${SCREEN_MAX_BYTES} bytes`);
        const dim = (v: unknown) => Number.isInteger(v) && (v as number) > 0 && (v as number) <= 2000;
        if (!dim(b.cols) || !dim(b.rows)) throw new HttpError(400, "bad_size", "cols and rows must be integers 1-2000");
        hub.putScreen({ agent, text: b.text, cols: b.cols as number, rows: b.rows as number, busy: b.busy === true });
        res.writeHead(204).end();
        return;
      }
    }

    // ---- sessions ----
    if ((match = p.match(/^\/v1\/sessions\/([^/]+)$/))) {
      const agent = decodeURIComponent(match[1]);
      if (!AGENT_RE.test(agent)) throw new HttpError(400, "bad_agent");
      if (m === "PUT") {
        const b = (await readJson(req)) as Record<string, unknown>;
        const kind = (b.kind ?? "worker") as SessionKind;
        const status = (b.status ?? "idle") as SessionStatus;
        const task = b.task ?? "";
        if (!SESSION_KINDS.includes(kind)) throw new HttpError(400, "bad_kind");
        if (!SESSION_STATUSES.includes(status)) throw new HttpError(400, "bad_status");
        if (typeof task !== "string") throw new HttpError(400, "bad_task");
        const session = store.sessionUpsert(agent, kind, status, task);
        hub.forwardUpsert(agent);
        log("session.upsert", { agent, kind, status });
        return json(res, 200, session);
      }
      if (m === "DELETE") {
        store.sessionRemove(agent);
        hub.forwardRemove(agent);
        log("session.remove", { agent });
        res.writeHead(204).end();
        return;
      }
    }

    throw new HttpError(404, "not_found", `${m} ${p}`);
  }

  async function send(req: http.IncomingMessage, res: http.ServerResponse) {
    const b = (await readJson(req)) as Partial<SendRequest>;
    const fromAgent = b.from_agent ?? "orchestrator";
    if (typeof fromAgent !== "string" || !AGENT_RE.test(fromAgent)) throw new HttpError(400, "bad_address", "from_agent");
    if (typeof b.to !== "string" || !(b.to === "*" || ADDRESS_RE.test(b.to))) throw new HttpError(400, "bad_address", "to");
    if (!b.type || !MESSAGE_TYPES.includes(b.type)) throw new HttpError(400, "bad_type");
    if (typeof b.body !== "string" && (typeof b.body !== "object" || b.body === null || Array.isArray(b.body)))
      throw new HttpError(400, "bad_body");
    const replyTo = b.reply_to ?? null;
    if (replyTo !== null && typeof replyTo !== "string") throw new HttpError(400, "bad_reply_to");
    const hops = b.hops ?? 0;
    if (!Number.isInteger(hops) || hops < 0) throw new HttpError(400, "bad_hops");

    const env: Envelope = {
      id: randomUUID(),
      from: `${cfg.user}/${fromAgent}`,
      to: b.to,
      reply_to: replyTo,
      hops,
      type: b.type,
      body: b.body,
      timestamp: new Date().toISOString(),
    };
    if (hops > HOP_LIMIT) {
      logMsg("msg.dropped", env, { reason: "hop_limit" });
      throw new HttpError(422, "hop_limit");
    }
    store.enqueue(env);
    store.sessionTouch(fromAgent);
    logMsg("msg.queued", env);
    hub.pump(false);
    const body: SendResponse = { id: env.id, queued: true };
    return json(res, 202, body);
  }

  async function proxy(res: http.ServerResponse, method: string, path: string, body?: unknown) {
    const r = await hub.rest(method, path, body);
    if (r.status === 204 || r.body === null) {
      res.writeHead(r.status).end();
      return;
    }
    return json(res, r.status, r.body);
  }

  return {
    server,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(cfg.port, "127.0.0.1", () => resolve());
      }),
    close: () => {
      clearInterval(keepalive);
      input.close();
      for (const c of sse) c.res.end();
      server.close();
    },
  };
}

function matchesAgent(item: InboxItem, agent: string | null, user: string): boolean {
  if (!agent) return true;
  const to = item.envelope.to;
  return to === `${user}/${agent}` || to === `${user}/*` || to === "*";
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body_too_large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) throw new HttpError(400, "bad_json", "empty body");
  try {
    const v = JSON.parse(text);
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not an object");
    return v;
  } catch (err) {
    throw new HttpError(400, "bad_json", String((err as Error).message));
  }
}

function clampInt(raw: string | null, def: number, min: number, max: number): number {
  if (raw === null) return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) return def;
  return Math.max(min, Math.min(max, n));
}
