// The reused UI (ui/src) talks to a Transport. This one speaks contracts/cloud-api.md: REST for reads and
// writes, Realtime for live changes, which it turns into the hub's ServerFrames so the store stays as is.
import type {
  Address,
  ContextEntry,
  EventFrame,
  HubEvent,
  ScreenUpdate,
  ServerFrame,
  Session,
  StoredMessage,
  CloudFileCreated,
  UiBootstrap,
  UploadResult,
  UserPresence,
} from "../../../contracts/index.ts";
import { UploadUnavailable, type ConnectHandlers, type ContextPutResult, type MessageQuery, type PaneInputResponse, type PaneInputStatus, type Transport } from "../../../ui/src/lib.ts";
import { screenStore } from "../../../ui/src/screens.ts";
import { api, ApiError, getConfig, getMe, refresh, signOut, type Me } from "./api.ts";
import { openLive, type DbChange, type Live, type PresenceEntry } from "./realtime.ts";

const REFRESH_EARLY_MS = 2 * 60_000; // renew the 15-minute Realtime JWT this long before it ends
const SNAPSHOT_DEBOUNCE_MS = 800;

// ---------------------------------------------------------------------------
// row -> shared type (contracts/cloud-api.md, "Realtime summary")

export function messageFromRow(r: Record<string, unknown>): StoredMessage {
  return {
    id: String(r.id),
    from: String(r.from_addr),
    to: String(r.to_addr),
    reply_to: (r.reply_to as string | null) ?? null,
    hops: Number(r.hops ?? 0),
    type: r.type as StoredMessage["type"],
    body: r.body as StoredMessage["body"],
    timestamp: String(r.timestamp),
    state: r.state as StoredMessage["state"],
    accepted_at: String(r.accepted_at ?? r.timestamp),
    delivered_at: (r.delivered_at as string | null) ?? null,
    drop_reason: (r.drop_reason as string | null) ?? null,
  };
}

export function sessionFromRow(r: Record<string, unknown>): Session {
  return {
    address: String(r.address),
    user: String(r.username),
    agent: String(r.agent),
    kind: r.kind as Session["kind"],
    status: r.status as Session["status"],
    task: String(r.task ?? ""),
    last_activity: String(r.last_activity ?? new Date().toISOString()),
  };
}

export function contextFromRow(r: Record<string, unknown>): ContextEntry {
  return {
    key: String(r.key),
    title: String(r.title ?? r.key),
    kind: (r.kind as ContextEntry["kind"]) ?? "note",
    body: String(r.body ?? ""),
    author: String(r.author ?? ""),
    version: Number(r.version ?? 1),
    updated_at: String(r.updated_at ?? new Date().toISOString()),
  };
}

/** One Realtime row change as the hub event the store already understands (null = nothing to show). */
export function eventFromChange(c: DbChange): HubEvent | null {
  if (c.table === "messages") {
    const m = messageFromRow(c.row);
    if (c.type === "INSERT") return { type: m.state === "dropped" ? "message.dropped" : "message.accepted", message: m };
    if (c.type === "UPDATE" && m.state === "delivered") return { type: "message.delivered", id: m.id, to: m.to, at: m.delivered_at ?? new Date().toISOString() };
    if (c.type === "UPDATE" && m.state === "dropped") return { type: "message.dropped", message: m };
    return null;
  }
  if (c.table === "sessions") {
    if (c.type === "DELETE") return { type: "session.removed", address: String(c.row.address) };
    return { type: "session.updated", session: sessionFromRow(c.row) };
  }
  if (c.type === "DELETE") return { type: "context.deleted", key: String(c.row.key), author: String(c.row.author ?? "") };
  return { type: "context.updated", entry: contextFromRow(c.row) };
}

/** Users with a daemon in `presence` right now. */
export const daemonUsers = (entries: PresenceEntry[]) => new Set(entries.filter((e) => e.kind === "daemon").map((e) => e.user));

/** Presence is the live truth for "online": a user without a daemon entry shows offline, and so do their sessions. */
export function withPresence(users: UserPresence[], online: Set<string> | null): UserPresence[] {
  if (!online) return users;
  return users.map((u) => {
    const on = online.has(u.user);
    return { ...u, connected: on, sessions: on ? u.sessions : u.sessions.map((s) => ({ ...s, status: "offline" as const })) };
  });
}

// ---------------------------------------------------------------------------

export function cloudTransport(): Transport & { me(): Me | null } {
  let me: Me | null = null;
  const uploaded = new Map<string, UploadResult>(); // files reserved and uploaded from this page, by id
  let live: Live | null = null;
  let seq = 0;
  let screenSubs: Address[] = [];
  let screensChannel: ReturnType<Live["screens"]> | null = null;
  // a daemon notices a new watcher and publishes at most every 3s, so the first screen can take a few seconds
  screenStore.setGrace(8_000);

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.signedOut) void signOut(e.code === "revoked" ? "revoked" : undefined);
    throw e;
  };

  async function bootstrap(): Promise<UiBootstrap> {
    me = await getMe().catch(fail);
    return { user: me!.user, hub_http: location.origin, hub_ws: null, token: "", daemon: "" };
  }

  function connect(h: ConnectHandlers): () => void {
    let disposed = false;
    let online: Set<string> | null = null;
    let lastUsers: UserPresence[] = [];
    let wasDown = false;
    let snapTimer: number | undefined;
    let refreshTimer: number | undefined;
    const stops: (() => void)[] = [];

    const emit = (event: HubEvent) => {
      const frame: EventFrame = { seq: ++seq, at: new Date().toISOString(), event };
      h.onFrame({ op: "event", frame });
    };

    async function snapshot() {
      try {
        const s = await api<{ users: UserPresence[]; context: ContextEntry[] }>("/api/snapshot");
        if (disposed) return;
        lastUsers = s.users;
        h.onFrame({ op: "snapshot", users: withPresence(s.users, online), context: s.context, last_seq: seq });
      } catch (e) {
        if (e instanceof ApiError && e.signedOut) return void signOut(e.code === "revoked" ? "revoked" : undefined);
        h.onState("offline", "can't load the teams; retrying");
        scheduleSnapshot(5_000);
      }
    }
    const scheduleSnapshot = (ms = SNAPSHOT_DEBOUNCE_MS) => {
      window.clearTimeout(snapTimer);
      snapTimer = window.setTimeout(() => void snapshot(), ms);
    };

    function scheduleRefresh(expiresAt: string) {
      window.clearTimeout(refreshTimer);
      const wait = Math.max(30_000, Date.parse(expiresAt) - Date.now() - REFRESH_EARLY_MS);
      refreshTimer = window.setTimeout(async () => {
        try {
          const r = await refresh();
          await live?.setAuth(r.realtime.jwt);
          scheduleRefresh(r.realtime.jwt_expires_at);
        } catch (e) {
          if (e instanceof ApiError && e.signedOut) return void signOut(e.code === "revoked" ? "revoked" : undefined);
          scheduleRefresh(new Date(Date.now() + REFRESH_EARLY_MS + 30_000).toISOString()); // try again in 30s
        }
      }, wait);
    }

    async function open() {
      h.onState("connecting");
      if (!me) {
        try {
          await bootstrap();
        } catch {
          if (!disposed) h.onState("offline", "can't reach agentlink");
          return;
        }
      }
      const cfg = await getConfig().catch(() => null);
      if (disposed || !me) return;
      const welcome: ServerFrame = {
        op: "welcome",
        hub_id: cfg?.hub_id ?? "",
        hub_name: cfg?.hub_name ?? "agentlink",
        server_time: new Date().toISOString(),
        protocol: 0,
        server_proof: "",
        session: "",
      };
      h.onFrame(welcome);

      try {
        live = await openLive(me.realtime);
      } catch {
        h.onState("offline", "can't open live updates");
        return;
      }
      if (disposed) return;
      scheduleRefresh(me.realtime.jwt_expires_at);
      stops.push(
        live.db(
          (c) => {
            const ev = eventFromChange(c);
            if (!ev) return;
            if (ev.type === "session.updated" && online && !online.has(ev.session.user)) ev.session = { ...ev.session, status: "offline" };
            emit(ev);
          },
          (s) => {
            if (s === "live") {
              h.onState("connected");
              // after a drop, changes may have been missed: reload the teams (chats reload when opened)
              if (wasDown) scheduleSnapshot(0);
              wasDown = false;
            } else if (s === "down") {
              wasDown = true;
              h.onState("reconnecting", "live updates dropped; reconnecting");
            }
          },
        ),
      );
      stops.push(
        live.presence(me.user, (entries) => {
          const next = daemonUsers(entries);
          const prev = online;
          online = next;
          if (!prev) return scheduleSnapshot(0); // first sync: redo "online" from presence
          const joined = [...next].filter((u) => !prev.has(u));
          const left = [...prev].filter((u) => !next.has(u));
          for (const user of joined) emit({ type: "user.connected", user });
          for (const user of left) emit({ type: "user.disconnected", user });
          if (joined.length || left.length) {
            // offline at once for the user who left; a returning daemon's statuses come from a fresh snapshot
            for (const u of lastUsers) if (prev.has(u.user) && !next.has(u.user)) for (const s of u.sessions) emit({ type: "session.updated", session: { ...s, status: "offline" } });
            scheduleSnapshot();
          }
        }),
      );
      stops.push(live.revoked(me.user, () => void signOut("revoked")));
      screensChannel = live.screens(me.user, (e) => {
        const address = String(e.payload.address ?? "");
        if (!screenSubs.includes(address)) return;
        if (e.event === "screen") h.onFrame({ op: "screen", address, screen: e.payload.screen as ScreenUpdate, at: String(e.payload.at ?? new Date().toISOString()) });
        else h.onFrame({ op: "screen.gone", address });
      });
      if (screenSubs.length) screensChannel.watch(screenSubs);
      await snapshot();
    }

    void open();
    return () => {
      disposed = true;
      window.clearTimeout(snapTimer);
      window.clearTimeout(refreshTimer);
      for (const s of stops) s();
      screensChannel?.close();
      screensChannel = null;
    };
  }

  return {
    mock: false,
    me: () => me,
    bootstrap,
    connect,

    async messages(q: MessageQuery) {
      const p = new URLSearchParams({ address: q.address, limit: String(q.limit ?? 100) });
      if (q.with) p.set("with", q.with);
      if (q.before) p.set("before", q.before);
      return (await api<{ messages: StoredMessage[] }>(`/api/messages?${p}`).catch(fail)).messages;
    },

    async send(req) {
      // files ride in body.attachments, as on the LAN path (the server rewrites them from its own rows)
      const files = (req.attachments ?? []).map((id) => uploaded.get(id)).filter((u): u is UploadResult => !!u).map(({ path: _p, created_at: _c, ...a }) => a);
      const body = files.length ? { ...(typeof req.body === "string" ? { text: req.body } : req.body), attachments: files } : req.body;
      try {
        const r = await api<{ id: string }>("/api/messages", {
          method: "POST",
          json: { to: req.to, type: req.type, body, reply_to: req.reply_to ?? null, from_agent: req.from_agent ?? "human" },
        });
        return { id: r.id, queued: true };
      } catch (e) {
        if (e instanceof ApiError && e.signedOut) fail(e);
        if (e instanceof ApiError && e.status === 422) throw new Error(sendRefusal(String(e.body.reason ?? e.code)));
        throw e;
      }
    },

    async putContext(key, write): Promise<ContextPutResult> {
      try {
        const entry = await api<ContextEntry>(`/api/context/${encodeURIComponent(key)}`, { method: "PUT", json: write });
        return { ok: true, entry };
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) return { ok: false, conflict: e.body.current as ContextEntry };
        if (e instanceof ApiError && e.signedOut) fail(e);
        return { ok: false, error: e instanceof ApiError ? `Save failed (${e.message})` : "Can't reach agentlink. Your edit is still here; save again in a moment." };
      }
    },

    subscribeScreens(addresses) {
      const next = [...new Set(addresses)].sort();
      if (next.join() === screenSubs.join()) return;
      screenSubs = next;
      screenStore.subscribed(next);
      screenStore.resetGrace();
      screensChannel?.watch(next);
    },

    async paneInput(req): Promise<PaneInputResponse> {
      try {
        const r = await api<{ id: string }>("/api/panes/input", { method: "POST", headers: { "X-Agentlink-Input": "1" }, json: req });
        return { ok: true, id: r.id };
      } catch (e) {
        if (!(e instanceof ApiError)) return { ok: false, kind: "network", message: "Can't reach agentlink. Check your connection." };
        if (e.signedOut) fail(e);
        if (e.code === "no_daemon")
          return { ok: false, kind: "no_bridge", message: "Your laptop isn't connected to agentlink cloud, so nothing can be typed into your panes. Start your daemon and bridge with your access code, then try again." };
        if (e.status === 403) return { ok: false, kind: "forbidden", message: "agentlink refused this input (only your own panes take typing from this page)." };
        return { ok: false, kind: "bad_request", message: e.message };
      }
    },

    async paneInputStatus(id) {
      try {
        return await api<PaneInputStatus>(`/api/panes/input/${encodeURIComponent(id)}`);
      } catch {
        return null;
      }
    },

    async health() {
      return null; // no local daemon on the website
    },
    async upload(file, name, onProgress, signal) {
      // uploads.md "Website": hash here, reserve the file, PUT the bytes straight to Storage, then confirm
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))].map((b) => b.toString(16).padStart(2, "0")).join("");
      if (signal.aborted) throw new DOMException("upload cancelled", "AbortError");
      let made: CloudFileCreated;
      try {
        made = await api<CloudFileCreated>("/api/files", { method: "POST", json: { name, size: file.size, sha256, ...(file.type ? { mime: file.type } : {}) } });
      } catch (e) {
        if (e instanceof ApiError && e.signedOut) fail(e);
        if (e instanceof ApiError && e.code === "config") throw new UploadUnavailable("File uploads through the website need storage set up; see SETUP.md.");
        throw e;
      }
      if (made.upload_url) {
        const url = made.upload_url;
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("PUT", url);
          xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
          xhr.setRequestHeader("x-upsert", "true");
          xhr.upload.onprogress = (e) => onProgress(e.loaded);
          xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`storage answered ${xhr.status}`)));
          xhr.onerror = () => reject(new Error("can't reach file storage"));
          xhr.onabort = () => reject(new DOMException("upload cancelled", "AbortError"));
          signal.addEventListener("abort", () => xhr.abort(), { once: true });
          xhr.send(file);
        });
        await api(`/api/files/${made.id}/complete`, { method: "POST" });
      }
      const result: UploadResult = { id: made.id, name: made.name, size: file.size, sha256, path: "", created_at: new Date().toISOString(), ...(file.type ? { mime: file.type } : {}) };
      uploaded.set(made.id, result);
      return result;
    },
    async deleteUpload(id) {
      uploaded.delete(id); // the row and bytes expire with the rest after 7 days
    },
  };
}

function sendRefusal(reason: string): string {
  switch (reason) {
    case "unknown_target":
      return "Nobody by that name is on agentlink.";
    case "hop_limit":
      return "Refused: this message has been passed on too many times.";
    case "bad_address":
      return "That address isn't valid.";
    default:
      return `agentlink refused the message (${reason}).`;
  }
}
