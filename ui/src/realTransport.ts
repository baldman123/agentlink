import { PROTOCOL_VERSION } from "../../contracts/index.ts";
import type { Address, ClientFrame, ContextEntry, DaemonHealth, ServerFrame, StoredMessage, UiBootstrap } from "../../contracts/index.ts";
import type { ConnectHandlers, ContextPutResult, MessageQuery, PaneInputResponse, PaneInputStatus, Transport } from "./lib.ts";
import { screenStore } from "./screens.ts";
import { clientProof, IMPOSTOR_MSG, randomHex, sameHex, serverProof } from "./auth.ts";

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

  // v2: REST uses the per-socket session from welcome, never the shared token
  let session: { bearer: string; http: string } | null = null;
  const sessionWaiters = new Set<() => void>();
  const setSession = (s: typeof session) => {
    session = s;
    if (s) for (const w of [...sessionWaiters]) w();
  };
  const waitForSession = (ms: number) =>
    new Promise<boolean>((res) => {
      if (session) return res(true);
      const done = () => { sessionWaiters.delete(done); clearTimeout(t); res(!!session); };
      const t = setTimeout(done, ms);
      sessionWaiters.add(done);
    });
  let forceReconnect: (() => void) | null = null;

  async function hubGet<T>(path: string, retried = false): Promise<T> {
    if (!session && !(await waitForSession(5000))) throw new Error("not connected to the hub");
    const s = session!;
    const r = await fetch(`${s.http}${path}`, { headers: { Authorization: `Bearer ${s.bearer}` } });
    if (r.status === 401) {
      // the session expired (socket gone, or the hub restarted): reconnect for a fresh one, retry once
      if (session === s) setSession(null);
      forceReconnect?.();
      if (!retried && (await waitForSession(8000))) return hubGet<T>(path, true);
      throw new Error("hub session expired; reconnecting");
    }
    if (!r.ok) throw new Error(`hub answered ${r.status}`);
    return (await r.json()) as T;
  }

  async function daemonPin(): Promise<string | null> {
    try {
      const r = await fetch(`${daemon}/v1/health`);
      return r.ok ? ((await r.json()) as DaemonHealth).hub.hub_id : null;
    } catch {
      return null;
    }
  }

  // hubs that failed the identity check this run: never connect to that URL again
  const impostors = new Set<string>();
  let runPin: string | null = null; // first verified hub_id, used when the daemon has no pin yet

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
      if (!b.hub_ws || !b.hub_http) {
        h.onState("offline", "daemon hasn't found a hub yet");
        return schedule();
      }
      if (impostors.has(b.hub_ws)) {
        // never retry an address that failed the identity check; wait for the daemon to find the real hub
        h.onState("offline", `${IMPOSTOR_MSG} at ${b.hub_http}; not reconnecting there`);
        return schedule();
      }
      const pin = (await daemonPin()) ?? runPin;
      const hubWs = b.hub_ws;
      const hubHttp = b.hub_http;
      const sock = new WebSocket(hubWs);
      ws = sock;
      let phase: "challenge" | "welcome" | "ready" | "dead" = "challenge";
      let nonce = "";
      let hubId = "";
      let cnonce = "";
      const bail = (detail: string, impostor: boolean) => {
        phase = "dead";
        if (impostor) impostors.add(hubWs);
        h.onState("offline", detail);
        sock.close(); // onclose schedules the next attempt (which skips impostor addresses)
      };

      // frames are handled strictly in order; the handshake steps are async (WebCrypto)
      let chain = Promise.resolve();
      sock.onmessage = (ev) => {
        chain = chain.then(() => handle(String(ev.data))).catch(() => bail("hub handshake failed", false));
      };
      async function handle(data: string) {
        if (phase === "dead") return;
        let f: ServerFrame;
        try {
          f = JSON.parse(data) as ServerFrame;
        } catch {
          return;
        }
        if (phase === "challenge") {
          if (f.op !== "challenge") return bail("hub didn't send a challenge (protocol v1 hub?)", false);
          if (f.protocol !== PROTOCOL_VERSION) return bail(`hub speaks protocol ${f.protocol}, this UI needs ${PROTOCOL_VERSION}`, false);
          // check the hub's identity against the pin BEFORE sending anything
          if (pin && f.hub_id !== pin) return bail(`${IMPOSTOR_MSG}: hub id ${f.hub_id.slice(0, 8)} is not the pinned ${pin.slice(0, 8)}`, true);
          nonce = f.nonce;
          hubId = f.hub_id;
          cnonce = randomHex(32);
          const since = sinceSeq();
          const hello: ClientFrame = {
            op: "hello",
            role: "ui",
            user: b.user,
            protocol: PROTOCOL_VERSION,
            ...(since != null ? { since_seq: since } : {}),
            cnonce,
            proof: await clientProof(b.token, nonce, hubId, b.user, "ui", cnonce),
          };
          phase = "welcome";
          sock.send(JSON.stringify(hello));
          return;
        }
        if (phase === "welcome") {
          if (f.op === "error") return; // the close code that follows says why
          if (f.op !== "welcome") return bail("unexpected frame before welcome", false);
          // verify the hub knows the token too, before trusting or sending anything else
          const expect = await serverProof(b.token, cnonce, nonce, hubId);
          if (!sameHex(f.server_proof, expect) || f.hub_id !== hubId) return bail(IMPOSTOR_MSG, true);
          phase = "ready";
          runPin ??= hubId;
          setSession({ bearer: f.session, http: hubHttp });
          everConnected = true;
          attempt = 0;
          h.onState("connected");
          pingTimer = window.setInterval(() => sock.readyState === 1 && sock.send(JSON.stringify({ op: "ping" })), PING_MS);
          liveSock = sock;
          h.onFrame(f);
          if (screenSubs.length) sendSubs();
          return;
        }
        h.onFrame(f);
      }

      sock.onclose = (ev) => {
        if (liveSock === sock) liveSock = null;
        if (ws !== sock) return;
        ws = null;
        if (session?.http === hubHttp) setSession(null);
        if (disposed) return;
        if (phase === "dead") return schedule(); // state already set by bail()
        if (ev.code === 4001) {
          h.onState("offline", "hub refused our proof (is this laptop's token right?)");
          return schedule(true);
        }
        if (ev.code === 4002) h.onState("offline", "protocol mismatch with hub");
        else h.onState(phase === "ready" || everConnected ? "reconnecting" : "offline", "hub connection lost");
        schedule();
      };
    }

    forceReconnect = () => {
      if (ws && ws.readyState <= 1) ws.close();
    };
    open();
    return () => {
      disposed = true;
      forceReconnect = null;
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
    async health() {
      try {
        const r = await fetch(`${daemon}/v1/health`);
        return r.ok ? ((await r.json()) as DaemonHealth) : null;
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
