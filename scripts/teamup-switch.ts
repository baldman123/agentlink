// team-up.sh switching between LAN and cloud on the same laptop (same data dir):
//   LAN host -> cloud (the remembered hub port and hub id must not turn hosting back on) -> LAN host again.
// Uses a throwaway AGENTLINK_DATA_DIR (never the real data/local.env), daemon 7773, hub 7774, no UI, its own
// tmux socket, a c4 session name that doesn't exist, and the fake website from daemon/test/fake-cloud.ts.
//
//   npx tsx scripts/teamup-switch.ts
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { startFakeCloud } from "../daemon/test/fake-cloud.ts";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const TEAM_UP = path.join(ROOT, "scripts", "team-up.sh");
const TEAM_DOWN = path.join(ROOT, "scripts", "team-down.sh");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-switch-"));
const DATA = path.join(TMP, "data");
const PORTS = { daemon: 7773, hub: 7774 };
const COMMON = ["--user", "bryant", "--daemon-port", String(PORTS.daemon), "--c4-session", "c4switchtest", "--no-ui"];
const LAN_TOKEN = "switch-test-lan-token-0123456789";
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${JSON.stringify(detail).slice(0, 700)}` : ""}`);
}
const baseEnv = (extra: Record<string, string> = {}) => {
  const e: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const k of Object.keys(e)) if (k.startsWith("AGENTLINK_") || k === "C4_SESSION") delete e[k];
  return { ...e, AGENTLINK_DATA_DIR: DATA, C4_TMUX_SOCKET: "agentlink-switch", C4_STATE_DIR: path.join(TMP, "c4"), ...extra };
};
async function teamUp(args: string[], env: Record<string, string> = {}) {
  try {
    const r = await run(TEAM_UP, args, { env: baseEnv(env), timeout: 60_000 });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}
const down = () => run(TEAM_DOWN, [], { env: baseEnv(), timeout: 30_000 }).then((r) => r.stdout).catch((e) => String(e));
const localEnv = () => fs.readFileSync(path.join(DATA, "local.env"), "utf8");
const pids = () => (fs.existsSync(path.join(DATA, "team.pids")) ? fs.readFileSync(path.join(DATA, "team.pids"), "utf8") : "");
const listening = (port: number) => {
  try {
    execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const health = () => fetch(`http://127.0.0.1:${PORTS.daemon}/v1/health`).then((r) => r.json()).catch(() => null) as Promise<{ hub: { url: string; state: string } } | null>;

for (const p of Object.values(PORTS)) if (listening(p)) throw new Error(`port ${p} is in use; not running`);
const cloud = await startFakeCloud({ codes: { bryant: "code-bryant" } });
try {
  // 1. a LAN host
  const lan = await teamUp(["--host-hub", "--hub-port", String(PORTS.hub), ...COMMON], { AGENTLINK_TOKEN: LAN_TOKEN });
  check("starts as the LAN hub host", lan.code === 0 && /hub link +connected/.test(lan.out) && /hub page/.test(lan.out), lan.out);
  check("local.env remembers the hub port and hub id", /AGENTLINK_HUB_PORT=7774/.test(localEnv()) && /AGENTLINK_HUB_ID=/.test(localEnv()), localEnv());

  // 2. asking for the website while the LAN team runs: refused with how to switch, nothing changed
  const busy = await teamUp(["--hub-url", "https://example.vercel.app"]);
  check("https:// while the LAN team runs: refused, says to run team-down first", busy.code !== 0 && /still running for the LAN hub/.test(busy.out) && /team-down\.sh/.test(busy.out), busy.out);
  check("...not the old '--host-hub runs a LAN hub' error", !/--host-hub runs a LAN hub/.test(busy.out), busy.out);
  check("...and local.env is unchanged", /AGENTLINK_HUB_PORT=7774/.test(localEnv()) && !/AGENTLINK_HUB_MODE=cloud/.test(localEnv()));

  // 3. stopped, then switched to the website
  await down();
  const toCloud = await teamUp(["--hub-url", cloud.url], { AGENTLINK_HUB_MODE: "cloud", AGENTLINK_TOKEN: "code-bryant" });
  check("former LAN host switches to the website", toCloud.code === 0 && /hub link +connected \(cloud\)/.test(toCloud.out), toCloud.out);
  check("no hub is started any more", !/started hub/.test(toCloud.out) && !/\bhub \d+/.test(pids()) && !listening(PORTS.hub), { out: toCloud.out, pids: pids() });
  const env3 = localEnv();
  check("local.env drops the hub port and hub id and records cloud mode", !/AGENTLINK_HUB_PORT=/.test(env3) && !/AGENTLINK_HUB_ID=/.test(env3) && /AGENTLINK_HUB_MODE=cloud/.test(env3) && env3.includes(`AGENTLINK_HUB_URL=${cloud.url}`), env3);
  check("the daemon is on the website", (await health())?.hub.url === cloud.url);
  check("the access code went to data/.access-code; the LAN token file is untouched", fs.readFileSync(path.join(DATA, ".access-code"), "utf8").trim() === "code-bryant" && fs.readFileSync(path.join(DATA, ".token"), "utf8").trim() === LAN_TOKEN);
  const plain = await teamUp([]);
  check("a plain rerun stays on the website (the old hub port doesn't come back)", plain.code === 0 && /connected \(cloud\)/.test(plain.out) && !/started hub/.test(plain.out), plain.out);

  // 4. a new http:// hub URL while the cloud team runs: treated as LAN (not the remembered cloud mode), refused until team-down
  const busy2 = await teamUp(["--hub-url", "http://127.0.0.1:9"]);
  check("http:// while the cloud team runs: seen as a switch to LAN and refused", busy2.code !== 0 && /still running for the website/.test(busy2.out) && /switch to a LAN hub/.test(busy2.out), busy2.out);

  // 5. back to hosting the LAN hub
  await down();
  const back = await teamUp(["--host-hub", "--hub-port", String(PORTS.hub), ...COMMON], { AGENTLINK_TOKEN: LAN_TOKEN });
  check("switches back to LAN host (the remembered website is ignored)", back.code === 0 && /hub link +connected$/m.test(back.out) && /started hub/.test(back.out), back.out);
  const env5 = localEnv();
  check("local.env is LAN again: hub port, no cloud mode, no website", /AGENTLINK_HUB_PORT=7774/.test(env5) && !/AGENTLINK_HUB_MODE/.test(env5) && !env5.includes(cloud.url), env5);
  check("the daemon is on the local hub", (await health())?.hub.url === `http://127.0.0.1:${PORTS.hub}`, await health());
} finally {
  const out = await down();
  check("team-down.sh stops everything", !Object.values(PORTS).some(listening), out);
  await run("tmux", ["-L", "agentlink-switch", "kill-server"]).catch(() => {});
  await cloud.close();
}
console.log(failures ? `\n${failures} failed (files in ${TMP})` : "\nall passed");
process.exit(failures ? 1 : 0);
