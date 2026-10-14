// Typed client for the agentlink daemon localhost API (contracts/daemon-api.md).
// Also holds the hop-limit forward helper and the JSON-lines message log used by the CLI and MCP server.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADDRESS_RE,
  DEFAULT_PORTS,
  HOP_LIMIT,
  type Address,
  type ContextEntry,
  type ContextKind,
  type DaemonHealth,
  type Envelope,
  type InboxItem,
  type MessageType,
  type OutboxItem,
  type RichBody,
  type SendRequest,
  type SendResponse,
  type Session,
  type SessionKind,
  type SessionStatus,
  type StoredMessage,
  type UserPresence,
} from "../../contracts/index.ts";

export const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MESSAGE_TYPES: MessageType[] = ["task", "result", "chat", "context_update", "status"];
export const CONTEXT_KINDS: ContextKind[] = ["note", "decision", "api_spec"];
export const SESSION_STATUSES: SessionStatus[] = ["idle", "working", "waiting", "error", "offline"];

/** Daemon base URL: AGENTLINK_DAEMON_URL, else 127.0.0.1:AGENTLINK_DAEMON_PORT (default 7701). */
export function daemonUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENTLINK_DAEMON_URL) return env.AGENTLINK_DAEMON_URL.replace(/\/+$/, "");
  const port = Number(env.AGENTLINK_DAEMON_PORT) || DEFAULT_PORTS.daemon;
  return `http://127.0.0.1:${port}`;
}

/** A valid `to`: "user/agent", "user/*", or the bare "*" broadcast (ADDRESS_RE alone rejects "*"). */
export function isTargetAddress(addr: string): boolean {
  return addr === "*" || ADDRESS_RE.test(addr);
}

export function defaultAgentFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTLINK_AGENT || "orchestrator";
}

export class DaemonError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail?: unknown,
  ) {
    super(`daemon ${status}: ${code}${detail ? ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`);
  }
}

export class HopLimitError extends Error {
  constructor(public hops: number) {
    super(`hop_limit: this send/forward/reply would carry hops=${hops} > ${HOP_LIMIT}; refused`);
  }
}

// ---------------------------------------------------------------------------
// Logging: one JSON line per message event to logs/orchestrator-<user>.log.
// Never written to stdout (the MCP server speaks JSON-RPC there); set AGENTLINK_LOG_STDERR=1 to mirror to stderr.
// ---------------------------------------------------------------------------
export type LogEvent =
  | "msg.sent"
  | "msg.received"
  | "msg.forwarded"
  | "msg.dropped"
  | "msg.acked"
  | "approval.approved"
  | "approval.declined"
  | "error";

export function logLine(user: string, event: LogEvent, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), component: "orchestrator", user, event, ...fields });
  try {
    const dir = process.env.AGENTLINK_ORCH_LOG_DIR || join(PKG_DIR, "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `orchestrator-${user || "unknown"}.log`), line + "\n");
  } catch {
    // logging must never break messaging
  }
  if (process.env.AGENTLINK_LOG_STDERR === "1") process.stderr.write(line + "\n");
}

function envFields(e: Pick<Envelope, "id" | "from" | "to" | "type" | "hops">) {
  return { id: e.id, from: e.from, to: e.to, type: e.type, hops: e.hops };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
export interface InboxQuery {
  agent?: string;
  unhandled?: boolean;
  since?: string;
  limit?: number;
}

export interface ContextSetInput {
  title: string;
  kind: ContextKind;
  body: string;
  base_version?: number;
  agent?: string;
}

export class DaemonClient {
  readonly baseUrl: string;
  readonly defaultAgent: string;
  private user: string | null = null;
  private seenReceived = new Set<string>();

  constructor(opts: { baseUrl?: string; agent?: string } = {}) {
    this.baseUrl = (opts.baseUrl ?? daemonUrlFromEnv()).replace(/\/+$/, "");
    this.defaultAgent = opts.agent ?? defaultAgentFromEnv();
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new DaemonError(0, "daemon_unreachable", `${this.baseUrl}: ${(err as Error).message}`);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      throw new DaemonError(res.status, json?.error ?? res.statusText, json?.detail ?? json?.current ?? (json ? undefined : text));
    }
    return json as T;
  }

  /** This daemon's username (cached after the first health call). */
  async getUser(): Promise<string> {
    if (!this.user) this.user = (await this.health()).user;
    return this.user;
  }

  private async log(event: LogEvent, fields: Record<string, unknown>) {
    let user = this.user ?? "";
    if (!user) {
      try {
        user = await this.getUser();
      } catch {
        user = "";
      }
    }
    logLine(user, event, fields);
  }

  health(): Promise<DaemonHealth> {
    return this.req<DaemonHealth>("GET", "/v1/health").then((h) => {
      this.user = h.user;
      return h;
    });
  }

  /**
   * Send a message. Use forward() to relay a received one.
   * A reply (reply_to set to a message in this inbox) counts as a hop on that thread: it goes out with
   * hops = max(input.hops, original.hops + 1), so two orchestrators answering each other still hit HOP_LIMIT.
   */
  async send(input: {
    to: Address;
    type: MessageType;
    body: string | RichBody;
    reply_to?: string | null;
    from_agent?: string;
    hops?: number;
  }): Promise<SendResponse> {
    if (!isTargetAddress(input.to)) throw new DaemonError(400, "bad_address", input.to);
    if (!MESSAGE_TYPES.includes(input.type)) throw new DaemonError(400, "bad_type", input.type);
    let hops = input.hops ?? 0;
    if (input.reply_to) {
      const answered = await this.inboxItem(input.reply_to).catch(() => null);
      if (answered) hops = Math.max(hops, answered.envelope.hops + 1);
    }
    const from = `${await this.getUser().catch(() => "?")}/${input.from_agent ?? this.defaultAgent}`;
    if (hops > HOP_LIMIT) {
      await this.log("msg.dropped", { id: null, from, to: input.to, type: input.type, hops, reason: "hop_limit" });
      throw new HopLimitError(hops);
    }
    const req: SendRequest = {
      from_agent: input.from_agent ?? this.defaultAgent,
      to: input.to,
      type: input.type,
      body: input.body,
      reply_to: input.reply_to ?? null,
    };
    if (hops > 0) req.hops = hops;
    try {
      const res = await this.req<SendResponse>("POST", "/v1/send", req);
      await this.log("msg.sent", { id: res.id, from, to: input.to, type: input.type, hops });
      return res;
    } catch (err) {
      if (err instanceof DaemonError && err.code === "hop_limit") {
        await this.log("msg.dropped", { id: null, from, to: input.to, type: input.type, hops, reason: "hop_limit" });
      }
      throw err;
    }
  }

  /**
   * Relay a received message to another address. Sets hops = original.hops + 1 and refuses (logs + throws
   * HopLimitError) when that exceeds HOP_LIMIT. The forwarded copy keeps type and reply_to and records where it came from.
   */
  async forward(
    original: Envelope,
    to: Address,
    opts: { from_agent?: string; note?: string } = {},
  ): Promise<SendResponse> {
    const hops = original.hops + 1;
    const from = `${await this.getUser().catch(() => "?")}/${opts.from_agent ?? this.defaultAgent}`;
    if (hops > HOP_LIMIT) {
      await this.log("msg.dropped", {
        id: original.id,
        from,
        to,
        type: original.type,
        hops,
        reason: "hop_limit",
        detail: "forward refused by orchestrator",
      });
      throw new HopLimitError(hops);
    }
    const base: RichBody = typeof original.body === "string" ? { text: original.body } : { ...original.body };
    // keep the first sender across chained forwards so the recipient can tell the request started with another user
    const prior = base.forwarded as { from?: unknown } | undefined;
    const origin = typeof prior?.from === "string" ? prior.from : original.from;
    const body: RichBody = {
      ...base,
      forwarded: { id: original.id, from: origin, via: original.from, hops: original.hops, ...(opts.note ? { note: opts.note } : {}) },
    };
    const res = await this.send({
      to,
      type: original.type,
      body,
      reply_to: original.reply_to,
      from_agent: opts.from_agent,
      hops,
    });
    await this.log("msg.forwarded", { id: res.id, from, to, type: original.type, hops, original_id: original.id });
    return res;
  }

  async inbox(q: InboxQuery = {}): Promise<InboxItem[]> {
    const p = new URLSearchParams();
    if (q.agent) p.set("agent", q.agent);
    if (q.unhandled) p.set("unhandled", "1");
    if (q.since) p.set("since", q.since);
    if (q.limit) p.set("limit", String(q.limit));
    const qs = p.toString();
    const { messages } = await this.req<{ messages: InboxItem[] }>("GET", `/v1/inbox${qs ? "?" + qs : ""}`);
    for (const m of messages) await this.noteReceived(m);
    return messages;
  }

  /** Find one inbox item by envelope id (searches every local agent, handled or not). */
  async inboxItem(id: string): Promise<InboxItem | null> {
    const all = await this.inbox({ limit: 1000 });
    return all.find((m) => m.envelope.id === id) ?? null;
  }

  private async noteReceived(m: InboxItem) {
    if (this.seenReceived.has(m.envelope.id)) return;
    this.seenReceived.add(m.envelope.id);
    await this.log("msg.received", { ...envFields(m.envelope), remote: m.remote });
  }

  async ack(id: string): Promise<void> {
    await this.req<void>("POST", `/v1/inbox/${encodeURIComponent(id)}/ack`);
    await this.log("msg.acked", { id });
  }

  /** Subscribe to new inbox arrivals over SSE. Resolves when the stream ends or the signal aborts. */
  async stream(onItem: (item: InboxItem) => void | Promise<void>, opts: { agent?: string; signal?: AbortSignal } = {}) {
    const qs = opts.agent ? `?agent=${encodeURIComponent(opts.agent)}` : "";
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/inbox/stream${qs}`, {
        headers: { accept: "text/event-stream" },
        signal: opts.signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) return;
      throw new DaemonError(0, "daemon_unreachable", (err as Error).message);
    }
    if (!res.ok || !res.body) throw new DaemonError(res.status, "stream_failed");
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let sep: number;
        while ((sep = buf.search(/\r?\n\r?\n/)) >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep).replace(/^\r?\n\r?\n/, "");
          let event = "message";
          const data: string[] = [];
          for (const line of raw.split(/\r?\n/)) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          }
          if (event !== "message" || data.length === 0) continue;
          try {
            const item = JSON.parse(data.join("\n")) as InboxItem;
            await this.noteReceived(item);
            await onItem(item);
          } catch {
            // skip malformed frames
          }
        }
      }
    } catch (err) {
      if (opts.signal?.aborted) return;
      throw err;
    }
  }

  outbox(): Promise<OutboxItem[]> {
    return this.req<{ items: OutboxItem[] }>("GET", "/v1/outbox").then((r) => r.items);
  }

  contextList(q?: string): Promise<ContextEntry[]> {
    const qs = q ? `?q=${encodeURIComponent(q)}` : "";
    return this.req<{ entries: ContextEntry[] }>("GET", `/v1/context${qs}`).then((r) => r.entries);
  }

  contextGet(key: string): Promise<ContextEntry> {
    return this.req<ContextEntry>("GET", `/v1/context/${encodeURIComponent(key)}`);
  }

  contextSet(key: string, input: ContextSetInput): Promise<ContextEntry> {
    return this.req<ContextEntry>("PUT", `/v1/context/${encodeURIComponent(key)}`, {
      ...input,
      agent: input.agent ?? this.defaultAgent,
    });
  }

  peers(): Promise<UserPresence[]> {
    return this.req<{ users: UserPresence[] }>("GET", "/v1/peers").then((r) => r.users);
  }

  messages(q: { address?: string; with?: string; limit?: number; before?: string } = {}): Promise<StoredMessage[]> {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
    const qs = p.toString();
    return this.req<{ messages: StoredMessage[] }>("GET", `/v1/messages${qs ? "?" + qs : ""}`).then((r) => r.messages);
  }

  /**
   * Ids among `ids` that this user really sent, per hub history (plus anything still in the local outbox).
   * `peers` are the addresses to search (the hub matches `address` against from OR to). Fails closed:
   * when the hub can't be asked, nothing is confirmed.
   */
  async sentByMe(ids: string[], peers: Address[]): Promise<Set<string>> {
    const want = new Set(ids);
    const found = new Set<string>();
    if (!want.size) return found;
    const me = await this.getUser();
    const own = (from: string) => from.split("/")[0] === me;
    try {
      for (const o of await this.outbox()) if (want.has(o.envelope.id) && own(o.envelope.from)) found.add(o.envelope.id);
    } catch {
      // outbox unavailable: rely on the hub
    }
    for (const peer of new Set(peers)) {
      if (found.size === want.size) break;
      try {
        for (const m of await this.messages({ address: peer, limit: 500 })) {
          if (want.has(m.id) && own(m.from)) found.add(m.id);
        }
      } catch {
        // hub offline: leave unconfirmed
      }
    }
    return found;
  }

  setSession(agent: string, s: { kind?: SessionKind; status: SessionStatus; task?: string }): Promise<Session> {
    return this.req<Session>("PUT", `/v1/sessions/${encodeURIComponent(agent)}`, {
      kind: s.kind ?? "orchestrator",
      status: s.status,
      task: s.task ?? "",
    });
  }

  removeSession(agent: string): Promise<void> {
    return this.req<void>("DELETE", `/v1/sessions/${encodeURIComponent(agent)}`);
  }
}
