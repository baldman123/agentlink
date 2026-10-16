import { PROTOCOL_VERSION } from "../../contracts/index.ts";
import type { Address, ClientFrame, ContextEntry, ServerFrame, StoredMessage, UiBootstrap } from "../../contracts/index.ts";
import type { ConnectHandlers, ContextPutResult, MessageQuery, PaneInputResponse, PaneInputStatus, Transport } from "./lib.ts";
import { screenStore } from "./screens.ts";

const PING_MS = 15_000;

export function realTransport(daemonPort: number): Transport {
  const daemon = `http://127.0.0.1:${daemonPort}`;
  let boot: UiBootstrap | null = null;

  async function bootstrap(): Promise<UiBootstrap> {
    const r = await fetch(`${daemon}/v1/ui-bootstrap`);
    if (!r.ok) throw new Error(`daemon answered ${r.status}`);
    boot = (await r.json()) as UiBootstrap;
    return boot;
  }

  async function hubGet<T>(path: string): Promise<T> {
    const b = boot ?? (await bootstrap());
    if (!b.hub_http) throw new Error("hub not found yet");
    const r = await fetch(`${b.hub_http}${path}`, { headers: { Authorization: `Bearer ${b.token}` } });
    if (!r.ok) throw new Error(`hub answered ${r.status}`);
    return (await r.json()) as T;
  }

  // live-screen subscription; replayed on every (re)connect
  let liveSock: WebSocket | null = null;
  let screenSubs: Address[] = [];
  const sendSubs = () => {
    if (liveSock?.readyState !== 1) return;
    const frame: ClientFrame = { op: "screens.subscribe", addresses: screenSubs };
    liveSock.send(JSON.stringify(frame));
    screenStore.resetGrace();
  };

  function connect(h: ConnectHandlers, sinceSeq: () => number | undefined) {
    let ws: WebSocket | null = null;
    let disposed = false;
    let attempt = 0;
    let retryTimer: number | undefined;
    let pingTimer: number | undefined;
    let everConnected = false;

    const schedule = (authFailed = false) => {
      if (disposed) return;
      window.clearInterval(pingTimer);
      // 0.5s → 10s with jitter; auth failures retry slowly.
      const base = authFailed ? 30_000 : Math.min(10_000, 500 * 2 ** attempt);
      const delay = base / 2 + Math.random() * (base / 2);
      attempt++;
      retryTimer = window.setTimeout(open, delay);
    };

    async function open() {
      if (disposed) return;
      h.onState(everConnected ? "reconnecting" : "connecting");
      let b: UiBootstrap;
      try {
        b = await bootstrap();
      } catch {
        h.onState("offline", `can't reach daemon on :${daemonPort}`);
        return schedule();
      }
      if (!b.hub_ws) {
        h.onState("offline", "daemon hasn't found a hub yet");
        return schedule();
      }
      const sock = new WebSocket(b.hub_ws);
      ws = sock;
      let welcomed = false;
      sock.onopen = () => {
        const since = sinceSeq();
        const hello: ClientFrame = {
          op: "hello",
          token: b.token,
          role: "ui",
          user: b.user,
          protocol: PROTOCOL_VERSION,
          ...(since != null ? { since_seq: since } : {}),
        };
        sock.send(JSON.stringify(hello));
      };
      sock.onmessage = (ev) => {
        let f: ServerFrame;
        try {
          f = JSON.parse(String(ev.data)) as ServerFrame;
        } catch {
          return;
        }
        if (f.op === "welcome") {
          welcomed = true;
          everConnected = true;
          attempt = 0;
          h.onState("connected");
          pingTimer = window.setInterval(() => sock.readyState === 1 && sock.send(JSON.stringify({ op: "ping" })), PING_MS);
          liveSock = sock;
          if (screenSubs.length) sendSubs();
        }
        h.onFrame(f);
      };
      sock.onclose = (ev) => {
        if (liveSock === sock) liveSock = null;
        if (ws !== sock) return;
        ws = null;
        if (disposed) return;
        if (ev.code === 4001) {
          h.onState("offline", "hub rejected the token");
          return schedule(true);
        }
        if (ev.code === 4002) h.onState("offline", "protocol mismatch with hub");
        else h.onState(welcomed || everConnected ? "reconnecting" : "offline", "hub connection lost");
        schedule();
      };
    }

    open();
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      window.clearInterval(pingTimer);
      ws?.close();
    };
  }

  return {
    mock: false,
    bootstrap,
    connect,
    async messages(q: MessageQuery) {
      const p = new URLSearchParams({ address: q.address, limit: String(q.limit ?? 100) });
      if (q.with) p.set("with", q.with);
      if (q.before) p.set("before", q.before);
      const r = await hubGet<{ messages: StoredMessage[] }>(`/api/messages?${p}`);
      return r.messages;
    },
    async send(req) {
      const r = await fetch(`${daemon}/v1/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail || j.error || `daemon answered ${r.status}`);
      return j;
    },
    async putContext(key, write): Promise<ContextPutResult> {
      const r = await fetch(`${daemon}/v1/context/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(write),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409) return { ok: false, conflict: (j as { current: ContextEntry }).current };
      if (r.status === 503) return { ok: false, error: "Hub is offline. Your edit is still here; save again once it reconnects." };
      if (!r.ok) return { ok: false, error: j.detail || j.error || `Save failed (${r.status})` };
      return { ok: true, entry: j as ContextEntry };
    },
    async paneInput(req): Promise<PaneInputResponse> {
      let r: Response;
      try {
        r = await fetch(`${daemon}/v1/panes/input`, {
          method: "POST",
          // the custom header forces a CORS preflight; the daemon also checks Origin (input.md)
          headers: { "Content-Type": "application/json", "X-Agentlink-Input": "1" },
          body: JSON.stringify(req),
        });
      } catch {
        return { ok: false, kind: "network", message: `Can't reach the daemon on :${daemonPort}.` };
      }
      const j = await r.json().catch(() => ({}));
      if (r.status === 202 && j.id) return { ok: true, id: j.id };
      if (r.status === 503)
        return { ok: false, kind: "no_bridge", message: "No bridge is connected on this laptop, so nothing can be typed into the panes. Start it with scripts/team-up.sh, then try again." };
      if (r.status === 403)
        return { ok: false, kind: "forbidden", message: `The daemon refused input from this page (it only accepts the agentlink UI origin, and this page is ${location.origin}).` };
      return { ok: false, kind: "bad_request", message: j.detail || j.error || `The daemon answered ${r.status}.` };
    },
    async paneInputStatus(id) {
      try {
        const r = await fetch(`${daemon}/v1/panes/input/${encodeURIComponent(id)}`);
        if (!r.ok) return null;
        return (await r.json()) as PaneInputStatus;
      } catch {
        return null;
      }
    },
    subscribeScreens(addresses) {
      const next = [...new Set(addresses)].sort();
      if (next.join() === screenSubs.join()) return;
      screenSubs = next;
      screenStore.subscribed(next);
      sendSubs();
    },
  };
}
