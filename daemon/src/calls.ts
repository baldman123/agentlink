// "Your calls" relay (contracts/calls.ts). Mirrors the claude4 calls waiting on this person (the boss circle's inbox,
// ~/.claude4/<session>) to the website, and delivers answers made there back with `c4 decide` / `c4 answer`, exactly
// as the boss circle's /api/decide and /api/answer do. Cloud mode only; AGENTLINK_CALLS=0 turns it off.
//
// The inbox (claude4's own format, read the way ~/.claude4/web/server.js readInbox does):
//   requests/<id>.json  {id, slot, tool, what, why, summary?, detail?, needsBryant, t}; pending while needsBryant and no <id>.bryant
//   questions/<id>.json {id, from, text, summary?, detail?, t};                        pending while no <id>.answer
// Answered in either place, a call leaves the inbox; the next sync drops it from the site too.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { c4Args, CALL_ID_RE, CALLS_MAX, type CallAnswer, type CallKind, type CallSyncResponse, type CallUpload } from "../../contracts/calls.ts";
import type { DaemonHubLink } from "./link.ts";
import { log } from "./log.ts";

export const CALLS_BUSY_MS = 3_000; // while calls are waiting: pick up answers made on the site quickly
export const CALLS_IDLE_MS = 60_000; // nothing waiting: a quiet check now and then (changes sync at once)
const SCAN_MS = 1_500;
const C4_TIMEOUT_MS = 20_000;

export type RunC4 = (args: string[]) => Promise<{ ok: boolean; out: string }>;

export function c4Runner(bin: string, session: string): RunC4 {
  return (args) =>
    new Promise((resolve) => {
      // TMUX_PANE="" is what the boss circle passes: c4 only lets Bryant answer from outside the team's panes
      execFile(bin, args, { env: { ...process.env, C4_SESSION: session, TMUX_PANE: "" }, timeout: C4_TIMEOUT_MS }, (err, out, errOut) =>
        resolve({ ok: !err, out: String(out || errOut || "").trim().slice(0, 300) }),
      );
    });
}

const who = (slot: unknown) => (Number(slot) === 0 ? "the boss" : Number.isInteger(Number(slot)) ? `quarter ${Number(slot)}` : "the team");
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function act(tool: unknown): string {
  if (tool === "Bash") return "run a command";
  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") return "change a file";
  if (tool === "WebFetch" || tool === "WebSearch") return "go on the web";
  return "take a step";
}

/** The pending calls in a claude4 state dir, oldest first, with the plain-English summary first. */
export function readCalls(stateDir: string): CallUpload[] {
  const out: CallUpload[] = [];
  const read = (f: string) => {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const list = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : []);
  const at = (t: unknown) => new Date(Number.isFinite(Number(t)) && Number(t) > 0 ? Number(t) : Date.now()).toISOString();

  const rdir = path.join(stateDir, "requests");
  for (const f of list(rdir)) {
    const id = f.slice(0, -5);
    if (!CALL_ID_RE.test(id) || fs.existsSync(path.join(rdir, `${id}.bryant`))) continue;
    const r = read(path.join(rdir, f));
    if (!r || r.needsBryant !== true) continue;
    const why = text(r.why) || null;
    const summary = text(r.summary) || `${capital(who(r.slot))} wants to ${act(r.tool)}${why ? ` (${why})` : ""}. Yes lets it go ahead; No stops it.`;
    out.push({ id, kind: "permission", summary, details: text(r.detail) || text(r.what), why, from: who(r.slot), asked_at: at(r.t) });
  }

  const qdir = path.join(stateDir, "questions");
  for (const f of list(qdir)) {
    const id = f.slice(0, -5);
    if (!CALL_ID_RE.test(id) || fs.existsSync(path.join(qdir, `${id}.answer`))) continue;
    const q = read(path.join(qdir, f));
    if (!q) continue;
    const question = text(q.text);
    const summary = text(q.summary) || question;
    if (!summary) continue;
    // details: the options/context; the full question too when the summary shortened it
    const details = [summary !== question ? question : "", text(q.detail)].filter(Boolean).join("\n\n");
    out.push({ id, kind: "question", summary, details, why: null, from: who(q.from), asked_at: at(q.t) });
  }
  return out.sort((a, b) => a.asked_at.localeCompare(b.asked_at) || a.id.localeCompare(b.id)).slice(0, CALLS_MAX);
}

export class CallRelay {
  private scanTimer: NodeJS.Timeout | null = null;
  private lastKey: string | null = null;
  private lastSync = 0;
  private syncing = false;
  private again = false;
  private delivering = new Set<string>();
  private failedOnce = new Set<string>();

  constructor(
    private hub: DaemonHubLink,
    private stateDir: string,
    private runC4: RunC4,
    private busyMs = CALLS_BUSY_MS,
    private idleMs = CALLS_IDLE_MS,
    private scanMs = SCAN_MS,
  ) {
    this.hub.on("state", () => {
      if (this.scanTimer && this.hub.connected) {
        this.lastKey = null; // the site may have missed changes while we were away
        void this.tick();
      }
    });
  }

  start() {
    if (this.scanTimer) return;
    log("calls.started", { state_dir: this.stateDir });
    this.scanTimer = setInterval(() => void this.tick(), this.scanMs);
    void this.tick();
  }

  stop() {
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
  }

  /** One pass: scan the inbox; sync when it changed, or when it's time to look for answers made on the site. */
  async tick(force = false): Promise<void> {
    if (!this.hub.connected) return;
    if (this.syncing) {
      this.again = true;
      return;
    }
    const calls = readCalls(this.stateDir);
    const key = JSON.stringify(calls);
    const due = Date.now() - this.lastSync >= (calls.length ? this.busyMs : this.idleMs);
    if (!force && key === this.lastKey && !due) return;
    this.syncing = true;
    try {
      const r = await this.hub.rest("PUT", "/api/calls/sync", { calls });
      if (r.status !== 200) {
        log("calls.sync_failed", { status: r.status, error: (r.body as { error?: string } | null)?.error });
        return;
      }
      if (key !== this.lastKey) log("calls.synced", { pending: calls.length, ids: calls.map((c) => c.id) });
      this.lastKey = key;
      this.lastSync = Date.now();
      const kinds = new Map(calls.map((c) => [c.id, c.kind]));
      const answers = (r.body as CallSyncResponse | null)?.answers ?? [];
      const delivered = await Promise.all(answers.map((a) => this.deliver(a, kinds.get(a.id))));
      if (delivered.some(Boolean)) this.again = true; // sync right away so the site drops them
    } catch (err) {
      log("calls.sync_failed", { detail: String((err as Error)?.message ?? err) });
    } finally {
      this.syncing = false;
      if (this.again) {
        this.again = false;
        void this.tick(true);
      }
    }
  }

  /** Delivers one site answer into claude4. True when the call has left the inbox. */
  private async deliver(a: CallAnswer & { id: string }, kind: CallKind | undefined): Promise<boolean> {
    if (!kind || this.delivering.has(a.id)) return false; // already answered locally: the next sync drops it
    this.delivering.add(a.id);
    try {
      const r = await this.runC4(c4Args(a.id, kind, a));
      // "already answered" (on the boss circle, a moment ago) is fine: it has left the inbox either way
      const gone = !readCalls(this.stateDir).some((c) => c.id === a.id);
      if (r.ok || gone) {
        log("calls.delivered", { id: a.id, kind, choice: a.choice, ok: r.ok }); // never the note
        return true;
      }
      if (!this.failedOnce.has(a.id)) log("calls.deliver_failed", { id: a.id, detail: r.out });
      this.failedOnce.add(a.id);
      return false;
    } finally {
      this.delivering.delete(a.id);
    }
  }
}
