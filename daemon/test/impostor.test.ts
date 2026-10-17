// Adversarial test of the discovery guarantee in contracts/daemon-api.md: "the hub's identity is its hub_id, never its IP;
// the token is sent only after GET /api/health at that address returns the pinned hub_id (and again at welcome)".
//
// A real hub (hub/src/hub.ts, in-process) plus impostor hubs that are plain http+ws servers this test controls. Each records
// every request and every hello it receives, so the test can see whether the daemon's token ever reached it.
//   wrong_id   copies the real hub's mDNS name and TXT (even its hub_id) but /api/health and welcome give another id
//   liar       copies the REAL hub_id on /api/health and in its v2 challenge, but can't compute server_proof
//   (plus, inline: a challenge whose hub_id differs from /api/health, and a relay to the real hub)
// Protocol v2: every impostor sends a challenge first; none of them knows the token, so the daemon's hello must
// carry only an HMAC proof and a forged server_proof must end the connection.
//   slow       /api/health answers (with another id) only after 1.5s
//   tarpit     accepts the connection and never answers
//   garbage    /api/health returns 200 with a body that isn't JSON
// Ports 7760-7769 range only for the daemon; hubs use OS-assigned ports on 127.0.0.1. Never touches 7700/7701.
//
// Run: npx tsx test/impostor.test.ts   (from daemon/)
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Bonjour } from "bonjour-service";
import { WebSocketServer } from "ws";
import { MDNS_SERVICE_TYPE, PROTOCOL_VERSION, type DaemonHealth } from "../../contracts/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON_DIR = join(HERE, "..");
const ROOT = join(DAEMON_DIR, "..");
const TSX_LOADER = `file://${join(ROOT, "node_modules/tsx/dist/loader.mjs")}`;
const TOKEN = `impostor-test-${randomBytes(12).toString("hex")}`;
const tmp = mkdtempSync(join(tmpdir(), "agentlink-impostor-"));
process.env.AGENTLINK_HUB_LOG = join(tmp, "hub.log");
const { Hub } = await import("../../hub/src/hub.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passes = 0;
let failures = 0;
const known: string[] = [];
function check(cond: unknown, name: string, detail?: unknown) {
  if (cond) {
    passes++;
    console.error(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail !== undefined ? `\n       ${JSON.stringify(detail).slice(0, 700)}` : ""}`);
  }
}
/** A protocol limitation the contract can't prevent: printed and reported, not counted as a failure. */
function knownLimitation(cond: unknown, name: string) {
  if (cond) return check(true, name);
  known.push(name);
  console.error(`  KNOWN ${name}`);
}
async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(250);
    v = await fn();
  }
  return v;
}

// ---------------------------------------------------------------------------------------------- subnet unit test
async function subnetUnitTest() {
  console.error("scan subnet calculation (fake interfaces)");
  const mod = (await import("../src/discovery.ts")) as Record<string, unknown>;
  const name = ["scanHosts", "subnetHosts", "scanTargets", "hostsToScan", "scanCandidates"].find((n) => typeof mod[n] === "function");
  if (!name) {
    check(false, "discovery.ts exports a pure subnet function (scanHosts or similar) to unit-test", Object.keys(mod));
    return;
  }
  const fn = mod[name] as (ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>) => unknown;
  const v4 = (address: string, netmask: string, internal = false): NetworkInterfaceInfo =>
    ({ address, netmask, family: "IPv4", internal, mac: "00:00:00:00:00:00", cidr: null }) as unknown as NetworkInterfaceInfo;
  const v6 = (address: string): NetworkInterfaceInfo =>
    ({ address, netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false, mac: "00:00:00:00:00:00", scopeid: 0, cidr: null }) as unknown as NetworkInterfaceInfo;
  const ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
    lo0: [v4("127.0.0.1", "255.0.0.0", true)],
    en0: [v4("192.168.1.50", "255.255.255.0")], // 192.168/16, a /24
    en1: [v4("10.4.5.6", "255.0.0.0")], // 10/8 with a /8 mask: capped to 10.4.5.0/24
    en2: [v4("172.20.7.9", "255.240.0.0")], // 172.16/12: capped to 172.20.7.0/24
    en3: [v4("172.32.1.1", "255.255.0.0")], // 172.32 is NOT in 172.16/12: public
    en4: [v4("34.120.5.6", "255.255.255.0")], // public
    en5: [v6("fe80::1"), v6("2001:db8::5")], // IPv6 only
    en6: [v4("192.168.77.10", "255.255.0.0")], // a /16 mask: capped to 192.168.77.0/24
    utun3: [v4("100.64.1.2", "255.255.255.0")], // CGNAT/Tailscale, not in the contract's private list
    en7: [v4("169.254.3.4", "255.255.0.0")], // link-local, not in the list
  };
  let raw: unknown;
  try {
    raw = await fn(ifaces);
  } catch (err) {
    check(false, `${name}(fakeInterfaces) runs`, String(err));
    return;
  }
  const hosts = (Array.isArray(raw) ? raw : []).map((h: any) =>
    String(typeof h === "string" ? h : (h?.host ?? h?.address ?? h?.url ?? "")).replace(/^https?:\/\//, "").replace(/[:/].*$/, ""),
  );
  const prefixes = new Map<string, number>();
  for (const h of hosts) {
    const p = h.split(".").slice(0, 3).join(".");
    prefixes.set(p, (prefixes.get(p) ?? 0) + 1);
  }
  const allowed = ["192.168.1", "10.4.5", "172.20.7", "192.168.77"];
  check(hosts.length > 0 && hosts.every((h) => /^\d+\.\d+\.\d+\.\d+$/.test(h)), `${name} returns IPv4 hosts`, hosts.slice(0, 5));
  check([...prefixes.keys()].every((p) => allowed.includes(p)), "only the /24s around this laptop's private addresses", [...prefixes.keys()]);
  for (const p of allowed) check((prefixes.get(p) ?? 0) >= 253 && (prefixes.get(p) ?? 0) <= 254, `${p}.0/24 is scanned (1-254)`, prefixes.get(p));
  check(!hosts.some((h) => h.startsWith("10.") && !h.startsWith("10.4.5.")), "a /8 mask is capped to the /24 (no 10.x.y outside 10.4.5)");
  check(!hosts.some((h) => h.startsWith("192.168.") && !/^192\.168\.(1|77)\./.test(h)), "a /16 mask is capped to the /24");
  check(!hosts.some((h) => /^(172\.32|34\.|100\.64|169\.254|127\.)/.test(h)), "no public, CGNAT, link-local or loopback hosts");
  check(!hosts.some((h) => /\.(0|255)$/.test(h)), "no network or broadcast addresses");
  check(new Set(hosts).size === hosts.length, "no duplicates");
  const none = (await fn({ en0: [v4("8.8.8.8", "255.255.255.0")], en1: [v6("2001:db8::1")] })) as unknown[];
  check(Array.isArray(none) && none.length === 0, "public + IPv6-only interfaces -> nothing to scan", none);
}

// ---------------------------------------------------------------------------------------------- hubs
interface Recorder {
  kind: string;
  port: number;
  url: string;
  requests: { method: string; path: string; auth: string | null }[];
  hellos: any[];
  frames: any[];
  close: () => Promise<void>;
}

/** True if the token reached this server in any form: a hello frame, an Authorization header, or any frame at all. */
function gotToken(r: Recorder): boolean {
  return r.hellos.some((h) => h?.token === TOKEN) || r.requests.some((q) => q.auth?.includes(TOKEN)) || r.frames.some((f) => JSON.stringify(f).includes(TOKEN));
}

const REAL_NAME = `agentlink-impostor-test-${process.pid}`;
const FAKE_ID = randomUUID();

async function impostor(kind: "wrong_id" | "liar" | "slow" | "tarpit" | "garbage", realId: string, port = 0): Promise<Recorder> {
  const rec: Recorder = { kind, port: 0, url: "", requests: [], hellos: [], frames: [], close: async () => {} };
  const sockets = new Set<Socket>();
  const healthFor = (id: string) => JSON.stringify({ ok: true, hub_id: id, hub_name: REAL_NAME, protocol: PROTOCOL_VERSION });
  const server: Server = createServer((req, res) => {
    rec.requests.push({ method: req.method ?? "", path: req.url ?? "", auth: (req.headers.authorization as string) ?? null });
    if (kind === "tarpit") return; // never answer
    if (!req.url?.startsWith("/api/health")) return void res.writeHead(404).end("{}");
    if (kind === "garbage") return void res.writeHead(200, { "content-type": "application/json" }).end("<html>{{ not json");
    if (kind === "slow") return void setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(healthFor(FAKE_ID)), 1_500);
    res.writeHead(200, { "content-type": "application/json" }).end(healthFor(kind === "liar" ? realId : FAKE_ID));
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    rec.requests.push({ method: "UPGRADE", path: req.url ?? "", auth: (req.headers.authorization as string) ?? null });
    if (kind === "tarpit") return; // hold the socket open, never complete the upgrade
    wss.handleUpgrade(req, socket, head, (ws) => {
      // v2: challenge first. The liar claims the REAL hub_id; the rest claim their own.
      const claimedId = kind === "liar" ? realId : FAKE_ID;
      ws.send(JSON.stringify({ op: "challenge", nonce: randomBytes(32).toString("hex"), hub_id: claimedId, hub_name: REAL_NAME, protocol: PROTOCOL_VERSION }));
      ws.on("message", (data) => {
        let f: any = null;
        try {
          f = JSON.parse(data.toString());
        } catch {
          f = { raw: data.toString() };
        }
        rec.frames.push(f);
        if (f?.op !== "hello") return;
        rec.hellos.push(f);
        // It doesn't know the token, so it can't compute server_proof: it forges one and hopes.
        ws.send(
          JSON.stringify({
            op: "welcome",
            hub_id: claimedId,
            hub_name: REAL_NAME,
            server_time: new Date().toISOString(),
            protocol: PROTOCOL_VERSION,
            server_proof: randomBytes(32).toString("hex"),
            session: randomBytes(32).toString("hex"),
          }),
        );
        ws.send(JSON.stringify({ op: "snapshot", users: [], context: [], last_seq: 0 }));
      });
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  rec.port = (server.address() as AddressInfo).port;
  rec.url = `http://127.0.0.1:${rec.port}`;
  rec.close = () =>
    new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      wss.close();
      server.close(() => r());
    });
  return rec;
}

/** Reserve a free port number (for a hub that starts later, or one an impostor takes over). */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

const realDb = join(tmp, "real-hub.sqlite");
async function startRealHub(port: number) {
  const hub = new Hub({ port, host: "127.0.0.1", token: TOKEN, owner: "alex", dbPath: realDb, hubName: REAL_NAME });
  await hub.listen();
  return hub;
}

// ---------------------------------------------------------------------------------------------- daemon
let daemonPort = 7760;
interface Daemon {
  proc: ChildProcess;
  port: number;
  dir: string;
  out: () => string;
  health: () => Promise<DaemonHealth | null>;
  stop: () => Promise<void>;
}

function startDaemon(env: Record<string, string>, dir = join(tmp, `daemon-${daemonPort}`)): Daemon {
  const port = daemonPort++;
  mkdirSync(dir, { recursive: true });
  let out = "";
  const { AGENTLINK_HUB_URL: _a, AGENTLINK_DISCOVERY: _b, AGENTLINK_HUB_REPIN: _c, AGENTLINK_SCAN_HOSTS: _d, ...base } = process.env;
  const proc = spawn(process.execPath, ["--import", TSX_LOADER, join(DAEMON_DIR, "src/index.ts")], {
    cwd: dir,
    env: {
      ...base,
      AGENTLINK_USER: "alex",
      AGENTLINK_TOKEN: TOKEN,
      AGENTLINK_DAEMON_PORT: String(port),
      AGENTLINK_DAEMON_DB: join(dir, "daemon.sqlite"),
      AGENTLINK_HUB_NAME: REAL_NAME, // ignore every other agentlink hub on this network (e.g. the live team's)
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (out += d));
  return {
    proc,
    port,
    dir,
    out: () => out,
    health: () =>
      fetch(`http://127.0.0.1:${port}/v1/health`)
        .then((r) => r.json() as Promise<DaemonHealth>)
        .catch(() => null),
    stop: async () => {
      if (proc.exitCode !== null) return;
      proc.kill("SIGTERM");
      await until(() => proc.exitCode, (c) => c !== null, 5_000);
      if (proc.exitCode === null) proc.kill("SIGKILL");
    },
  };
}

/** Log lines (JSON) from the daemon's stdout. */
function events(d: Daemon): any[] {
  return d
    .out()
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
/** A log line that says this url's hub_id didn't match (any event name, as long as it names the url or port and a mismatch). */
function loggedMismatch(d: Daemon, r: Recorder): boolean {
  return events(d).some((e) => {
    const s = JSON.stringify(e);
    return s.includes(`:${r.port}`) && /mismatch|id_changed|wrong|not the pinned|expected_hub_id|got_hub_id/i.test(s);
  });
}
const connectedTo = (h: DaemonHealth | null, id: string) => h?.hub.state === "connected" && h.hub.hub_id === id;

// ---------------------------------------------------------------------------------------------- scenarios
const cleanup: (() => Promise<void> | void)[] = [];

try {
  await subnetUnitTest();
  if (process.env.IMPOSTOR_SUBNET_ONLY === "1") throw "subnet-only";

  // The real hub, once, to learn its permanent hub_id.
  const realPort = await freePort();
  let real = await startRealHub(realPort);
  const REAL_ID = real.hubId;
  cleanup.push(() => real.close().catch(() => {}));

  // ---- 1. mDNS impostor copying the real hub's name and TXT (hub_id included); real hub only reachable by scan
  console.error("1. mDNS impostor with the real name + copied TXT, real hub on the scan list");
  {
    const imp = await impostor("wrong_id", REAL_ID);
    const bonjour = new Bonjour();
    bonjour.publish({ name: REAL_NAME, type: MDNS_SERVICE_TYPE, port: imp.port, txt: { v: "1", hub_id: REAL_ID, name: REAL_NAME } });
    await sleep(1_500); // let the advertisement settle
    const d = startDaemon({ AGENTLINK_HUB_ID: REAL_ID, AGENTLINK_SCAN: "1", AGENTLINK_SCAN_HOSTS: `127.0.0.1:${imp.port},127.0.0.1:${realPort}` });
    const h = await until(d.health, (x) => connectedTo(x, REAL_ID), 25_000);
    check(connectedTo(h, REAL_ID), "daemon ends up connected to the REAL hub (by hub_id)", h?.hub);
    check(!gotToken(imp), "the impostor never received the token", { hellos: imp.hellos.length, requests: imp.requests });
    check(imp.hellos.length === 0, "the impostor never received a hello at all");
    check(loggedMismatch(d, imp), "the hub_id mismatch at the impostor's address is logged", events(d).filter((e) => JSON.stringify(e).includes(`:${imp.port}`)));
    await d.stop();
    await new Promise<void>((r) => bonjour.unpublishAll(() => r()));
    bonjour.destroy();
    await imp.close();
  }

  // ---- 2. tarpit, slow and garbage impostors listed before the real hub
  console.error("2. tarpit, slow and garbage impostors ahead of the real hub");
  {
    const tar = await impostor("tarpit", REAL_ID);
    const slow = await impostor("slow", REAL_ID);
    const garb = await impostor("garbage", REAL_ID);
    const t0 = Date.now();
    const d = startDaemon({ AGENTLINK_HUB_ID: REAL_ID, AGENTLINK_SCAN: "1", AGENTLINK_SCAN_HOSTS: [tar, slow, garb].map((r) => `127.0.0.1:${r.port}`).concat(`127.0.0.1:${realPort}`).join(",") });
    const h = await until(d.health, (x) => connectedTo(x, REAL_ID), 25_000);
    check(connectedTo(h, REAL_ID), `connected to the real hub despite them (${Date.now() - t0}ms)`, h?.hub);
    for (const r of [tar, slow, garb]) check(!gotToken(r) && r.hellos.length === 0, `${r.kind}: no token, no hello`, { hellos: r.hellos.length, requests: r.requests });
    await d.stop();
    for (const r of [tar, slow, garb]) await r.close();
  }

  // ---- 3. only impostors around: keep searching, never connect; then the real hub appears
  console.error("3. only impostors: keep searching, then find the real hub when it appears");
  {
    await real.close();
    const imp = await impostor("wrong_id", REAL_ID);
    const garb = await impostor("garbage", REAL_ID);
    const tar = await impostor("tarpit", REAL_ID);
    const manual = await impostor("wrong_id", REAL_ID);
    const d = startDaemon({
      AGENTLINK_HUB_ID: REAL_ID,
      AGENTLINK_SCAN: "1",
      AGENTLINK_SCAN_HOSTS: [imp, garb, tar].map((r) => `127.0.0.1:${r.port}`).concat(`127.0.0.1:${realPort}`).join(","),
      AGENTLINK_HUB_URL: manual.url, // stage 4, also an impostor
    });
    await sleep(8_000);
    const h = await d.health();
    check(h && h.hub.state !== "connected", "not connected to anything while only impostors answer", h?.hub);
    check(h?.hub.searching === true, "health reports searching: true", h?.hub);
    for (const r of [imp, garb, tar, manual]) check(!gotToken(r) && r.hellos.length === 0, `${r.kind} (${r === manual ? "AGENTLINK_HUB_URL" : "scan"}): no token, no hello`, { hellos: r.hellos.length });
    check(loggedMismatch(d, imp), "scan impostor mismatch logged");
    check(loggedMismatch(d, manual), "manual-URL impostor mismatch logged");
    check(events(d).some((e) => e.event === "hub.search"), "hub.search {stage} is logged");
    real = await startRealHub(realPort);
    const h2 = await until(d.health, (x) => connectedTo(x, REAL_ID), 45_000); // the scan repeats every 30s
    check(connectedTo(h2, REAL_ID), "the real hub is found once it appears", h2?.hub);
    check(h2?.hub.searching === false, "searching: false once connected", h2?.hub);
    for (const r of [imp, garb, tar, manual]) check(!gotToken(r), `${r.kind}: still no token after the real hub appeared`);
    await d.stop();
    for (const r of [imp, garb, tar, manual]) await r.close();
  }

  // ---- 4. the host's IP changed and ANOTHER computer now answers at the last known address
  console.error("4. last known address taken over by an impostor; the real hub moved");
  {
    const dir = join(tmp, "daemon-moving");
    const movedPort = await freePort();
    let d = startDaemon({ AGENTLINK_HUB_ID: REAL_ID, AGENTLINK_SCAN: "1", AGENTLINK_SCAN_HOSTS: `127.0.0.1:${realPort}` }, dir);
    let h = await until(d.health, (x) => connectedTo(x, REAL_ID), 25_000);
    check(connectedTo(h, REAL_ID), "first connect stores the real hub as last known", h?.hub);
    await d.stop();
    await real.close();
    const squatter = await impostor("wrong_id", REAL_ID, realPort); // same address:port, different computer
    real = await startRealHub(movedPort);
    d = startDaemon({ AGENTLINK_HUB_ID: REAL_ID, AGENTLINK_SCAN: "1", AGENTLINK_SCAN_HOSTS: `127.0.0.1:${movedPort}` }, dir);
    h = await until(d.health, (x) => connectedTo(x, REAL_ID), 25_000);
    check(connectedTo(h, REAL_ID) && h?.hub.url?.endsWith(`:${movedPort}`), "connects to the real hub at its new address", h?.hub);
    check(!gotToken(squatter) && squatter.hellos.length === 0, "the computer now at the old address never got the token", { hellos: squatter.hellos.length, requests: squatter.requests });
    check(squatter.requests.some((q) => q.path.startsWith("/api/health")), "the old address was checked with /api/health first (last_known stage)");
    check(loggedMismatch(d, squatter), "the mismatch at the old address is logged");
    await d.stop();
    await squatter.close();
    await real.close();
    real = await startRealHub(realPort);
  }

  // ---- 5. a liar: copies the real hub_id on /api/health AND in its challenge, but can't produce server_proof
  console.error("5. liar: the real hub_id on /api/health and in the challenge, forged server_proof (v2)");
  {
    const liar = await impostor("liar", REAL_ID);
    const d = startDaemon({ AGENTLINK_HUB_ID: REAL_ID, AGENTLINK_SCAN: "1", AGENTLINK_SCAN_HOSTS: `127.0.0.1:${liar.port},127.0.0.1:${realPort}` });
    const h = await until(d.health, (x) => connectedTo(x, REAL_ID), 40_000);
    check(!gotToken(liar), "v2: the liar never receives the token (hello carries only an HMAC proof)", liar.hellos);
    check(liar.hellos.every((x) => !("token" in x) && /^[0-9a-f]{64}$/.test(x.proof ?? "")), "every hello the liar got is a v2 hello with no token field", liar.hellos);
    check(
      events(d).some((e) => /impostor|server_proof|bad_proof/i.test(JSON.stringify(e)) && JSON.stringify(e).includes(`:${liar.port}`)),
      "the forged server_proof is logged (hub.impostor) for the liar's address",
      events(d).filter((e) => JSON.stringify(e).includes(`:${liar.port}`)),
    );
    check(connectedTo(h, REAL_ID), "after the liar, the daemon keeps searching and connects to the real hub", h?.hub);
    check(liar.hellos.length <= 1, `the liar is never retried this run (${liar.hellos.length} hello)`);
    check(!liar.frames.some((f) => f?.op && f.op !== "hello"), "nothing but the hello reaches the liar (no sessions, no outbox, no ping)", liar.frames.map((f) => f?.op));
    check(!liar.requests.some((q) => q.auth), "no REST call with any bearer reaches the liar (its forged session is never used)", liar.requests);
    await d.stop();
    await liar.close();
  }

  // ---- 6. a challenge whose hub_id isn't the pin: close without sending anything
  console.error("6. right hub_id on /api/health, another hub_id in the challenge");
  {
    // /api/health says REAL_ID (copied), the challenge says FAKE_ID: the challenge check must catch it.
    const health = createServer((req, res) => {
      if (req.url?.startsWith("/api/health")) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, hub_id: REAL_ID, hub_name: REAL_NAME, protocol: PROTOCOL_VERSION }));
      res.writeHead(404).end();
    });
    const hellos: any[] = [];
    const wss = new WebSocketServer({ noServer: true });
    health.on("upgrade", (req, socket, head) =>
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify({ op: "challenge", nonce: randomBytes(32).toString("hex"), hub_id: FAKE_ID, hub_name: REAL_NAME, protocol: PROTOCOL_VERSION }));
        ws.on("message", (m) => hellos.push(m.toString()));
      }),
    );
    await new Promise<void>((r) => health.listen(0, "127.0.0.1", () => r()));
    const hp = (health.address() as AddressInfo).port;
    const d = startDaemon({ AGENTLINK_HUB_ID: REAL_ID, AGENTLINK_SCAN: "1", AGENTLINK_SCAN_HOSTS: `127.0.0.1:${hp},127.0.0.1:${realPort}` });
    const h = await until(d.health, (x) => connectedTo(x, REAL_ID), 30_000);
    check(hellos.length === 0, "the daemon sends nothing at all after a challenge with the wrong hub_id", hellos);
    check(connectedTo(h, REAL_ID), "and goes on to the real hub", h?.hub);
    await d.stop();
    wss.close();
    await new Promise<void>((r) => health.close(() => r()));
  }

  // ---- 7. a relay: forwards challenge/hello/welcome between the daemon and the REAL hub
  console.error("7. relay (man in the middle) between the daemon and the real hub");
  {
    const relayFrames: string[] = [];
    const relay = createServer((req, res) => {
      fetch(`http://127.0.0.1:${realPort}${req.url}`)
        .then(async (r) => res.writeHead(r.status, { "content-type": "application/json" }).end(await r.text()))
        .catch(() => res.writeHead(502).end());
    });
    const wss = new WebSocketServer({ noServer: true });
    relay.on("upgrade", (req, socket, head) =>
      wss.handleUpgrade(req, socket, head, async (client) => {
        const { WebSocket } = await import("ws");
        const upstream = new WebSocket(`ws://127.0.0.1:${realPort}/ws`);
        upstream.on("message", (m) => client.readyState === 1 && client.send(m.toString()));
        client.on("message", (m) => {
          relayFrames.push(m.toString());
          const send = () => upstream.send(m.toString());
          upstream.readyState === 1 ? send() : upstream.once("open", send);
        });
        client.on("close", () => upstream.close());
        upstream.on("close", () => client.close());
      }),
    );
    await new Promise<void>((r) => relay.listen(0, "127.0.0.1", () => r()));
    const rp = (relay.address() as AddressInfo).port;
    const d = startDaemon({ AGENTLINK_HUB_ID: REAL_ID, AGENTLINK_SCAN: "1", AGENTLINK_SCAN_HOSTS: `127.0.0.1:${rp}` });
    const h = await until(d.health, (x) => x?.hub.state === "connected", 20_000);
    check(!relayFrames.some((f) => f.includes(TOKEN)), "a relay never sees the token either (only the HMAC proof)");
    // Without TLS/channel binding a relay can sit in the middle of a valid handshake and read the traffic.
    knownLimitation(!(h?.hub.state === "connected" && h.hub.url?.endsWith(`:${rp}`)), "a relay to the real hub can't carry the connection (needs TLS or channel binding)");
    await d.stop();
    wss.close();
    await new Promise<void>((r) => relay.close(() => r()));
  }
} catch (err) {
  if (err !== "subnet-only") {
    failures++;
    console.error("impostor test crashed:", err);
  }
} finally {
  for (const c of cleanup.reverse()) await c();
  rmSync(tmp, { recursive: true, force: true });
}

console.error(`\n${passes} passed, ${failures} failed${known.length ? `, ${known.length} known limitation(s): ${known.join("; ")}` : ""}`);
process.exit(failures ? 1 : 0);
