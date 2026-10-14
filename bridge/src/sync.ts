import type { SessionKind, SessionStatus } from "../../contracts/index.ts";
import type { BridgeConfig } from "./config.ts";
import type { Daemon } from "./daemon.ts";
import { log } from "./log.ts";
import type { Store } from "./store.ts";
import { readTeam, statusOf, type SlotView } from "./team.ts";
import type { Tmux } from "./tmux.ts";

interface Desired {
  kind: SessionKind;
  status: SessionStatus;
  task: string;
}

/**
 * Status sync: every syncMs, PUT /v1/sessions/<agent> for each slot whose status or task changed (and every
 * refreshMs regardless); DELETE agents whose slot disappeared, including ones left over from a previous run.
 */
export class StatusSync {
  team: SlotView[] = [];
  private last = new Map<string, { key: string; at: number }>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private again = false;

  constructor(
    private cfg: BridgeConfig,
    private tmux: Tmux,
    private daemon: Daemon,
    private store: Store,
  ) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.cfg.syncMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Run a sync now (or right after the one in progress). */
  async tick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.once();
      } while (this.again);
    } catch (err) {
      log("sync.error", { detail: String((err as Error)?.message ?? err) });
    } finally {
      this.running = false;
    }
  }

  private async once(): Promise<void> {
    const team = await readTeam(this.tmux, this.cfg.stateDir);
    this.team = team;
    const desired = new Map<string, Desired>();
    const workersActive = team.filter((s) => s.kind === "worker" && statusOf(s) !== "idle").length;
    for (const s of team) {
      const status = statusOf(s);
      const task =
        s.kind === "orchestrator" ? (workersActive ? `coordinating ${workersActive} worker${workersActive === 1 ? "" : "s"}` : "") : s.task;
      desired.set(s.agent, { kind: s.kind, status, task });
    }

    const now = Date.now();
    for (const [agent, d] of desired) {
      const key = JSON.stringify(d);
      const prev = this.last.get(agent);
      if (prev && prev.key === key && now - prev.at < this.cfg.refreshMs) continue;
      try {
        await this.daemon.putSession(agent, d);
        this.last.set(agent, { key, at: now });
        if (!prev || prev.key !== key) log("session.put", { agent, ...d });
      } catch (err) {
        log("session.put_failed", { agent, detail: String((err as Error)?.message ?? err) });
      }
    }

    const gone = new Set([...this.last.keys(), ...this.store.agents].filter((a) => !desired.has(a)));
    for (const agent of gone) {
      try {
        await this.daemon.deleteSession(agent);
        this.last.delete(agent);
        log("session.delete", { agent });
      } catch (err) {
        log("session.delete_failed", { agent, detail: String((err as Error)?.message ?? err) });
        continue;
      }
    }
    this.store.setAgents([...desired.keys()]);
  }

  /** On shutdown: show every agent as offline rather than leaving a stale "working". */
  async markOffline(): Promise<void> {
    await Promise.all(
      this.team.map((s) => this.daemon.putSession(s.agent, { kind: s.kind, status: "offline", task: "" }).catch(() => {})),
    );
  }
}
