import type {
  Address,
  ContextEntry,
  ContextWrite,
  RichBody,
  SendRequest,
  SendResponse,
  ServerFrame,
  StoredMessage,
  UiBootstrap,
} from "../../contracts/index.ts";

export type ConnState = "connecting" | "connected" | "reconnecting" | "offline";

export interface MessageQuery {
  address: Address;
  with?: Address;
  limit?: number;
  before?: string;
}

export type ContextPutResult =
  | { ok: true; entry: ContextEntry }
  | { ok: false; conflict: ContextEntry }
  | { ok: false; error: string };

// Local pane input (contracts/input.md; no shared types for it in contracts/index.ts).
export interface PaneInputRequest {
  agents: string[]; // local agent names: orchestrator, worker-1..worker-4
  text: string; // 1..4000 chars
  submit?: boolean; // default true: press Enter after the paste
}
export type PaneResult = "sent" | "skipped: prompt_open" | "skipped: no_pane" | `failed: ${string}`;
export interface PaneInputStatus {
  id: string;
  state: "pending" | "done" | "failed";
  results?: Record<string, PaneResult>;
}
export type PaneInputResponse =
  | { ok: true; id: string }
  | { ok: false; kind: "no_bridge" | "forbidden" | "bad_request" | "network"; message: string };
export const PANE_INPUT_MAX = 4000;

export interface ConnectHandlers {
  onFrame(frame: ServerFrame): void;
  onState(state: ConnState, detail?: string): void;
}

/** Everything the UI needs from the outside world. Real = hub + daemon; mock = in-memory. */
export interface Transport {
  readonly mock: boolean;
  bootstrap(): Promise<UiBootstrap>;
  /** Opens the live socket and keeps it open (reconnecting). Returns a disposer. */
  connect(handlers: ConnectHandlers, sinceSeq: () => number | undefined): () => void;
  messages(q: MessageQuery): Promise<StoredMessage[]>;
  send(req: SendRequest): Promise<SendResponse>;
  putContext(key: string, write: Omit<ContextWrite, "author"> & { agent?: string }): Promise<ContextPutResult>;
  /** Replaces the live-screen subscription ([] = none). Re-sent automatically after a reconnect. */
  subscribeScreens(addresses: Address[]): void;
  /** Types into this laptop's own panes via the daemon + bridge (trusted local input; never crosses the hub). */
  paneInput(req: PaneInputRequest): Promise<PaneInputResponse>;
  paneInputStatus(id: string): Promise<PaneInputStatus | null>;
}

// ---------------------------------------------------------------------------

export const userOf = (a: Address) => a.split("/")[0] ?? a;
export const agentOf = (a: Address) => a.split("/")[1] ?? "";

/** True when a message is addressed to, or sent by, `addr` (broadcasts reach everyone). */
export function involves(m: { from: Address; to: Address }, addr: Address): boolean {
  if (m.from === addr || m.to === addr) return true;
  if (m.to === "*") return true;
  return m.to === `${userOf(addr)}/*`;
}

export function bodyOf(b: string | RichBody): RichBody {
  return typeof b === "string" ? { text: b } : b;
}

export function bodyPreview(b: string | RichBody): string {
  const r = bodyOf(b);
  if (r.text) return r.text.replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim();
  if (r.tool) return `tool: ${r.tool.name}`;
  if (r.task) return r.task;
  if (r.status) return `status: ${r.status}`;
  if (r.log) return "log output";
  return "";
}

const USER_HUES = ["#3FB8AF", "#9B87F5", "#E5739A", "#5AA9E6", "#9CC56A", "#E8845C", "#C792EA", "#4DB6E8"];
export function userColor(user: string): string {
  let h = 0;
  for (const ch of user) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return USER_HUES[h % USER_HUES.length];
}

export function relTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function clockTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function safeStorage<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
export function saveStorage(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode etc. */
  }
}

export const params = new URLSearchParams(location.search);
export const DAEMON_PORT = Number(/\d{2,5}/.exec(params.get("daemon") ?? "")?.[0] ?? 7701);
export const MOCK = params.get("mock") === "1";
