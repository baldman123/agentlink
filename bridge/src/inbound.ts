import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { HUMAN_AGENT, type InboxItem } from "../../contracts/index.ts";
import { renderPaste, shortId } from "../../orchestrator/src/paste.ts";
import { bodyToText } from "../../orchestrator/src/trust.ts";
import type { BridgeConfig } from "./config.ts";
import type { Daemon } from "./daemon.ts";
import { log, logMsg } from "./log.ts";
import type { Store } from "./store.ts";
import { readTeam, type SlotView } from "./team.ts";
import { sanitizeForPaste, sleep, type Tmux } from "./tmux.ts";

const SKIP_TYPES = new Set(["context_update", "status"]); // shown in the UI; never pasted

/**
 * Inbound: daemon inbox → tmux. Catch up with GET /v1/inbox on start and after every stream drop, follow
 * the SSE stream in between, and paste each item exactly once (ids persist in the Store).
 */
export class Inbound {
  private queue: InboxItem[] = [];
  private queued = new Set<string>();
  private draining = false;
  private stopped = false;
  private abort = new AbortController();
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();

  constructor(
    private cfg: BridgeConfig,
    private tmux: Tmux,
    private daemon: Daemon,
    private store: Store,
    private afterPaste: () => void,
  ) {}

  start(): void {
    void this.streamLoop();
    // Items with no pane to go to (no orchestrator yet) stay queued; retry them now and then.
    this.retryTimer = setInterval(() => void this.drain(), 5_000);
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    if (this.retryTimer) clearInterval(this.retryTimer);
  }

  private async streamLoop(): Promise<void> {
    let backoff = 1_000;
    while (!this.stopped) {
      try {
        // Open the stream first, then catch up, so nothing that arrives in between is missed (dedupe covers overlaps).
        await this.daemon.stream(
          (item) => this.offer(item, "sse"),
          this.abort.signal,
          () => {
            log("sse.connected", { url: `${this.cfg.daemonUrl}/v1/inbox/stream` });
            backoff = 1_000;
            void this.catchUp();
          },
        );
        if (!this.stopped) log("sse.closed", {});
      } catch (err) {
        if (this.stopped) return;
        log("sse.error", { detail: String((err as Error)?.message ?? err), retry_ms: backoff });
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 10_000);
    }
  }

  private async catchUp(): Promise<void> {
    try {
      const items = await this.daemon.unhandledInbox();
      for (const item of items) this.offer(item, "catchup");
    } catch (err) {
      log("catchup.error", { detail: String((err as Error)?.message ?? err) });
    }
  }

  private offer(item: InboxItem, via: "sse" | "catchup"): void {
    const e = item?.envelope;
    if (!e || typeof e.id !== "string") return;
    if (this.store.has(e.id) || this.queued.has(e.id)) return;
    logMsg("msg.received", e, { via, remote: item.remote });
    if (SKIP_TYPES.has(e.type)) {
      this.store.mark(e.id, "skipped", e.type);
      logMsg("msg.skipped", e, { reason: e.type });
      return;
    }
    // Messages for the person at the keyboard are read in the UI; the orchestrator must not act on them.
    if (e.to === `${this.cfg.user}/${HUMAN_AGENT}`) {
      this.store.mark(e.id, "skipped", "for_human");
      logMsg("msg.skipped", e, { reason: "for_human" });
      return;
    }
    // First run only: don't flood the orchestrator with an old backlog it never asked for.
    const age = this.startedAt - Date.parse(item.received_at);
    if (this.store.firstRun && via === "catchup" && age > this.cfg.backlogMs) {
      this.store.mark(e.id, "skipped", "backlog_first_run");
      logMsg("msg.skipped", e, { reason: "backlog_first_run", age_ms: age });
      return;
    }
    this.queued.add(e.id);
    this.queue.push(item);
    void this.drain();
  }

  /** Paste queued items one at a time, in arrival order. */
  private async drain(): Promise<void> {
    if (this.draining || !this.queue.length) return;
    this.draining = true;
    try {
      while (this.queue.length && !this.stopped) {
        const item = this.queue[0];
        const ok = await this.pasteOne(item);
        if (!ok) break; // no target pane yet; keep order and retry later
        this.queue.shift();
        this.queued.delete(item.envelope.id);
      }
    } finally {
      this.draining = false;
    }
  }

  private target(team: SlotView[], to: string): SlotView | null {
    const orch = team.find((s) => s.kind === "orchestrator") ?? null;
    if (this.cfg.direct) {
      const m = to.match(/^([a-z0-9_-]+)\/(worker-[1-4])$/);
      if (m && m[1] === this.cfg.user) {
        const worker = team.find((s) => s.agent === m[2]);
        if (worker) return worker;
      }
    }
    return orch;
  }

  private async pasteOne(item: InboxItem): Promise<boolean> {
    const e = item.envelope;
    const team = await readTeam(this.tmux, this.cfg.stateDir);
    const slot = this.target(team, e.to);
    if (!slot) {
      logMsg("msg.waiting", e, { reason: "no_target_pane" });
      return false;
    }
    const text = sanitizeForPaste(renderPaste(item, this.cfg.user));
    const ok = await this.tmux.paste(slot.pane, text, `agentlink-${shortId(e.id)}`, () =>
      logMsg("msg.paste_waiting", e, { slot: slot.slot, reason: "yes/no prompt on screen" }),
    );
    if (!ok) {
      logMsg("msg.paste_failed", e, { slot: slot.slot, pane: slot.pane });
      return false;
    }
    this.store.mark(e.id, "pasted");
    logMsg("msg.pasted", e, { slot: slot.slot, pane: slot.pane, agent: slot.agent, remote: item.remote });
    this.boardLine(item);
    this.afterPaste();
    return true;
  }

  /** contracts/bridge.md: `- HH:MM **agentlink ← <from>** <type>: <first 60 chars>` in the team board. */
  private boardLine(item: InboxItem): void {
    const e = item.envelope;
    const d = new Date();
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const first = sanitizeForPaste(bodyToText(e.body)).replace(/\s+/g, " ").trim().slice(0, 60);
    try {
      appendFileSync(join(this.cfg.stateDir, "board.md"), `- ${hhmm} **agentlink ← ${e.from}** ${e.type}: ${first}\n`);
    } catch (err) {
      log("board.error", { detail: String((err as Error)?.message ?? err) });
    }
  }
}
