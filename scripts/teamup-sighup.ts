// team-up.sh's processes must survive the Terminal window closing (SIGHUP), and team-down.sh must still
// stop them. Runs `team-up.sh --host-hub` on a pseudo-terminal (as typed in Terminal), closes it, then
// checks the hub, daemon, bridge and UI are alive and listening, outside the terminal's session.
// Throwaway data dir, ports 7773 (daemon), 7774 (hub), 7776 (UI), its own tmux socket and a c4 session
// name that doesn't exist: the live stack on 7700/7701/7780 is never touched.
//
//   npx tsx scripts/teamup-sighup.ts
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-sighup-"));
const DATA = path.join(TMP, "data");
const PORTS = { daemon: 7773, hub: 7774, ui: 7776 };
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
}
const env = () => {
  const e: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const k of Object.keys(e)) if (k.startsWith("AGENTLINK_") || k === "C4_SESSION") delete e[k];
  return { ...e, AGENTLINK_DATA_DIR: DATA, AGENTLINK_TOKEN: "sighup-test-token-0123456789abcdef", AGENTLINK_UI_PORT: String(PORTS.ui), C4_TMUX_SOCKET: "agentlink-sighup", C4_STATE_DIR: path.join(TMP, "c4") };
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const listening = (port: number) => {
  try {
    execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

for (const p of Object.values(PORTS)) if (listening(p)) throw new Error(`port ${p} is in use; not running`);

// team-up on a pty, waiting for it to finish; then the pty closes (the kernel hangs up its session)
const PTY = `
import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
while True:
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    sys.stdout.buffer.write(chunk); sys.stdout.flush()
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
const args = ["--host-hub", "--user", "alex", "--hub-port", String(PORTS.hub), "--daemon-port", String(PORTS.daemon), "--c4-session", "c4sighuptest"];
const up = await new Promise<{ code: number; out: string }>((resolve) => {
  const p = spawn("python3", ["-I", "-c", PTY, path.join(ROOT, "scripts", "team-up.sh"), ...args], { env: env() });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  const t = setTimeout(() => p.kill("SIGKILL"), 90_000);
  p.on("close", (code) => {
    clearTimeout(t);
    resolve({ code: code ?? 1, out });
  });
});
try {
  check("team-up.sh (on a terminal) starts the team", up.code === 0 && /agentlink is up for alex/.test(up.out), up.out);
  await new Promise((r) => setTimeout(r, 2_000)); // the terminal is closed now
  const pids = Object.fromEntries(
    fs.readFileSync(path.join(DATA, "team.pids"), "utf8").trim().split("\n").map((l) => l.split(" ")).map(([n, p]) => [n, Number(p)]),
  ) as Record<string, number>;
  for (const name of ["hub", "daemon", "bridge", "ui"]) {
    check(`${name} is still running after the terminal closed`, !!pids[name] && alive(pids[name]), pids);
    if (pids[name] && alive(pids[name])) {
      const tty = execFileSync("ps", ["-o", "tty=", "-p", String(pids[name])]).toString().trim();
      check(`${name} has no controlling terminal`, tty === "??" || tty === "", tty);
    }
  }
  check("hub, daemon and UI still listen", listening(PORTS.hub) && listening(PORTS.daemon) && listening(PORTS.ui));
  const h = await fetch(`http://127.0.0.1:${PORTS.daemon}/v1/health`).then((r) => r.json()).catch(() => null);
  check("the daemon is still connected to its hub", h?.hub?.state === "connected", h);

  const down = await run(path.join(ROOT, "scripts", "team-down.sh"), [], { env: env(), timeout: 30_000 });
  check("team-down.sh stops them (none forced)", /stopped hub/.test(down.stdout) && /stopped daemon/.test(down.stdout) && /stopped ui/.test(down.stdout) && !/forced/.test(down.stdout), down.stdout);
  await new Promise((r) => setTimeout(r, 500));
  check("every process is gone", Object.values(pids).every((p) => !alive(p)), pids);
  check("the ports are free again", !Object.values(PORTS).some(listening));
} finally {
  await run(path.join(ROOT, "scripts", "team-down.sh"), [], { env: env(), timeout: 30_000 }).catch(() => {});
  await run("tmux", ["-L", "agentlink-sighup", "kill-server"]).catch(() => {});
}
console.log(failures ? `\n${failures} failed (files in ${TMP})` : "\nall passed");
process.exit(failures ? 1 : 0);
