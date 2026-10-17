import { HUMAN_AGENT, type Envelope, type InboxItem } from "../../contracts/index.ts";
import { shortId } from "../../orchestrator/src/paste.ts";
import type { BridgeConfig } from "./config.ts";
import type { Daemon } from "./daemon.ts";
import { log } from "./log.ts";
import { redact, stripAll } from "./redact.ts";
import { readTeam, statusOf, type SlotView } from "./team.ts";
import type { Tmux } from "./tmux.ts";

const TAIL_LINES = 12;
const GIVE_UP_MS = 24 * 60 * 60_000; // a pane that never goes idle: stop watching after a day

interface Pending {
  id: string;
  agent: string; // the slot it was pasted to: "orchestrator" | "worker-N"
  pane: string;
  hops: number;
  pastedAt: number;
  idleSince: number | null;
}

const RULE_RE = /^\s*[─━]{10,}\s*$/;
const CHROME_RE = /^[\s─━│┃╭╮╰╯┌┐└┘├┤>❯·•]*$/;

/**
 * The last non-empty lines of a Claude Code pane, with the input box and the footer under it cut off
 * (Claude Code draws the box between two horizontal rules at the bottom). Escape codes are stripped and
 * secrets redacted, since the result leaves the pane.
 */
export function paneTail(screen: string, token: string | null, n = TAIL_LINES): string {
  let lines = stripAll(screen).split("\n").map((l) => l.trimEnd());
  const rules = lines.flatMap((l, i) => (RULE_RE.test(l) ? [i] : []));
  if (rules.length >= 2) lines = lines.slice(0, rules[rules.length - 2]);
  const kept = lines.filter((l) => !CHROME_RE.test(l));
  return redact(kept.slice(-n).join("\n"), token);
}

/** The text of the fallback result: who answered where, and what their screen ended with. */
export function renderFallback(agent: string, tail: string): string {
  const who = agent === "orchestrator" ? "The boss" : agent.replace(/^worker-(\d)$/, "Worker $1");
  let fence = "```";
  while (tail.includes(fence)) fence += "`";
  const lines = tail.trim() ? `The last lines on its screen:\n\n${fence}\n${tail}\n${fence}` : "Its screen showed nothing to quote.";
  return `${who} answered in its terminal pane only and didn't send it here with agentlink reply. ${lines}`;
}

/**
 * Answers to the person at the UI (contracts/bridge.md, "Answers to the UI"). After a UI message is pasted, watch
 * for a reply: anything to <user>/human with reply_to = its id, or any message from that slot's agent to
 * <user>/human sent after the paste. Once the pane has been idle for answerWaitMs with no reply, send one
 * short `result` to <user>/human on the agent's behalf, quoting the end of its screen. Kept in memory only:
 * a bridge restart forgets what it was watching.
 */
export class AnswerWatch {
  private pending = new Map<string, Pending>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private cfg: BridgeConfig,
    private tmux: Tmux,
    private daemon: Daemon,
    private token: string | null,
  ) {}

  get watching(): number {
    return this.pending.size;
  }

  start(): void {
    this.timer = setInterval(() => void this.check(), this.cfg.answerCheckMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  track(item: InboxItem, slot: SlotView): void {
    const e = item.envelope;
    this.pending.set(e.id, { id: e.id, agent: slot.agent, pane: slot.pane, hops: e.hops, pastedAt: Date.now(), idleSince: null });
    log("answer.watching", { id: e.id, agent: slot.agent, wait_ms: this.cfg.answerWaitMs });
  }

  private answers(p: Pending, sent: Envelope[]): boolean {
    const human = `${this.cfg.user}/${HUMAN_AGENT}`;
    const from = `${this.cfg.user}/${p.agent}`;
    return sent.some(
      (e) => e.to === human && (e.reply_to === p.id || (e.from === from && Date.parse(e.timestamp) >= p.pastedAt)),
    );
  }

  async check(): Promise<void> {
    if (this.running || !this.pending.size) return;
    this.running = true;
    try {
      const human = `${this.cfg.user}/${HUMAN_AGENT}`;
      // Outbox first, then hub history: a reply that leaves the outbox in between is then in the history.
      const outbox = await this.daemon.outbox().catch(() => null);
      const history = await this.daemon.messages(human, 200).catch(() => null);
      if (!outbox && !history) return; // daemon unreachable: try again next round
      const sent: Envelope[] = [...(outbox ?? []).map((o) => o.envelope), ...(history ?? [])];
      const team = await readTeam(this.tmux, this.cfg.stateDir);
      const now = Date.now();

      for (const p of [...this.pending.values()]) {
        if (this.answers(p, sent)) {
          this.pending.delete(p.id);
          log("answer.replied", { id: p.id, agent: p.agent, after_ms: now - p.pastedAt });
          continue;
        }
        const slot = team.find((s) => s.pane === p.pane);
        if (!slot || now - p.pastedAt > GIVE_UP_MS) {
          this.pending.delete(p.id);
          log("answer.gave_up", { id: p.id, agent: p.agent, reason: slot ? "too_old" : "pane_gone" });
          continue;
        }
        if (statusOf(slot) !== "idle") {
          p.idleSince = null;
          continue;
        }
        p.idleSince ??= now;
        // Without the hub history a reply it already accepted is invisible, so don't send on the outbox alone.
        if (now - p.idleSince < this.cfg.answerWaitMs || !history) continue;
        await this.sendFallback(p, slot);
      }
    } catch (err) {
      log("answer.error", { detail: String((err as Error)?.message ?? err) });
    } finally {
      this.running = false;
    }
  }

  private async sendFallback(p: Pending, slot: SlotView): Promise<void> {
    const text = renderFallback(p.agent, paneTail(await this.tmux.screen(slot.pane), this.token));
    try {
      const res = await this.daemon.send({
        from_agent: p.agent,
        to: `${this.cfg.user}/${HUMAN_AGENT}`,
        type: "result",
        reply_to: p.id,
        hops: p.hops + 1,
        body: { text },
      });
      this.pending.delete(p.id);
      log("answer.fallback_sent", { id: p.id, short: shortId(p.id), agent: p.agent, result_id: res.id });
    } catch (err) {
      log("answer.fallback_failed", { id: p.id, agent: p.agent, detail: String((err as Error)?.message ?? err) });
    }
  }
}
