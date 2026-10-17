import type { BridgeConfig } from "./config.ts";
import { DaemonHttpError, type Daemon, type InputRequest, type InputResult } from "./daemon.ts";
import { log } from "./log.ts";
import { readTeam } from "./team.ts";
import { PROMPT_RE, sanitizeForPaste, sleep, type Tmux } from "./tmux.ts";

const MAX_TEXT = 4_000;
const SEEN_MAX = 500;

/**
 * Local terminal input (contracts/input.md): the person at THIS laptop's UI types into their own panes.
 * The daemon only accepts it from the local UI origin; nothing remote reaches this stream.
 * The text is never logged, only its length.
 */
export class PaneInput {
  private queue: InputRequest[] = [];
  private seen = new Set<string>(); // ids already handled, in case the daemon resends one after a reconnect
  private draining = false;
  private stopped = false;
  private abort = new AbortController();

  constructor(
    private cfg: BridgeConfig,
    private tmux: Tmux,
    private daemon: Daemon,
    private afterClear: () => void,
  ) {}

  start(): void {
    void this.streamLoop();
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
  }

  private async streamLoop(): Promise<void> {
    let backoff = 1_000;
    while (!this.stopped) {
      try {
        await this.daemon.inputStream(
          (r) => this.offer(r),
          this.abort.signal,
          () => {
            log("input.stream_connected", {});
            backoff = 1_000;
          },
        );
        if (!this.stopped) log("input.stream_closed", {});
      } catch (err) {
        if (this.stopped) return;
        log("input.stream_error", { detail: String((err as Error)?.message ?? err), retry_ms: backoff });
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 10_000);
    }
  }

  private offer(raw: unknown): void {
    const r = raw as Partial<InputRequest> | null;
    const id = typeof r?.id === "string" ? r.id : null;
    if (!id) return log("input.bad_request", { reason: "no id" });
    if (this.seen.has(id)) return;
    this.seen.add(id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value!);
    const agents = Array.isArray(r!.agents) ? r!.agents.filter((a): a is string => typeof a === "string") : [];
    const text = typeof r!.text === "string" ? r!.text : "";
    if (!agents.length || !text.length || text.length > MAX_TEXT) {
      log("input.bad_request", { id, agents: agents.length, chars: text.length });
      void this.report(id, Object.fromEntries(agents.map((a) => [a, "failed: bad_request" as InputResult])));
      return;
    }
    this.queue.push({ id, agents: [...new Set(agents)], text, submit: r!.submit !== false });
    log("input.received", { id, agents, chars: text.length, submit: r!.submit !== false });
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length && !this.stopped) await this.handle(this.queue.shift()!);
    } finally {
      this.draining = false;
    }
  }

  private async handle(req: InputRequest): Promise<void> {
    const team = await readTeam(this.tmux, this.cfg.stateDir);
    const text = sanitizeForPaste(req.text);
    const isClear = req.text === "/clear";
    const results: Record<string, InputResult> = {};
    // One pane at a time keeps tmux buffer use simple; each paste is quick (0.4s before Enter).
    for (const agent of req.agents) {
      const slot = team.find((s) => s.agent === agent);
      let result: InputResult;
      if (!slot) {
        result = "skipped: no_pane";
      } else if (PROMPT_RE.test(await this.tmux.screen(slot.pane))) {
        result = "skipped: prompt_open"; // typing would answer the prompt; don't wait, report it
      } else {
        const why = await this.tmux.type(slot.pane, text, `agentlink-in-${req.id.slice(0, 8)}-${agent}`, req.submit);
        result = why ? `failed: ${why}` : "sent";
        if (!why && isClear) {
          await this.tmux.setOption(slot.pane, "@state", "idle");
          await this.tmux.setOption(slot.pane, "@task", "");
        }
      }
      results[agent] = result;
      log("input.typed", { id: req.id, agent, result });
    }
    if (isClear) this.afterClear();
    await this.report(req.id, results);
  }

  private async report(id: string, results: Record<string, InputResult>): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.daemon.postInputResult(id, results);
        return;
      } catch (err) {
        log("input.result_failed", { id, attempt: attempt + 1, detail: String((err as Error)?.message ?? err) });
        // 404 unknown id / 409 already finished (e.g. timed out as no_result): retrying can't help.
        if (err instanceof DaemonHttpError && err.status >= 400 && err.status < 500) return;
        await sleep(1_000 * (attempt + 1));
      }
    }
  }
}
