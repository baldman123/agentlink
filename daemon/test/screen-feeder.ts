// Fake screen source for UI work: registers orchestrator + worker-1..4 sessions on each given daemon
// and PUTs a changing, coloured terminal screen for every one of them once a second, the way a bridge
// with AGENTLINK_SHARE_SCREENS=1 would. Stop with ctrl-c (or SIGTERM); it DELETEs the sessions on exit.
//
//   npx tsx daemon/test/screen-feeder.ts 7791 7792
import { SCREEN_MAX_LINES } from "../../contracts/index.ts";

const ports = process.argv.slice(2).map(Number).filter((n) => n > 0);
if (!ports.length) {
  console.error("usage: tsx daemon/test/screen-feeder.ts <daemon port> [<daemon port> ...]");
  process.exit(1);
}
const AGENTS = ["orchestrator", "worker-1", "worker-2", "worker-3", "worker-4"];
const ESC = "\u001b";
const c = (code: string, s: string) => `${ESC}[${code}m${s}${ESC}[0m`;

async function call(port: number, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 404) throw new Error(`${method} ${path} on ${port}: ${res.status} ${await res.text()}`);
}

const history = new Map<string, string[]>();
function screenFor(port: number, agent: string, tick: number): { text: string; busy: boolean } {
  const key = `${port}/${agent}`;
  const lines = history.get(key) ?? [c("1;36", `● ${agent}`) + c("2", ` (fake screen from daemon ${port})`), ""];
  const busy = agent !== "orchestrator" && Math.floor(tick / 5 + AGENTS.indexOf(agent)) % 3 !== 0;
  const n = lines.length;
  lines.push(
    tick % 4 === 0
      ? `${c("33", "⏺")} Bash(npm test)  ${c("32", `✓ ${n} passed`)}`
      : `${c("2", `${new Date().toISOString().slice(11, 19)}`)} step ${tick}: ${c("35", "editing")} src/${agent}.ts ${c("1", "bold")} ${c("4", "underlined")}`,
  );
  while (lines.length > SCREEN_MAX_LINES - 2) lines.splice(2, 1);
  history.set(key, lines);
  const footer = busy ? c("2", "✻ Working… (esc to interrupt)") : c("2", "> ");
  return { text: [...lines, "", footer].join("\n"), busy };
}

let tick = 0;
let stopping = false;
const timer = setInterval(async () => {
  tick++;
  for (const port of ports) {
    for (const agent of AGENTS) {
      const s = screenFor(port, agent, tick);
      await call(port, "PUT", `/v1/screens/${agent}`, { agent, ...s, cols: 100, rows: 30 }).catch((e) => console.error(String(e)));
    }
  }
}, 1000);

for (const port of ports) {
  for (const agent of AGENTS) {
    const kind = agent === "orchestrator" ? "orchestrator" : "worker";
    await call(port, "PUT", `/v1/sessions/${agent}`, { kind, status: "working", task: `fake ${agent} task` });
  }
}
console.error(`feeding screens for ${AGENTS.length} agents on daemons ${ports.join(", ")}; ctrl-c to stop`);

async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  for (const port of ports) for (const agent of AGENTS) await call(port, "DELETE", `/v1/sessions/${agent}`).catch(() => {});
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
