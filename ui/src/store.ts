import type {
  Address,
  ContextEntry,
  DaemonHealth,
  EventFrame,
  ServerFrame,
  Session,
  StoredMessage,
  UserPresence,
} from "../../contracts/index.ts";
import { HUMAN_AGENT } from "../../contracts/index.ts";
import { involves, safeStorage, userOf, type ConnState } from "./lib.ts";

export interface Activity {
  id: string;
  at: string;
  kind: "message" | "context" | "presence";
  from?: Address;
  to?: Address;
  label: string; // message type, or "context", "online", "offline"
  text: string; // short description
  contextKey?: string;
  toast: boolean;
}

/** A live message hop, drawn as a pulse in the Team view. Only created from live hub events. */
export interface Pulse {
  id: string; // message id
  from: Address;
  to: Address;
  type: string;
  at: number; // when accepted (ms)
  deliveredAt?: number;
}

export interface State {
  me: string | null;
  conn: ConnState;
  connDetail: string;
  hubName: string | null;
  hubUrl: string | null;
  users: Record<string, UserPresence>;
  context: Record<string, ContextEntry>;
  messages: Record<string, StoredMessage>;
  history: Record<Address, "loading" | "ready" | "error" | "more">;
  lastSeq: number | undefined;
  snapshotReady: boolean;
  unread: Record<Address, number>;
  selected: Address | null;
  activity: Activity[];
  flash: Record<string, number>; // context key -> when it last changed live
  pulses: Pulse[];
  /** Local-only "clear chat history": messages before this are hidden in this browser (nothing is deleted). */
  historyCutoff: string | null;
  hubId: string | null; // from the UI socket's welcome
  /** The daemon's view of its hub link (GET /v1/health): how it was found, the pinned id, searching. */
  daemonHub: DaemonHealth["hub"] | null;
}

export const initialState: State = {
  me: null,
  conn: "connecting",
  connDetail: "",
  hubName: null,
  hubUrl: null,
  users: {},
  context: {},
  messages: {},
  history: {},
  lastSeq: undefined,
  snapshotReady: false,
  unread: {},
  selected: null,
  activity: [],
  flash: {},
  pulses: [],
  historyCutoff: null,
  hubId: null,
  daemonHub: null,
};

export const cutoffKey = (user: string) => `al.historyCutoff.${user}`;

const PULSE_KEEP_MS = 4000;

/** Orchestrator first, then worker-1..N by number, then everything else by name. */
export function sessionRank(s: Pick<Session, "agent" | "kind">): [number, number, string] {
  if (s.kind === "orchestrator" || s.agent === "orchestrator") return [0, 0, s.agent];
  const n = /^worker-(\d+)$/.exec(s.agent);
  if (n) return [1, Number(n[1]), s.agent];
  return [2, 0, s.agent];
}
export function sortSessions<T extends Pick<Session, "agent" | "kind">>(xs: T[]): T[] {
  return [...xs].sort((a, b) => {
    const [a0, a1, a2] = sessionRank(a);
    const [b0, b1, b2] = sessionRank(b);
    return a0 - b0 || a1 - b1 || a2.localeCompare(b2);
  });
}
/** A user runs a claude4 team when its sessions include worker-N agents. */
export const viaClaude4 = (u: UserPresence) => u.sessions.some((s) => /^worker-\d+$/.test(s.agent));

export type Action =
  | { type: "boot"; me: string; hubUrl: string | null }
  | { type: "conn"; state: ConnState; detail?: string }
  | { type: "frame"; frame: ServerFrame }
  | { type: "select"; address: Address }
  | { type: "history"; address: Address; status: State["history"][string]; messages?: StoredMessage[] }
  | { type: "context.local"; entry: ContextEntry }
  | { type: "toast.done"; id: string }
  | { type: "history.cutoff"; at: string | null }
  | { type: "health"; hub: DaemonHealth["hub"] | null };

const LIVE_WINDOW_MS = 15_000; // replayed events older than this don't toast

/** Chats in the left column: you, then your user's agents. */
export function myChats(s: State): Address[] {
  if (!s.me) return [];
  const own = s.users[s.me]?.sessions ?? [];
  return [`${s.me}/${HUMAN_AGENT}`, ...sortSessions(own.filter((x) => x.agent !== HUMAN_AGENT)).map((x) => x.address)];
}

/** One message in the signed-in user's chat with their own boss: <me>/human <-> <me>/orchestrator. */
export function inBossThread(me: string | null, m: StoredMessage): boolean {
  if (!me || m.type === "status" || m.type === "context_update") return false;
  const human = `${me}/${HUMAN_AGENT}`, boss = `${me}/orchestrator`;
  return (m.from === human && m.to === boss) || (m.from === boss && m.to === human);
}

/** The boss thread, oldest first. */
export function bossThread(s: State): StoredMessage[] {
  return Object.values(s.messages)
    .filter((m) => inBossThread(s.me, m))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** How long a message to the boss shows "waiting" without an answer before we stop claiming it's coming. */
export const BOSS_WAIT_MAX_MS = 30 * 60_000;

/**
 * Messages you sent the boss that it hasn't answered yet: id -> sent at (ms). Answered = the boss sent
 * something with that reply_to (a result, normally; a chat reply counts too). Dropped messages and ones
 * older than BOSS_WAIT_MAX_MS aren't waiting on anything.
 */
export function bossPending(s: State, now = Date.now()): Record<string, number> {
  if (!s.me) return {};
  const boss = `${s.me}/orchestrator`;
  const thread = bossThread(s);
  const answered = new Set(thread.filter((m) => m.from === boss && m.reply_to).map((m) => m.reply_to!));
  const out: Record<string, number> = {};
  for (const m of thread) {
    if (m.from === boss || m.state === "dropped" || answered.has(m.id)) continue;
    const at = Date.parse(m.timestamp);
    if (now - at < BOSS_WAIT_MAX_MS) out[m.id] = at;
  }
  return out;
}

export function findSession(s: State, a: Address): Session | undefined {
  return s.users[userOf(a)]?.sessions.find((x) => x.address === a);
}

function upsertSession(users: State["users"], session: Session): State["users"] {
  const u = users[session.user] ?? { user: session.user, connected: true, sessions: [] };
  const i = u.sessions.findIndex((x) => x.address === session.address);
  const sessions = i < 0 ? [...u.sessions, session] : u.sessions.map((x, j) => (j === i ? session : x));
  return { ...users, [session.user]: { ...u, sessions } };
}

function pushActivity(s: State, a: Activity): Activity[] {
  // replayed events (since_seq after a reconnect) must not re-toast or duplicate
  if (s.activity.some((x) => x.id === a.id)) return s.activity;
  return [a, ...s.activity].slice(0, 40);
}

function applyEvent(s: State, f: EventFrame): State {
  const e = f.event;
  const live = Date.now() - Date.parse(f.at) < LIVE_WINDOW_MS;
  const next: State = { ...s, lastSeq: Math.max(s.lastSeq ?? 0, f.seq) };
  switch (e.type) {
    case "message.accepted":
    case "message.dropped": {
      const m = e.message;
      if (s.messages[m.id] && e.type === "message.accepted") return next;
      next.messages = { ...s.messages, [m.id]: m };
      // context_update envelopes duplicate context.updated, which already has its own activity line
      if (m.type === "context_update") return next;
      if (live && e.type === "message.accepted") {
        const now = Date.now();
        next.pulses = [...s.pulses.filter((p) => now - p.at < PULSE_KEEP_MS), { id: m.id, from: m.from, to: m.to, type: m.type, at: now }];
      }
      // unread: chats this message reaches that aren't open, unless you sent it
      if (s.me && m.from !== `${s.me}/${HUMAN_AGENT}`) {
        const unread = { ...s.unread };
        for (const addr of myChats(s)) {
          if (addr !== s.selected && addr !== m.from && involves(m, addr)) unread[addr] = (unread[addr] ?? 0) + 1;
        }
        next.unread = unread;
      }
      const cross = m.to === "*" || userOf(m.from) !== userOf(m.to);
      if (cross || e.type === "message.dropped") {
        const toMe = s.me != null && (userOf(m.to) === s.me || m.to === "*") && userOf(m.from) !== s.me;
        next.activity = pushActivity(s, {
          id: m.id,
          at: m.timestamp,
          kind: "message",
          from: m.from,
          to: m.to,
          label: e.type === "message.dropped" ? "dropped" : m.type,
          text: e.type === "message.dropped" ? `dropped (${m.drop_reason ?? "unknown"})` : verb(m.type),
          toast: live && (toMe || e.type === "message.dropped"),
        });
      }
      return next;
    }
    case "message.delivered": {
      const m = s.messages[e.id];
      if (!m) return next;
      next.messages = { ...s.messages, [e.id]: { ...m, state: "delivered", delivered_at: e.at } };
      if (s.pulses.some((p) => p.id === e.id && !p.deliveredAt))
        next.pulses = s.pulses.map((p) => (p.id === e.id ? { ...p, deliveredAt: Date.now() } : p));
      return next;
    }
    case "session.updated":
      next.users = upsertSession(s.users, e.session);
      return next;
    case "session.removed": {
      const u = s.users[userOf(e.address)];
      if (!u) return next;
      next.users = { ...s.users, [u.user]: { ...u, sessions: u.sessions.filter((x) => x.address !== e.address) } };
      return next;
    }
    case "user.connected":
    case "user.disconnected": {
      const on = e.type === "user.connected";
      const u = s.users[e.user] ?? { user: e.user, connected: on, sessions: [] };
      next.users = { ...s.users, [e.user]: { ...u, connected: on, hub_address: on && "hub_address" in e ? e.hub_address ?? u.hub_address : u.hub_address } };
      if (e.user !== s.me)
        next.activity = pushActivity(s, {
          id: `p${f.seq}`, at: f.at, kind: "presence", label: on ? "online" : "offline",
          text: on ? `${e.user} joined the hub` : `${e.user} left the hub`, toast: false,
        });
      return next;
    }
    case "context.updated":
      next.context = { ...s.context, [e.entry.key]: e.entry };
      next.flash = { ...s.flash, [e.entry.key]: Date.now() };
      next.activity = pushActivity(s, {
        id: `c${f.seq}`, at: e.entry.updated_at, kind: "context", from: e.entry.author, label: "context",
        text: `context updated: ${e.entry.title}`, contextKey: e.entry.key,
        toast: live && userOf(e.entry.author) !== s.me,
      });
      return next;
    case "context.deleted": {
      const ctx = { ...s.context };
      const title = ctx[e.key]?.title ?? e.key;
      delete ctx[e.key];
      next.context = ctx;
      next.activity = pushActivity(s, {
        id: `c${f.seq}`, at: f.at, kind: "context", from: e.author, label: "context",
        text: `context removed: ${title}`, toast: live && userOf(e.author) !== s.me,
      });
      return next;
    }
  }
  return next;
}

function verb(t: string) {
  switch (t) {
    case "task": return "sent a task to";
    case "result": return "sent a result to";
    case "status": return "sent a status to";
    case "context_update": return "shared context with";
    default: return "messaged";
  }
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "boot":
      return { ...s, me: a.me, hubUrl: a.hubUrl, historyCutoff: s.me === a.me ? s.historyCutoff : safeStorage<string | null>(cutoffKey(a.me), null) };
    case "history.cutoff":
      return { ...s, historyCutoff: a.at };
    case "health":
      return { ...s, daemonHub: a.hub };
    case "conn":
      return { ...s, conn: a.state, connDetail: a.detail ?? "" };
    case "frame": {
      const f = a.frame;
      if (f.op === "welcome") return { ...s, hubName: f.hub_name, hubId: f.hub_id };
      if (f.op === "snapshot") {
        const users: State["users"] = {};
        for (const u of f.users) users[u.user] = u;
        const context: State["context"] = {};
        for (const c of f.context) context[c.key] = c;
        // keep our replay cursor if we are ahead; the hub replays seq > since_seq next
        const lastSeq = s.lastSeq == null ? f.last_seq : Math.min(s.lastSeq, f.last_seq);
        const st: State = { ...s, users, context, lastSeq, snapshotReady: true };
        if (!st.selected) {
          const chats = myChats(st);
          st.selected = chats.find((c) => c.endsWith("/orchestrator")) ?? chats[0] ?? null;
        }
        return st;
      }
      if (f.op === "event") return applyEvent(s, f.frame);
      return s;
    }
    case "select":
      return { ...s, selected: a.address, unread: { ...s.unread, [a.address]: 0 } };
    case "history": {
      const messages = { ...s.messages };
      for (const m of a.messages ?? []) if (!messages[m.id]) messages[m.id] = m;
      return { ...s, messages, history: { ...s.history, [a.address]: a.status } };
    }
    case "context.local":
      return { ...s, context: { ...s.context, [a.entry.key]: a.entry } };
    case "toast.done":
      return { ...s, activity: s.activity.map((x) => (x.id === a.id ? { ...x, toast: false } : x)) };
  }
}
