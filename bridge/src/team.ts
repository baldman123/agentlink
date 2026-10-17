import type { SessionKind, SessionStatus } from "../../contracts/index.ts";
import { isBusy, PROMPT_RE, readRegistry, type Tmux } from "./tmux.ts";

export interface SlotView {
  slot: number;
  pane: string;
  agent: string; // "orchestrator" | "worker-N"
  kind: SessionKind;
  role: string; // @role
  state: string; // @state
  task: string; // @task
  screen: string;
}

/**
 * Snapshot of the c4 team: registry lines whose pane still exists, with pane options and screen.
 * Identity (contracts/bridge.md): the slot with @role orchestrator (else slot 0) is <user>/orchestrator;
 * slots 1-4 are worker-N. Any other slot (a slot 0 that isn't the orchestrator) is not mapped.
 */
export async function readTeam(tmux: Tmux, stateDir: string): Promise<SlotView[]> {
  const lines = readRegistry(stateDir);
  const raw = await Promise.all(
    lines.map(async ({ slot, pane }) => {
      if (!(await tmux.paneExists(pane))) return null;
      const [role, state, task, screen] = await Promise.all([
        tmux.option(pane, "@role"),
        tmux.option(pane, "@state"),
        tmux.option(pane, "@task"),
        tmux.screen(pane),
      ]);
      return { slot, pane, role, state, task, screen };
    }),
  );
  const live = raw.filter((s): s is NonNullable<typeof s> => s !== null);
  const orch = live.find((s) => s.role === "orchestrator") ?? live.find((s) => s.slot === 0);
  const out: SlotView[] = [];
  const seen = new Set<string>();
  for (const s of live.sort((a, b) => a.slot - b.slot)) {
    let agent: string;
    let kind: SessionKind;
    if (s === orch) {
      agent = "orchestrator";
      kind = "orchestrator";
    } else if (s.slot >= 1 && s.slot <= 4) {
      agent = `worker-${s.slot}`;
      kind = "worker";
    } else continue;
    if (seen.has(agent)) continue; // duplicate registry line
    seen.add(agent);
    out.push({ ...s, agent, kind });
  }
  return out;
}

/** contracts/bridge.md: busy screen → working; @state blocked → error; asking or a yes/no prompt → waiting; else idle. */
export function statusOf(s: SlotView): SessionStatus {
  if (isBusy(s.screen)) return "working";
  if (s.state === "blocked") return "error";
  if (s.state === "asking" || PROMPT_RE.test(s.screen)) return "waiting";
  return "idle";
}
