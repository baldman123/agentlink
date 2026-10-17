// scripts/team-up.sh in cloud mode, against the fake website (fake-cloud.ts). Everything runs in a
// throwaway AGENTLINK_DATA_DIR with daemon port 7772, a tmux socket of its own and a c4 session
// name that doesn't exist, so no real team, daemon or UI is touched. Always ends with team-down.sh.
//
// Run: npx tsx test/cloud-teamup.ts   (from daemon/)
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { startFakeCloud } from "./fake-cloud.ts";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const TEAM_UP = path.join(ROOT, "scripts", "team-up.sh");
const TEAM_DOWN = path.join(ROOT, "scripts", "team-down.sh");
const PORT = 7772;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-cloud-teamup-"));
const DATA = path.join(TMP, "data");
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
}

const baseEnv = (extra: Record<string, string> = {}) => {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const k of Object.keys(env)) if (k.startsWith("AGENTLINK_") || k === "C4_SESSION") delete env[k];
  return { ...env, AGENTLINK_DATA_DIR: DATA, C4_TMUX_SOCKET: "agentlink-cloud-teamup", C4_STATE_DIR: path.join(TMP, "c4"), ...extra };
};
const COMMON = ["--daemon-port", String(PORT), "--c4-session", "c4cloudtest", "--no-ui"];

async function teamUp(args: string[], env: Record<string, string> = {}) {
  try {
    const r = await run(TEAM_UP, args, { env: baseEnv(env), timeout: 60_000 });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

// Runs argv on a pseudo-terminal; types TYPE_INPUT once "access code for" shows up; exits with its status.
const PTY_DRIVER = `
import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
buf, sent = b"", False
while True:
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    buf += chunk
    sys.stdout.buffer.write(chunk); sys.stdout.flush()
    if not sent and b"access code for" in buf:
        os.write(fd, os.environ["TYPE_INPUT"].encode() + b"\\n"); sent = True
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

/** team-up.sh on a pseudo-terminal with `input` typed at its prompt (team-up only asks when stdin is a tty). */
function teamUpTty(args: string[], input: string, env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn("python3", ["-I", "-c", PTY_DRIVER, TEAM_UP, ...args], { env: { ...baseEnv(env), TYPE_INPUT: input } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => p.kill("SIGKILL"), 60_000);
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 1, out });
    });
  });
}

const cloud = await startFakeCloud({ codes: { sam: "code-sam" } });
try {
  // refusals before anything starts
  const noCode = await teamUp(["--user", "sam", "--hub-url", cloud.url, ...COMMON], { AGENTLINK_HUB_MODE: "cloud" });
  check("no access code and no terminal: refuses", noCode.code !== 0 && /no access code/.test(noCode.out), noCode.out);
  const join = await teamUp(["--user", "sam", "--hub-url", "https://example.vercel.app", "--join", "3c0f1234abcd", ...COMMON], { AGENTLINK_TOKEN: "x" });
  check("an https URL with --join is refused (that is LAN-only)", join.code !== 0 && /--join .*LAN hub/.test(join.out), join.out);
  const host = await teamUp(["--user", "sam", "--hub-url", "https://example.vercel.app", "--host-hub", ...COMMON], { AGENTLINK_TOKEN: "x" });
  check("an https URL with --host-hub is refused", host.code !== 0 && /--host-hub runs a LAN hub/.test(host.out), host.out);
  check("nothing was started by the refused runs", !fs.existsSync(path.join(DATA, "team.pids")) || fs.readFileSync(path.join(DATA, "team.pids"), "utf8").trim() === "");

  // first run: asked for the code at the prompt
  const first = await teamUpTty(["--user", "sam", "--hub-url", cloud.url, ...COMMON], "code-sam", { AGENTLINK_HUB_MODE: "cloud" });
  check("asks for the access code in a terminal", /agentlink access code for sam/.test(first.out), first.out);
  check("team-up finishes and the daemon is connected to the website", first.code === 0 && /hub link +connected \(cloud\)/.test(first.out), first.out);
  check("the summary names the website", first.out.includes(`website    ${cloud.url}/`), first.out);
  check("the daemon logged in as sam with that code", cloud.requests.some((r) => r.path === "/api/auth/login" && (r.body as { user?: string; code?: string }).user === "sam" && (r.body as { code?: string }).code === "code-sam"));
  const codeFile = path.join(DATA, ".access-code");
  check("the code is saved in data/.access-code, mode 600", fs.existsSync(codeFile) && fs.readFileSync(codeFile, "utf8").trim() === "code-sam" && (fs.statSync(codeFile).mode & 0o777) === 0o600);
  check("no LAN token file is written", !fs.existsSync(path.join(DATA, ".token")));
  const localEnv = fs.readFileSync(path.join(DATA, "local.env"), "utf8");
  check("local.env remembers the website and cloud mode, not the code", localEnv.includes(`AGENTLINK_HUB_URL=${cloud.url}`) && localEnv.includes("AGENTLINK_HUB_MODE=cloud") && !localEnv.includes("code-sam") && !/AGENTLINK_HUB_ID=/.test(localEnv), localEnv);

  // The pseudo-terminal is gone now (as when the Terminal window is closed): what team-up started must live on.
  await new Promise((r) => setTimeout(r, 1_500));
  const pids = Object.fromEntries(fs.readFileSync(path.join(DATA, "team.pids"), "utf8").trim().split("\n").map((l) => l.split(" ")));
  const alive = (pid: string) => {
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch {
      return false;
    }
  };
  check("after the terminal closes, the daemon and bridge are still running", !!pids.daemon && !!pids.bridge && alive(pids.daemon) && alive(pids.bridge), pids);
  const sid = (pid: string) => Number(execFileSync("ps", ["-o", "sess=", "-p", pid]).toString().trim() || -1);
  check("each runs in a session of its own (no controlling terminal)", ["daemon", "bridge"].every((n) => pids[n] && execFileSync("ps", ["-o", "tty=", "-p", pids[n]]).toString().trim().replace(/^\?\?$/, "") === ""), ["daemon", "bridge"].map((n) => [n, sid(pids[n])]));
  const h = (await (await fetch(`http://127.0.0.1:${PORT}/v1/health`)).json()) as { hub: { url: string; state: string } };
  check("the daemon still answers and is connected to the website", h.hub.url === cloud.url && h.hub.state === "connected", h);

  // later run with no flags: same setup, nothing new started, no prompt
  const pidsBefore = fs.readFileSync(path.join(DATA, "team.pids"), "utf8");
  const again = await teamUp([]);
  check("a plain rerun reuses the saved website and code (no prompt)", again.code === 0 && /hub link +connected \(cloud\)/.test(again.out) && !/access code for/.test(again.out), again.out);
  check("...and starts nothing new", fs.readFileSync(path.join(DATA, "team.pids"), "utf8") === pidsBefore, again.out);

  // revoked code: the summary says what to do
  await run(TEAM_DOWN, [], { env: baseEnv(), timeout: 30_000 });
  cloud.revoked.add("sam");
  const revoked = await teamUp([]);
  check("a revoked code: team-up says so instead of the LAN troubleshooting hint", /hub link +offline \(cloud\)/.test(revoked.out) && /refused the access code, or it was revoked/.test(revoked.out), revoked.out);
} finally {
  const down = await run(TEAM_DOWN, [], { env: baseEnv(), timeout: 30_000 }).catch((e) => e);
  check("team-down.sh stops what team-up started", !String((down as { stdout?: string }).stdout ?? "").includes("not touching"), down);
  await new Promise((r) => setTimeout(r, 500));
  const still = await fetch(`http://127.0.0.1:${PORT}/v1/health`).then(() => true).catch(() => false);
  check("the daemon on 7772 is gone", !still);
  await run("tmux", ["-L", "agentlink-cloud-teamup", "kill-server"]).catch(() => {});
  await cloud.close();
}
console.log(failures ? `\n${failures} failed (files in ${TMP})` : "\nall passed");
process.exit(failures ? 1 : 0);
