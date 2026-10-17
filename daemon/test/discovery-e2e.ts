// Discovery by hub_id (contracts/daemon-api.md, "Discovery"): a daemon given only AGENTLINK_HUB_ID,
// no URL and no mDNS, finds the right hub by scanning AGENTLINK_SCAN_HOSTS, which also lists a decoy
// hub with another id. The decoy must never get a hello (each fake hub logs every hello to stdout).
//   npx tsx daemon/test/discovery-e2e.ts      (E2E_BASE, default 7790)
// Ports: decoy BASE+1, hub BASE+2 then BASE+3 (it "moves"), alex daemon BASE+5, bob daemon BASE+6.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BASE = Number(process.env.E2E_BASE ?? 7790);
const TOKEN = "discovery-e2e-token";
const HUB_ID = "real-hub-0001";
const DECOY_ID = "decoy-hub-9999";
const DECOY = BASE + 1;
const HUB_A = BASE + 2;
const HUB_B = BASE + 3;
const ALEX = BASE + 5;
const BOB = BASE + 6;
const SCAN_HOSTS = [DECOY, HUB_A, HUB_B].map((p) => `127.0.0.1:${p}`).join(",");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-discovery-e2e-"));
const daemonDir = path.resolve(import.meta.dirname, "..");
const TSX_LOADER = pathToFileURL(path.resolve(daemonDir, "../node_modules/tsx/dist/loader.mjs")).href;
const procs: ChildProcess[] = [];
let failures = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // retry
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function run(name: string, args: string[], cwd: string, env: Record<string, string>) {
  const p = spawn(process.execPath, ["--import", TSX_LOADER, ...args], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const out = fs.createWriteStream(path.join(tmp, `${name}.out`), { flags: "a" });
  p.stdout!.pipe(out);
  p.stderr!.pipe(out);
  procs.push(p);
  return p;
}
async function stop(p: ChildProcess) {
  if (p.exitCode !== null || p.signalCode !== null) return;
  const done = new Promise((r) => p.once("exit", r));
  p.kill("SIGTERM");
  await done;
}
const fakeHub = (name: string, port: number, id: string) =>
  run(name, ["test/fake-hub.ts"], daemonDir, { AGENTLINK_TOKEN: TOKEN, FAKE_HUB_PORT: String(port), FAKE_HUB_ID: id });

function daemon(user: string, port: number, extra: Record<string, string>) {
  const env: Record<string, string> = {
    AGENTLINK_USER: user,
    AGENTLINK_TOKEN: TOKEN,
    AGENTLINK_DAEMON_PORT: String(port),
    AGENTLINK_DAEMON_DB: path.join(tmp, `daemon-${user}.sqlite`),
    AGENTLINK_HUB_ID: HUB_ID,
    AGENTLINK_DISCOVERY: "manual", // no mDNS: the scan alone has to find it
    ...extra,
  };
  const p = spawn(process.execPath, ["--import", TSX_LOADER, path.join(daemonDir, "src/index.ts")], {
    cwd: tmp,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "AGENTLINK_HUB_URL")), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = fs.createWriteStream(path.join(tmp, `${user}.out`), { flags: "a" });
  p.stdout!.pipe(out);
  p.stderr!.pipe(out);
  procs.push(p);
  return p;
}

const health = async (port: number) => (await (await fetch(`http://127.0.0.1:${port}/v1/health`)).json()).hub;
const hellos = (name: string) =>
  (fs.existsSync(path.join(tmp, `${name}.out`)) ? fs.readFileSync(path.join(tmp, `${name}.out`), "utf8") : "")
    .split("\n")
    .filter((l) => l.includes('"event":"hello"'));
const logLines = (user: string) =>
  fs.readFileSync(path.join(tmp, "logs", `daemon-${user}.log`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

async function main() {
  fakeHub("decoy", DECOY, DECOY_ID);
  let hub = fakeHub("hub-a", HUB_A, HUB_ID);
  await until("fake hubs up", async () => (await fetch(`http://127.0.0.1:${HUB_A}/api/health`)).ok && (await fetch(`http://127.0.0.1:${DECOY}/api/health`)).ok);

  // 1. only AGENTLINK_HUB_ID: found by scan, decoy ignored
  let alex = daemon("alex", ALEX, { AGENTLINK_SCAN_HOSTS: SCAN_HOSTS });
  const h1 = await until("alex connected", async () => {
    const h = await health(ALEX);
    return h.state === "connected" ? h : null;
  });
  check(`alex found the hub by scan (${h1.url})`, h1.via === "scan" && h1.url.endsWith(`:${HUB_A}`), h1);
  check("health reports hub_id and searching=false", h1.hub_id === HUB_ID && h1.searching === false, h1);
  check("hub-a got alex's hello", hellos("hub-a").some((l) => l.includes('"user":"alex"')));
  check("hub.found {via:scan} logged", logLines("alex").some((l) => l.event === "hub.found" && l.via === "scan" && l.url.endsWith(`:${HUB_A}`)));

  // 2. the hub moves to another port in the scan list
  await stop(hub);
  const searching = await until("alex searching", async () => {
    const h = await health(ALEX);
    return h.state !== "connected" && h.searching ? h : null;
  });
  check("while the hub is gone: searching=true, not connected", searching.searching === true, searching);
  hub = fakeHub("hub-b", HUB_B, HUB_ID);
  const h2 = await until("alex reconnected to the moved hub", async () => {
    const h = await health(ALEX);
    return h.state === "connected" && h.url.endsWith(`:${HUB_B}`) ? h : null;
  }, 25_000);
  check(`moved hub found again (${h2.url}, via ${h2.via})`, h2.hub_id === HUB_ID, h2);

  // 3. restart: the last known address is tried first, no scan needed
  await stop(alex);
  const before = logLines("alex").length;
  alex = daemon("alex", ALEX, { AGENTLINK_SCAN_HOSTS: SCAN_HOSTS });
  const h3 = await until("alex reconnected after restart", async () => {
    const h = await health(ALEX);
    return h.state === "connected" ? h : null;
  });
  const after = logLines("alex").slice(before);
  check(`after restart: via last_known (${h3.url})`, h3.via === "last_known" && h3.url.endsWith(`:${HUB_B}`), h3);
  const stages = after.filter((l) => l.event === "hub.search").map((l) => l.stage);
  check(`after restart: no scan before it was found (stages: ${stages.join(",")})`, !stages.includes("scan"), stages);

  // 4. a manual URL pointing at the decoy is refused before any hello
  daemon("bob", BOB, { AGENTLINK_HUB_URL: `http://127.0.0.1:${DECOY}`, AGENTLINK_SCAN: "0" });
  await until("bob logs id_changed", async () => logLines("bob").find((l) => l.event === "hub.id_changed"));
  await sleep(1500);
  const hb = await health(BOB);
  check("manual URL with another hub_id: not connected, still searching", hb.state !== "connected" && hb.searching === true, hb);
  const idc = logLines("bob").find((l) => l.event === "hub.id_changed");
  check("hub.id_changed logged at precheck for the manual URL", idc.stage === "precheck" && idc.got_hub_id === DECOY_ID, idc);

  // 5. v2 impostors: a liar (health says the pin, its challenge doesn't) and a copier (copies the
  //    hub_id everywhere but doesn't know the token, accepts any proof). carol scans liar, copier, hub.
  const LIAR = BASE + 7;
  const COPIER = BASE + 8;
  const CAROL = BASE + 9;
  run("liar", ["test/fake-hub.ts"], daemonDir, { AGENTLINK_TOKEN: TOKEN, FAKE_HUB_PORT: String(LIAR), FAKE_HUB_ID: "liar-id", FAKE_HUB_HEALTH_ID: HUB_ID });
  run("copier", ["test/fake-hub.ts"], daemonDir, { AGENTLINK_TOKEN: "not-the-token", FAKE_HUB_PORT: String(COPIER), FAKE_HUB_ID: HUB_ID, FAKE_HUB_ACCEPT_ANY: "1" });
  await until("impostors up", async () => (await fetch(`http://127.0.0.1:${LIAR}/api/health`)).ok && (await fetch(`http://127.0.0.1:${COPIER}/api/health`)).ok);
  daemon("carol", CAROL, { AGENTLINK_SCAN_HOSTS: [LIAR, COPIER, HUB_B].map((p) => `127.0.0.1:${p}`).join(",") });
  const hc = await until("carol connected", async () => {
    const h = await health(CAROL);
    return h.state === "connected" ? h : null;
  }, 40_000);
  check(`carol ends up on the real hub (${hc.url})`, hc.url.endsWith(`:${HUB_B}`), hc);
  const carolLog = logLines("carol");
  const imps = carolLog.filter((l) => l.event === "hub.impostor");
  const liarOut = fs.readFileSync(path.join(tmp, "liar.out"), "utf8");
  const copierOut = fs.readFileSync(path.join(tmp, "copier.out"), "utf8");
  check("liar: hub.impostor at challenge (if it was tried)", !liarOut.includes("ws.connection") || imps.some((l) => l.stage === "challenge" && l.url.endsWith(`:${LIAR}`)), imps);
  check("liar: never received a single frame", !liarOut.includes('"event":"first_frame"'), liarOut.slice(-300));
  const copierHellos = copierOut.split("\n").filter((l) => l.includes('"event":"first_frame"'));
  check(`copier: at most one hello (${copierHellos.length}), no repeat after the bad server_proof`, copierHellos.length <= 1, copierHellos);
  check("copier: hub.impostor at server_proof (if it was tried)", copierHellos.length === 0 || imps.some((l) => l.stage === "server_proof" && l.url.endsWith(`:${COPIER}`)), imps);
  check("copier: the raw token never arrived in any frame", !copierOut.includes('"raw_token_sent":true') && !copierOut.includes('"has_token_field":true'));
  const denied = carolLog.filter((l) => l.event === "hub.denied").map((l) => l.url);
  check(`impostors deny-listed for the run (${denied.join(", ")})`, imps.every((i) => denied.includes(i.url)), { imps, denied });

  // 6. first run, nothing pinned: the copier at the manual URL is refused before anything is pinned
  const DAVE = BASE + 10;
  const dave = spawn(process.execPath, ["--import", TSX_LOADER, path.join(daemonDir, "src/index.ts")], {
    cwd: tmp,
    env: {
      ...process.env,
      AGENTLINK_USER: "dave",
      AGENTLINK_TOKEN: TOKEN,
      AGENTLINK_DAEMON_PORT: String(DAVE),
      AGENTLINK_DAEMON_DB: path.join(tmp, "daemon-dave.sqlite"),
      AGENTLINK_HUB_URL: `http://127.0.0.1:${COPIER}`,
      AGENTLINK_DISCOVERY: "manual",
      AGENTLINK_SCAN: "0",
      AGENTLINK_HUB_ID: "",
    },
    stdio: "ignore",
  });
  procs.push(dave);
  const daveImp = await until("dave impostor", async () => logLines("dave").find((l) => l.event === "hub.impostor"));
  await sleep(1500);
  const daveLog = logLines("dave");
  check("first run: server_proof checked before pinning (hub.impostor, no hub.pinned)", daveImp.stage === "server_proof" && !daveLog.some((l) => l.event === "hub.pinned"), daveLog.filter((l) => l.event.startsWith("hub.")).slice(-6));
  check("first run: not connected to the copier", (await health(DAVE)).state !== "connected");

  // REST proxies use the per-socket session, never the shared token
  const anyRaw = ["hub-a", "hub-b", "liar", "copier", "decoy"].some((n) => fs.readFileSync(path.join(tmp, `${n}.out`), "utf8").includes('"event":"rest.raw_token"'));
  check("no hub ever saw the shared token on REST", !anyRaw);

  // the decoy never saw a hello from anyone
  check("the decoy hub never received a hello", hellos("decoy").length === 0, hellos("decoy"));
  const decoyOut = fs.readFileSync(path.join(tmp, "decoy.out"), "utf8");
  check("the decoy never even got a WebSocket connection", !decoyOut.includes('"event":"ws.connection"'), decoyOut.slice(-300));
  check("the decoy's output never contains the token", !decoyOut.includes(TOKEN));
  check("the real hub did log connections (instrumentation works)", fs.readFileSync(path.join(tmp, "hub-a.out"), "utf8").includes('"event":"ws.connection"'));
}

main()
  .catch((err) => {
    failures++;
    console.log(`FAIL  ${(err as Error).message}`);
  })
  .finally(async () => {
    await Promise.all(procs.map(stop));
    console.log(failures ? `\n${failures} failure(s); logs in ${tmp}` : "\nall passed");
    process.exit(failures ? 1 : 0);
  });
