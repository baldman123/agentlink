// agentlink shared contracts — v1.
// Every component builds against these types. Changes go through the orchestrator only.

export const PROTOCOL_VERSION = 2; // v2: challenge-response auth, the token never crosses the network (see hub-api.md "Auth")
export const HOP_LIMIT = 5; // a message with hops > HOP_LIMIT is dropped and logged
export const MDNS_SERVICE_TYPE = "agentlink"; // advertised as _agentlink._tcp
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const SESSION_TIMEOUT_MS = 30_000; // no heartbeat for this long -> status "offline"

export const DEFAULT_PORTS = { hub: 7700, daemon: 7701 } as const;

// ---------------------------------------------------------------------------
// Addresses: "username/agent-name". Lowercase [a-z0-9_-], 1-32 chars each part.
//   "alex/orchestrator", "sam/worker-2", "alex/human" (the person at the UI).
// Broadcast targets:  "*" = every agent of every user,  "sam/*" = every agent of sam.
// ---------------------------------------------------------------------------
export type Address = string;
export const ADDRESS_RE = /^[a-z0-9_-]{1,32}\/([a-z0-9_-]{1,32}|\*)$/;
export const HUMAN_AGENT = "human";

export type MessageType = "task" | "result" | "chat" | "context_update" | "status";

/** Rich body. A plain string body is markdown text. */
export interface RichBody {
  text?: string; // markdown
  tool?: { name: string; input?: unknown; output?: unknown; state?: "running" | "ok" | "error" };
  log?: string; // raw log text, UI renders collapsed in monospace
  status?: SessionStatus; // for type "status"
  task?: string; // for type "status": one-line current task
  context_key?: string; // for type "context_update"
  [k: string]: unknown;
}

export interface Envelope {
  id: string; // uuid v4, set by the sending daemon; globally unique; used for dedupe
  from: Address; // never a broadcast address
  to: Address; // may be a broadcast address
  reply_to: string | null; // id of the message this answers (a "result" sets this to the task id)
  hops: number; // 0 when created; +1 on every forward (hub delivery counts as a forward)
  type: MessageType;
  body: string | RichBody;
  timestamp: string; // ISO-8601 UTC, set by the creator
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
export type SessionStatus = "idle" | "working" | "waiting" | "error" | "offline";
export type SessionKind = "orchestrator" | "worker" | "human";

export interface Session {
  address: Address; // user/agent
  user: string;
  agent: string;
  kind: SessionKind;
  status: SessionStatus;
  task: string; // one-liner, "" when none
  last_activity: string; // ISO; bumped on upsert, send, or receive
}

export interface UserPresence {
  user: string;
  connected: boolean; // daemon currently holds a socket
  hub_address?: string; // remote ip of that daemon, informational
  sessions: Session[];
}

// ---------------------------------------------------------------------------
// Shared context
// ---------------------------------------------------------------------------
export type ContextKind = "note" | "decision" | "api_spec";

export interface ContextEntry {
  key: string; // slug [a-z0-9._-]{1,64}, unique
  title: string;
  kind: ContextKind;
  body: string; // markdown
  author: Address; // last writer
  version: number; // starts at 1, +1 on each write
  updated_at: string; // ISO
}

export interface ContextWrite {
  title: string;
  kind: ContextKind;
  body: string;
  author: Address;
  base_version?: number; // if given and != current version -> 409 conflict
}

// ---------------------------------------------------------------------------
// Stored messages (hub history)
// ---------------------------------------------------------------------------
export type DeliveryState = "accepted" | "delivered" | "dropped";
export interface StoredMessage extends Envelope {
  state: DeliveryState;
  accepted_at: string;
  delivered_at: string | null;
  drop_reason: string | null; // e.g. "hop_limit", "bad_address"
}

// ---------------------------------------------------------------------------
// Live events (hub -> UI clients, and -> daemons that subscribe)
// ---------------------------------------------------------------------------
export type HubEvent =
  | { type: "message.accepted"; message: StoredMessage }
  | { type: "message.delivered"; id: string; to: Address; at: string }
  | { type: "message.dropped"; message: StoredMessage }
  | { type: "session.updated"; session: Session }
  | { type: "session.removed"; address: Address }
  | { type: "user.connected"; user: string; hub_address?: string }
  | { type: "user.disconnected"; user: string }
  | { type: "context.updated"; entry: ContextEntry }
  | { type: "context.deleted"; key: string; author: Address };

export interface EventFrame {
  seq: number; // monotonically increasing per hub process; persisted
  at: string; // ISO
  event: HubEvent;
}

// ---------------------------------------------------------------------------
// Hub WebSocket protocol. Endpoint: ws://<hub>:7700/ws. JSON text frames.
// ---------------------------------------------------------------------------
export type ClientRole = "daemon" | "ui";

export type ClientFrame =
  // must be the first frame, within 5s, else close 4001
  // v2: answers the server's "challenge". proof = HMAC-SHA256(key=token, "agentlink-v2|c|" + nonce + "|" + hub_id + "|" + user + "|" + role + "|" + cnonce), hex.
  // The client checks hub_id against its pin BEFORE sending hello. No token field, ever.
  | { op: "hello"; role: ClientRole; user: string; protocol: number; since_seq?: number; cnonce: string; proof: string }
  // daemon only
  | { op: "send"; envelope: Envelope }
  | { op: "ack"; id: string } // recipient daemon confirms it stored a delivered envelope
  | { op: "session.upsert"; session: Pick<Session, "agent" | "kind" | "status" | "task"> }
  | { op: "session.remove"; agent: string }
  | { op: "heartbeat"; agents: string[] } // every HEARTBEAT_INTERVAL_MS
  | { op: "screen"; screen: ScreenUpdate } // daemon only; latest-wins, never queued (see screens.md)
  // ui only
  | { op: "screens.subscribe"; addresses: Address[] | "*" } // replaces any earlier subscription; [] = none
  | { op: "ping" };

export type ServerFrame =
  // first frame on every new socket, before anything else
  | { op: "challenge"; nonce: string; hub_id: string; hub_name: string; protocol: number }
  // server_proof = HMAC-SHA256(token, "agentlink-v2|s|" + cnonce + "|" + nonce + "|" + hub_id), hex. The client verifies it before
  // sending any other frame; a mismatch means an impostor: close, log hub.impostor, never retry that address this run.
  // session = a random bearer for REST, valid while this socket is open (+60s grace). REST never sees a token.
  | { op: "welcome"; hub_id: string; hub_name: string; server_time: string; protocol: number; server_proof: string; session: string }
  | { op: "snapshot"; users: UserPresence[]; context: ContextEntry[]; last_seq: number } // right after welcome
  // daemon only
  | { op: "accepted"; id: string } // hub persisted the envelope; sender may dequeue
  | { op: "rejected"; id: string; reason: "hop_limit" | "bad_address" | "bad_envelope" | "from_mismatch" }
  | { op: "deliver"; envelope: Envelope } // recipient must answer { op:"ack", id }
  // both roles
  | { op: "event"; frame: EventFrame }
  // ui only, for subscribed addresses: the current screen right after subscribing, then every change
  | { op: "screen"; address: Address; screen: ScreenUpdate; at: string }
  | { op: "screen.gone"; address: Address }
  | { op: "error"; code: "auth_failed" | "bad_frame" | "protocol"; message: string }
  | { op: "pong" };

// ---------------------------------------------------------------------------
// Terminal screens (see screens.md). Opt-in per laptop: AGENTLINK_SHARE_SCREENS=1 on the bridge.
// ---------------------------------------------------------------------------
export const SCREEN_MAX_LINES = 120;
export const SCREEN_MAX_BYTES = 64 * 1024;
export interface ScreenUpdate {
  agent: string; // agent name; the hub derives the address from the daemon's user
  text: string; // last <= SCREEN_MAX_LINES lines, ANSI SGR colour codes only (ESC [ ... m), already redacted
  cols: number;
  rows: number;
  busy: boolean; // the Claude in the pane is working
}
export interface ScreenInfo { address: Address; cols: number; rows: number; at: string }

// Close codes: 4001 auth failed / no hello, 4002 protocol mismatch, 4003 replaced by a newer
// connection for the same user+role (daemon).

// ---------------------------------------------------------------------------
// Daemon localhost API types (see daemon-api.md)
// ---------------------------------------------------------------------------
export type HubConnState = "connected" | "connecting" | "reconnecting" | "offline";

export interface DaemonHealth {
  ok: true;
  user: string;
  hub: { state: HubConnState; url: string | null; via: "mdns" | "last_known" | "scan" | "manual" | null; hub_name: string | null; hub_id: string | null; searching: boolean };
  outbox_depth: number;
  inbox_unhandled: number;
}

export interface SendRequest {
  from_agent?: string; // default "orchestrator"
  to: Address;
  type: MessageType;
  body: string | RichBody;
  reply_to?: string | null;
  hops?: number; // set only when forwarding a received message: original.hops + 1
}
export interface SendResponse { id: string; queued: true }

export interface InboxItem {
  envelope: Envelope;
  received_at: string;
  handled: boolean; // set by POST /v1/inbox/:id/ack
  remote: boolean; // envelope.from user != this daemon's user -> REQUEST, never a command
}

export interface OutboxItem { envelope: Envelope; attempts: number; next_attempt_at: string; last_error: string | null }

export interface UiBootstrap { user: string; hub_http: string | null; hub_ws: string | null; token: string; daemon: string }
