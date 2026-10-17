import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { HEARTBEAT_INTERVAL_MS, HOP_LIMIT, type Envelope, type HubConnState, type InboxItem, type ScreenUpdate } from "../../contracts/index.ts";
import { UPLOAD_ID_RE, sanitizeFileName, type Attachment } from "../../contracts/index.ts";
import type { Config } from "./config.ts";
import type { HubTarget } from "./discovery.ts";
import { attachmentsOf } from "./files.ts";
import { HubOffline } from "./hublink.ts";
import { CloudInputGate } from "./cloudinput.ts";
import type { InputChannel } from "./input.ts";
import type { DaemonHubLink } from "./link.ts";
import { log, logMsg } from "./log.ts";
import type { Store } from "./store.ts";

// The website's API (contracts/cloud-api.md). Every path and payload the daemon uses is here.
const API = {
  login: "/api/auth/login", // POST {code, user} -> LoginResponse | 401 bad_code | 403 revoked | 429 rate_limited
  refresh: "/api/auth/refresh", // POST (Bearer session) -> LoginResponse
  send: "/api/messages", // POST {envelope} -> 200 {id, accepted} | 422 {id, rejected, reason}
  deliveries: "/api/deliveries", // GET ?since_seq=N&limit=500 -> {deliveries: [{seq, envelope}], last_seq} (unacked, seq > N)
  ack: "/api/deliveries/ack", // POST {ids: message ids} -> {acked}
  session: (agent: string) => `/api/sessions/${encodeURIComponent(agent)}`, // PUT {kind,status,task} | DELETE
  heartbeat: "/api/heartbeat", // POST {agents} -> 204
  screens: "/api/screens", // POST {screen} -> 204
  screensGone: "/api/screens/gone", // POST {agent} -> 204
  inputResult: (id: string) => `/api/panes/input/${id}/result`, // POST {state, results} -> 204
};
const RT = {
  deliveriesTable: "deliveries", // postgres_changes INSERT, filter username=eq.<me>; row {seq, message_id, username, hops, envelope, ...}
  deliveriesChannel: (user: string) => `deliveries:${user}`, // any name works for postgres_changes; RLS limits rows
  userChannel: (user: string) => `user:${user}`, // private; broadcast "revoked" {user, at}
  screensChannel: "screens", // private; watchers track presence {user, watching: "*" | string[]}
  presenceChannel: "presence", // private; this daemon tracks key <user>, {user, kind: "daemon", at}
  inputChannel: (user: string) => `input:${user}`, // private; broadcast "input" {id, user, agents, text, submit, at, sig}, server only
};

interface LoginResponse {
  session: string;
  session_expires_at?: string;
  hub_id?: string | null;
  hub_name?: string | null;
  realtime: { url: string; anon_key: string; jwt: string; jwt_expires_at: string };
}
interface Delivery { seq: number; envelope: Envelope }

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 15_000;
// A wrong code: try again rarely. The API locks an IP out after 10 failed logins in 15 minutes, and that
// IP may be a whole household, so a daemon with a bad code must stay well under it (2 per 15 min).
// A revoked code (403, 401 revoked, or the kick) is never retried: it needs a new code and a restart.
const BAD_CODE_RETRY_MS = 8 * 60_000;
const RESEND_AFTER_MS = 5_000;
const RESEND_MAX_MS = 60_000;
const PUMP_INTERVAL_MS = 1_000;
const SCREEN_MIN_MS = 3_000; // one screen per pane per 3s (CLOUD-PLAN.md)
const REFRESH_AT = 2 / 3; // refresh the Realtime JWT after 2/3 of its lifetime
const REST_TIMEOUT_MS = 10_000;
const SYSTEM_AGENT = "agentlink";
const SEQ_KEY = "cloud_last_seq"; // separate from the LAN hub's last_seq: different seq spaces

/**
 * The daemon's link to the agentlink website: REST for everything it sends, Supabase Realtime for
 * what it receives (deliveries, the revoke kick, who is watching screens). Same surface as HubLink.
 */
export class CloudLink extends EventEmitter implements DaemonHubLink {
  state: HubConnState = "connecting";
  target: HubTarget | null;
  hubName: string | null = null;
  hubId: string | null = null;
  searching = false; // nothing to search for: the website has one address
  readonly relaysFiles = false; // no file storage on the website yet (uploads.md "Website")

  private base: string;
  private session: string | null = null;
  private jwt: string | null = null;
  private rt: SupabaseClient | null = null;
  private channels: RealtimeChannel[] = [];
  private everConnected = false;
  private stopped = false;
  private connecting = false;
  private revoked = false;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pumpTimer: NodeJS.Timeout | null = null;
  private pumping = false;
  private resuming: Promise<void> | null = null;
  private subscribed = new Set<string>(); // channel topics currently SUBSCRIBED
  private watchers = 0; // presence entries on the screens channel other than this daemon
  private screens = new Map<string, { screen: ScreenUpdate; at: string }>();
  private screenSent = new Map<string, number>(); // agent -> last send (ms)
  private screenTimers = new Map<string, NodeJS.Timeout>();
  private watching: "*" | Set<string> = new Set(); // our agents someone watches ("*" = all of them)
  private input: { gate: CloudInputGate; channel: InputChannel; pending: Map<string, string> } | null = null; // local id -> cloud id

  constructor(
    private cfg: Config,
    private store: Store,
  ) {
    super();
    this.base = cfg.hubUrl!;
    this.target = { url: this.base, via: "manual", name: null, hubId: null };
  }

  get connected() {
    return this.state === "connected";
  }

  start() {
    this.pumpTimer = setInterval(() => this.pump(false), PUMP_INTERVAL_MS);
    void this.connect();
  }

  stop() {
    this.stopped = true;
    for (const t of [this.retryTimer, this.refreshTimer, this.heartbeatTimer]) if (t) clearTimeout(t);
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    for (const t of this.screenTimers.values()) clearTimeout(t);
    void this.teardownRealtime();
  }

  private setState(s: HubConnState, detail?: string) {
    if (this.state === s) return;
    this.state = s;
    log("hub.state", { state: s, mode: "cloud", ...(detail ? { detail } : {}) });
    this.emit("state", s);
  }

  // ------------------------------------------------------------------ connect

  private async connect() {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    this.retryTimer = null;
    if (this.state !== "offline") this.setState(this.everConnected ? "reconnecting" : "connecting");
    try {
      const ok = await this.login();
      if (!ok || this.stopped) return;
      await this.openRealtime();
    } catch (err) {
      log("hub.cloud_error", { stage: "connect", detail: String((err as Error).message ?? err) });
      await this.teardownRealtime();
      this.scheduleRetry();
    } finally {
      this.connecting = false;
    }
  }

  /** Log in with the access code. false = refused (state is offline; retried later, or never if revoked). */
  private async login(): Promise<boolean> {
    if (this.revoked) return false;
    const r = await this.call("POST", API.login, { code: this.cfg.token, user: this.cfg.user }, false);
    const err = (r.body as { error?: string; retry_after_s?: number } | null) ?? {};
    if (r.status === 403 || (r.status === 401 && err.error === "revoked")) {
      this.onRevoked("login refused: access code revoked");
      return false;
    }
    if (r.status === 401) {
      log("hub.offline", { mode: "cloud", code: 401, detail: `access code not accepted (${err.error ?? "bad_code"}); next try in ${BAD_CODE_RETRY_MS / 60_000} min` });
      this.goOffline("access code not accepted", BAD_CODE_RETRY_MS);
      return false;
    }
    if (r.status === 429) {
      const wait = Math.max(60, Number(err.retry_after_s) || 900) * 1000;
      log("hub.offline", { mode: "cloud", code: 429, detail: `login rate-limited; next try in ${Math.round(wait / 1000)}s` });
      this.goOffline("login rate-limited", wait);
      return false;
    }
    if (r.status !== 200 || !isLogin(r.body)) throw new Error(`login failed: HTTP ${r.status}`);
    this.applyLogin(r.body);
    log("hub.logged_in", { url: this.base, hub_name: this.hubName, jwt_expires_at: r.body.realtime.jwt_expires_at });
    return true;
  }

  private applyLogin(b: LoginResponse) {
    this.session = b.session;
    this.jwt = b.realtime.jwt;
    if (b.hub_id !== undefined) this.hubId = b.hub_id;
    if (b.hub_name !== undefined) this.hubName = b.hub_name;
    this.target = { url: this.base, via: "manual", name: this.hubName, hubId: this.hubId };
    this.scheduleRefresh(b.realtime.jwt_expires_at);
    if (this.rt) void this.rt.realtime.setAuth(this.jwt);
    // the Realtime client is per login: a new url/key (not expected) means a new client
    this.rtInfo = { url: b.realtime.url, key: b.realtime.anon_key };
  }
  private rtInfo: { url: string; key: string } | null = null;

  /** Re-mint the short-lived Realtime JWT before it expires; a refused refresh means log in again. */
  private scheduleRefresh(expiresAt: string) {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const left = Date.parse(expiresAt) - Date.now();
    const wait = Number.isFinite(left) ? Math.max(1_000, left * REFRESH_AT) : 5 * 60_000;
    this.refreshTimer = setTimeout(() => void this.refresh(), wait);
  }

  private async refresh() {
    if (this.stopped || !this.session) return;
    try {
      const r = await this.call("POST", API.refresh, undefined, true);
      if (r.status === 200 && isLogin(r.body)) {
        this.applyLogin(r.body);
        log("hub.token_refreshed", { jwt_expires_at: r.body.realtime.jwt_expires_at });
        return;
      }
      if (r.status === 401 || r.status === 403) {
        log("hub.session_expired", { code: r.status });
        if (!(await this.login())) return;
        return;
      }
      throw new Error(`HTTP ${r.status}`);
    } catch (err) {
      // the JWT is still valid for a third of its life: try again soon
      log("hub.refresh_failed", { detail: String((err as Error).message ?? err) });
      this.refreshTimer = setTimeout(() => void this.refresh(), 10_000);
    }
  }

  private async openRealtime() {
    if (!this.rtInfo) throw new Error("no realtime config");
    await this.teardownRealtime();
    const rt = createClient(this.rtInfo.url, this.rtInfo.key, {
      accessToken: async () => this.jwt ?? "",
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { heartbeatIntervalMs: 15_000 },
    });
    this.rt = rt;
    // realtime-js fetches the token from accessToken() only after the socket opens, which can lose the
    // race with the joins below; set it first so every phx_join carries the JWT (RLS needs it)
    await rt.realtime.setAuth(this.jwt);
    const user = this.cfg.user;

    const deliveries = rt
      .channel(RT.deliveriesChannel(user))
      .on("postgres_changes", { event: "INSERT", schema: "public", table: RT.deliveriesTable, filter: `username=eq.${user}` }, (p) => {
        const row = p.new as Partial<Delivery> & { envelope?: unknown };
        const env = typeof row.envelope === "string" ? safeJson(row.envelope) : row.envelope;
        void this.onDelivery({ seq: Number(row.seq), envelope: env as Envelope });
      });
    const me = rt
      .channel(RT.userChannel(user), { config: { private: true } })
      .on("broadcast", { event: "revoked" }, () => this.onRevoked("access code revoked (kicked)"));
    // we join screens only to watch who is watching; this daemon never tracks itself there
    const screens = rt
      .channel(RT.screensChannel, { config: { private: true, presence: { key: `${user}:daemon` } } })
      .on("presence", { event: "sync" }, () => this.onWatchers(screens));
    const online = rt.channel(RT.presenceChannel, { config: { private: true, presence: { key: user } } });
    this.channels = [deliveries, me, screens, online];
    if (this.input) {
      const gate = this.input.gate;
      const inputCh = rt
        .channel(RT.inputChannel(user), { config: { private: true } })
        .on("broadcast", { event: "input" }, (msg) => this.onInputFrame(gate, msg.payload));
      this.channels.push(inputCh);
    }

    const all = this.channels.map(
      (ch) =>
        new Promise<void>((resolve, reject) => {
          let first = true;
          ch.subscribe((status, err) => {
            if (status === "SUBSCRIBED") {
              this.subscribed.add(ch.topic);
              if (ch === online) void ch.track({ user, kind: "daemon", at: new Date().toISOString() });
              if (first) {
                first = false;
                resolve();
              } else this.onResubscribed(ch);
            } else {
              this.subscribed.delete(ch.topic);
              if (first) {
                first = false;
                reject(new Error(`realtime ${ch.topic}: ${status}${err ? ` ${err.message}` : ""}`));
              } else this.onChannelDown(ch, status, err);
            }
          });
        }),
    );
    await Promise.all(all);
    if (this.stopped || this.rt !== rt) return;
    await this.onUp();
  }

  private async teardownRealtime() {
    const rt = this.rt;
    this.rt = null;
    this.channels = [];
    this.subscribed.clear();
    this.watchers = 0;
    if (rt) await rt.removeAllChannels().catch(() => {});
  }

  /** Logged in and subscribed: push our state, catch up on what came while we were away, go live. */
  private async onUp() {
    this.attempt = 0;
    await this.resume();
    this.everConnected = true;
    // connected first, so a session registered from here on is PUT by forwardUpsert; then all of them
    // (PUT is idempotent, so one sent twice is harmless)
    this.setState("connected");
    for (const s of this.store.sessions()) await this.sessionPut(s.agent);
    log("hub.connected", { url: this.base, mode: "cloud", hub_name: this.hubName, hub_id: this.hubId, last_seq: this.lastSeq() });
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    void this.heartbeat();
    this.pump(true);
    for (const agent of this.screens.keys()) this.queueScreen(agent);
  }

  /** Realtime came back by itself (realtime-js rejoins): deliveries may have been missed meanwhile. */
  private onResubscribed(ch: RealtimeChannel) {
    if (this.stopped || !this.channels.includes(ch)) return;
    log("hub.realtime_rejoined", { channel: ch.topic });
    if (this.channels.every((c) => this.subscribed.has(c.topic)) && this.state !== "offline") {
      void this.resume().then(() => {
        if (this.stopped || this.revoked) return;
        this.setState("connected");
        this.pump(true);
      });
    }
  }

  private onChannelDown(ch: RealtimeChannel, status: string, err?: Error) {
    // a channel we closed ourselves (shutdown, revoke, or the old client after a rebuild) isn't a drop
    if (this.stopped || !this.channels.includes(ch)) return;
    log("hub.realtime_down", { channel: ch.topic, status, detail: err?.message });
    if (this.state === "connected") this.setState("reconnecting", `realtime ${status}`);
    // realtime-js retries the socket and rejoins on its own. An error on join (e.g. an expired
    // token the server refused) won't clear by itself: rebuild after a short wait.
    if (status === "CHANNEL_ERROR" && !this.retryTimer && !this.connecting) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.connect();
      }, 2_000);
    }
  }

  /** Revoked: offline for good. Only a restart (with a new code) tries again. */
  private onRevoked(detail: string) {
    if (this.revoked) return;
    log("hub.offline", { mode: "cloud", detail: `${detail}; not retrying until the daemon is restarted with a new code` });
    this.revoked = true;
    this.goOffline("access code revoked", null);
  }

  /** Refused: drop everything; retry after `retryMs`, or never (null). */
  private goOffline(detail: string, retryMs: number | null) {
    this.session = null;
    this.jwt = null;
    for (const t of [this.refreshTimer, this.heartbeatTimer]) if (t) clearTimeout(t);
    this.refreshTimer = this.heartbeatTimer = null;
    void this.teardownRealtime();
    this.setState("offline", detail);
    this.attempt = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (retryMs === null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, retryMs);
  }

  private scheduleRetry() {
    if (this.stopped || this.retryTimer || this.revoked) return;
    if (this.state !== "offline") this.setState(this.everConnected ? "reconnecting" : "connecting");
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt);
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  /** A REST call failed in a way that means the link is down (network, 5xx): reconnect. */
  private linkFailed(stage: string, detail: string) {
    log("hub.cloud_error", { stage, detail });
    if (this.state === "connected") this.setState("reconnecting", detail);
    if (!this.connecting && !this.revoked) {
      void this.teardownRealtime();
      this.scheduleRetry();
    }
  }

  // ------------------------------------------------------------------ deliveries

  private lastSeq(): number {
    return Number(this.store.getKv(SEQ_KEY) ?? 0);
  }

  private bumpSeq(seq: number) {
    if (Number.isFinite(seq) && seq > this.lastSeq()) this.store.setKv(SEQ_KEY, String(seq));
  }

  /** Fetch everything after our last seq (unacked deliveries come back too). One at a time. */
  private resume(): Promise<void> {
    if (this.resuming) return this.resuming;
    this.resuming = (async () => {
      try {
        for (let page = 0; page < 50; page++) {
          const since = this.lastSeq();
          const r = await this.call("GET", `${API.deliveries}?since_seq=${since}&limit=500`, undefined, true);
          if (r.status !== 200) throw new Error(`deliveries: HTTP ${r.status}`);
          const b = r.body as { deliveries?: Delivery[]; last_seq?: number };
          const list = Array.isArray(b.deliveries) ? [...b.deliveries].sort((x, y) => x.seq - y.seq) : [];
          for (const d of list) await this.onDelivery(d);
          // nothing left for us: the server's last_seq is where the next resume starts
          if (!list.length) {
            if (typeof b.last_seq === "number") this.bumpSeq(b.last_seq);
            break;
          }
          if (this.lastSeq() <= since) break; // only re-sent unacked rows; no progress to page on
        }
      } finally {
        this.resuming = null;
      }
    })();
    return this.resuming;
  }

  private async onDelivery(d: Delivery) {
    const env = d.envelope;
    if (!env || typeof env.id !== "string" || typeof env.from !== "string" || typeof env.to !== "string") {
      log("msg.dropped", { reason: "bad_envelope", id: (env as { id?: string } | undefined)?.id ?? null, seq: d.seq });
      this.bumpSeq(d.seq);
      return;
    }
    if (typeof env.hops !== "number" || env.hops > HOP_LIMIT) {
      logMsg("msg.dropped", env, { reason: "hop_limit" });
      await this.ack([env.id]);
      this.bumpSeq(d.seq);
      return;
    }
    const stored: InboxItem | null = this.store.inboxInsert(this.localFiles(env));
    logMsg("msg.received", env, { duplicate: !stored, remote: stored?.remote, seq: d.seq });
    await this.ack([env.id]);
    this.bumpSeq(d.seq);
    if (stored) {
      const agent = env.to.split("/")[1];
      if (agent && agent !== "*") this.store.sessionTouch(agent);
      this.emit("inbox", stored);
    }
  }

  /**
   * The website relays no file bytes yet (uploads.md "Website"): a file this laptop has (its own upload) gets its
   * local path back; any other is marked as not available, with the reason.
   */
  private localFiles(env: Envelope): Envelope {
    const atts = attachmentsOf(env.body);
    if (!atts.length) return env;
    const out = atts.map((a): Attachment => {
      const local = typeof a.id === "string" && UPLOAD_ID_RE.test(a.id) ? this.store.uploadGet(a.id) : null;
      const { path: _p, error: _e, ...meta } = a;
      return local && local.sha256 === a.sha256
        ? { ...meta, path: local.path }
        : { ...meta, name: sanitizeFileName(String(a.name ?? "file")), error: "file uploads through the website need storage set up; see SETUP.md" };
    });
    return { ...env, body: { ...(env.body as object), attachments: out } };
  }

  private async ack(ids: string[]) {
    try {
      const r = await this.call("POST", API.ack, { ids }, true);
      if (r.status >= 300) log("hub.ack_failed", { ids, status: r.status });
    } catch (err) {
      // not fatal: the delivery stays unacked and comes back on the next resume; the inbox dedupes it
      log("hub.ack_failed", { ids, detail: String((err as Error).message ?? err) });
    }
  }

  // ------------------------------------------------------------------ outbox

  pump(all: boolean) {
    if (!this.connected || this.pumping) return;
    this.pumping = true;
    void this.pumpOnce(all).finally(() => (this.pumping = false));
  }

  private async pumpOnce(all: boolean) {
    const now = new Date();
    const items = all ? this.store.outboxAll() : this.store.outboxDue(now.toISOString());
    for (const item of items) {
      if (!this.connected) return;
      const attempts = item.attempts + 1;
      const wait = Math.min(RESEND_MAX_MS, RESEND_AFTER_MS * 2 ** (attempts - 1));
      this.store.markAttempt(item.envelope.id, attempts, new Date(Date.now() + wait).toISOString(), attempts > 1 ? "not accepted yet, resent" : null);
      logMsg("msg.sent", item.envelope, { attempt: attempts });
      let r: { status: number; body: unknown };
      try {
        r = await this.call("POST", API.send, { envelope: item.envelope }, true);
      } catch (err) {
        this.linkFailed("send", String((err as Error).message ?? err));
        return; // stays in the outbox, in order
      }
      if (r.status >= 200 && r.status < 300) {
        if (this.store.outboxGet(item.envelope.id)) this.store.dequeue(item.envelope.id);
        logMsg("msg.accepted", item.envelope, { attempts });
      } else if (r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 408 && r.status !== 429) {
        const b = (r.body ?? {}) as { reason?: string; error?: string };
        this.onRejected(item.envelope, b.reason ?? b.error ?? `HTTP ${r.status}`);
      } else {
        // 401 (session gone: call() already tried to log in again), 429, 5xx: keep it, retry later
        log("msg.send_deferred", { id: item.envelope.id, status: r.status });
        if (r.status >= 500) this.linkFailed("send", `HTTP ${r.status}`);
        return;
      }
    }
  }

  private onRejected(env: Envelope, reason: string) {
    if (this.store.outboxGet(env.id)) this.store.dequeue(env.id);
    logMsg("msg.rejected", env, { reason });
    const note: Envelope = {
      id: randomUUID(),
      from: `${this.cfg.user}/${SYSTEM_AGENT}`,
      to: env.from,
      reply_to: env.id,
      hops: 0,
      type: "status",
      body: { text: reason, rejected_id: env.id, rejected_to: env.to },
      timestamp: new Date().toISOString(),
    };
    const stored = this.store.inboxInsert(note);
    logMsg("msg.received", note, { local: true, reason });
    if (stored) this.emit("inbox", stored);
  }

  // ------------------------------------------------------------------ sessions

  private async sessionPut(agent: string) {
    const s = this.store.sessions().find((x) => x.agent === agent);
    if (!s) return;
    const r = await this.call("PUT", API.session(agent), { kind: s.kind, status: s.status, task: s.task }, true);
    if (r.status >= 300) log("hub.session_failed", { agent, status: r.status });
  }

  forwardUpsert(agent: string) {
    if (!this.connected) return; // sent on (re)connect
    void this.sessionPut(agent).catch((err) => this.linkFailed("session", String(err)));
  }

  forwardRemove(agent: string) {
    this.deleteScreen(agent);
    if (!this.connected) return;
    void this.call("DELETE", API.session(agent), undefined, true).catch((err) => this.linkFailed("session", String(err)));
  }

  private async heartbeat() {
    if (!this.connected) return;
    try {
      const r = await this.call("POST", API.heartbeat, { agents: this.store.sessions().map((s) => s.agent) }, true);
      if (r.status >= 500) this.linkFailed("heartbeat", `HTTP ${r.status}`);
    } catch (err) {
      this.linkFailed("heartbeat", String((err as Error).message ?? err));
    }
  }

  // ------------------------------------------------------------------ screens

  putScreen(screen: ScreenUpdate) {
    this.screens.set(screen.agent, { screen, at: new Date().toISOString() });
    this.queueScreen(screen.agent);
  }

  getScreen(agent: string) {
    return this.screens.get(agent) ?? null;
  }

  deleteScreen(agent: string) {
    const had = this.screens.delete(agent);
    const t = this.screenTimers.get(agent);
    if (t) clearTimeout(t);
    this.screenTimers.delete(agent);
    // the website shows the pane until told it's gone (the LAN hub drops it with the session itself)
    if (had && this.connected) void this.call("POST", API.screensGone, { agent }, true).catch(() => {});
  }

  private watched(agent: string): boolean {
    return this.watching === "*" || this.watching.has(agent);
  }

  /** Latest screen per pane, at most one per SCREEN_MIN_MS, and only while someone watches that pane. */
  private queueScreen(agent: string) {
    if (!this.connected || !this.watched(agent) || this.screenTimers.has(agent)) return;
    const wait = Math.max(0, (this.screenSent.get(agent) ?? 0) + SCREEN_MIN_MS - Date.now());
    this.screenTimers.set(
      agent,
      setTimeout(() => {
        this.screenTimers.delete(agent);
        const cur = this.screens.get(agent);
        if (!cur || !this.connected || !this.watched(agent)) return;
        this.screenSent.set(agent, Date.now());
        void this.call("POST", API.screens, { screen: cur.screen }, true)
          .then((r) => r.status >= 300 && log("hub.screen_failed", { agent, status: r.status }))
          .catch(() => {});
      }, wait),
    );
  }

  /** Presence on `screens`: which of our panes anyone (other than this daemon) is watching. */
  private onWatchers(ch: RealtimeChannel) {
    const me = this.cfg.user;
    const own = `${me}:daemon`;
    let all = false;
    const agents = new Set<string>();
    let n = 0;
    for (const [key, metas] of Object.entries(ch.presenceState())) {
      if (key === own) continue;
      for (const meta of metas as Array<{ watching?: unknown }>) {
        const w = meta.watching;
        if (w === "*") all = true;
        else if (Array.isArray(w)) {
          for (const a of w) {
            if (a === `${me}/*`) all = true;
            else if (typeof a === "string" && a.startsWith(`${me}/`)) agents.add(a.slice(me.length + 1));
          }
        } else continue;
        n++;
      }
    }
    const next: "*" | Set<string> = all ? "*" : agents;
    const key = (w: "*" | Set<string>) => (w === "*" ? "*" : [...w].sort().join(","));
    if (key(next) === key(this.watching)) return;
    this.watching = next;
    this.watchers = n;
    log("hub.screen_watchers", { watchers: n, watching: key(next) || "none" });
    for (const agent of this.screens.keys()) this.queueScreen(agent);
  }

  // ------------------------------------------------------------------ input (website -> own panes)

  /** Cloud mode only (input.md "Cloud input"): the gate gets submit(); results go back to the API. */
  attachInput(channel: InputChannel) {
    const pending = new Map<string, string>();
    this.input = { gate: new CloudInputGate(this.cfg.user, this.cfg.token, channel), channel, pending };
    channel.on("finished", (localId: string, state: string, results: Record<string, string>) => {
      const cloudId = pending.get(localId);
      if (!cloudId) return; // a local command-bar request
      pending.delete(localId);
      void this.reportInput(cloudId, state === "done" ? "done" : "failed", results);
    });
  }

  private onInputFrame(gate: CloudInputGate, payload: unknown) {
    const f = payload as { id?: unknown; agents?: unknown } | null;
    if (!this.input) return;
    // no bridge: refuse right away, as the local POST /v1/panes/input does (503 no_bridge)
    if (!this.input.channel.bridgeConnected) {
      const r = gate.check(payload);
      if (r.ok) void this.reportInput(r.id, "failed", Object.fromEntries(r.agents.map((a) => [a, "failed: no_bridge"])));
      return;
    }
    const r = gate.handle(payload);
    if (r.ok) this.input.pending.set(r.localId, String(f?.id));
  }

  private async reportInput(id: string, state: "done" | "failed", results: Record<string, string>) {
    try {
      const r = await this.call("POST", API.inputResult(id), { state, results }, true);
      if (r.status >= 300) log("input.cloud_report_failed", { id, status: r.status });
    } catch (err) {
      log("input.cloud_report_failed", { id, detail: String((err as Error).message ?? err) });
    }
  }

  // ------------------------------------------------------------------ REST

  /** Proxied hub reads/writes (context, peers, messages) with this daemon's session. */
  async rest(method: string, pathAndQuery: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    if (!this.connected || !this.session) throw new HubOffline();
    return this.call(method, pathAndQuery, body, true);
  }

  /**
   * One API call. With `auth`, sends the session as a bearer; a 401 then means the session expired:
   * log in again with the access code once and repeat the call.
   */
  private async call(method: string, path: string, body: unknown, auth: boolean, retried = false): Promise<{ status: number; body: unknown }> {
    if (auth && !this.session) throw new HubOffline();
    const res = await fetch(this.base + path, {
      method,
      headers: {
        ...(auth ? { authorization: `Bearer ${this.session}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: "bad_hub_response", detail: text.slice(0, 200) };
      }
    }
    const errCode = (parsed as { error?: string } | null)?.error;
    if (auth && res.status === 401 && errCode === "revoked") {
      // contract: 401 revoked on any route = stop
      this.onRevoked(`${path.split("?")[0]}: revoked`);
      return { status: res.status, body: parsed };
    }
    if (auth && res.status === 401 && !retried && path !== API.refresh) {
      log("hub.session_expired", { path: path.split("?")[0] });
      if (await this.login()) return this.call(method, path, body, auth, true);
    }
    return { status: res.status, body: parsed };
  }
}

function isLogin(b: unknown): b is LoginResponse {
  const x = b as LoginResponse | null;
  return !!x && typeof x.session === "string" && !!x.realtime && typeof x.realtime.url === "string" && typeof x.realtime.anon_key === "string" && typeof x.realtime.jwt === "string";
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
