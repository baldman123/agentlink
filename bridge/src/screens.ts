import { SCREEN_MAX_LINES, type ScreenUpdate } from "../../contracts/index.ts";
import type { BridgeConfig } from "./config.ts";
import type { Daemon } from "./daemon.ts";
import { log } from "./log.ts";
import { cleanScreen, stripAll } from "./redact.ts";
import type { SlotView } from "./team.ts";
import { isBusy, type Tmux } from "./tmux.ts";

const MIN_GAP_MS = 500; // at most 2 updates/s per pane
const REFRESH_MS = 30_000; // resend an unchanged screen now and then (the daemon keeps only the latest, in memory)

/**
 * Opt-in screen sharing (contracts/screens.md, AGENTLINK_SHARE_SCREENS=1). Every screenMs, capture each team
 * pane with colours, keep only SGR, redact, cap, and PUT it to the daemon when it changed. DELETE when a slot goes.
 * Read-only: nothing here ever sends keys to a pane.
 */
export class ScreenShare {
  private last = new Map<string, { text: string; cols: number; rows: number; busy: boolean; at: number }>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private failing = false;

  constructor(
    private cfg: BridgeConfig,
    private tmux: Tmux,
    private daemon: Daemon,
    private team: () => SlotView[],
    private token: string | null,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.cfg.screenMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.last.keys()].map((a) => this.daemon.deleteScreen(a).catch(() => {})));
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const team = this.team();
      const now = Date.now();
      await Promise.all(team.map((s) => this.one(s, now)));
      for (const agent of [...this.last.keys()]) {
        if (team.some((s) => s.agent === agent)) continue;
        this.last.delete(agent);
        try {
          await this.daemon.deleteScreen(agent);
          log("screen.delete", { agent });
        } catch (err) {
          log("screen.delete_failed", { agent, detail: String((err as Error)?.message ?? err) });
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async one(s: SlotView, now: number): Promise<void> {
    const prev = this.last.get(s.agent);
    if (prev && now - prev.at < MIN_GAP_MS) return;
    const [raw, size] = await Promise.all([
      this.tmux.run(["capture-pane", "-p", "-e", "-J", "-S", `-${SCREEN_MAX_LINES}`, "-t", s.pane]),
      this.tmux.run(["display", "-p", "-t", s.pane, "#{pane_width} #{pane_height}"]),
    ]);
    if (!raw.ok || !size.ok) return; // the pane vanished between snapshots; the next sync drops it
    const [cols, rows] = size.out.trim().split(/\s+/).map(Number);
    const text = cleanScreen(raw.out, this.token);
    const visible = stripAll(raw.out).split("\n").slice(-(rows || 1) - 1).join("\n");
    const busy = isBusy(visible);
    const changed = !prev || prev.text !== text || prev.cols !== cols || prev.rows !== rows || prev.busy !== busy;
    if (!changed && now - prev!.at < REFRESH_MS) return;
    const update: ScreenUpdate = { agent: s.agent, text, cols: cols || 80, rows: rows || 24, busy };
    try {
      await this.daemon.putScreen(update);
      this.last.set(s.agent, { text, cols, rows, busy, at: now });
      if (this.failing) log("screen.recovered", {});
      this.failing = false;
    } catch (err) {
      // Log once per outage, not once per pane per second (e.g. an older daemon without /v1/screens).
      if (!this.failing) log("screen.put_failed", { agent: s.agent, detail: String((err as Error)?.message ?? err) });
      this.failing = true;
    }
  }
}
