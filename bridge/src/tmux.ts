import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// tmux access, mirroring what ~/.local/bin/c4 does. execFile (no shell), so pane text is never interpreted.

export const PROMPT_RE = /Do you want to proceed\?|Enter to confirm|Esc to cancel/; // same as c4 send()
export const BUSY_RE = /esc to interrupt/i;

export class Tmux {
  constructor(private socket: string | null) {}

  run(args: string[]): Promise<{ ok: boolean; out: string }> {
    const full = this.socket ? ["-L", this.socket, ...args] : args;
    return new Promise((resolve) => {
      execFile("tmux", full, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve({ ok: !err, out: String(stdout ?? "") }));
    });
  }

  async paneExists(pane: string): Promise<boolean> {
    const r = await this.run(["display", "-p", "-t", pane, "#{pane_id}"]);
    return r.ok && r.out.trim() === pane;
  }

  async option(pane: string, name: string): Promise<string> {
    return (await this.run(["show", "-pqv", "-t", pane, name])).out.replace(/\n$/, "");
  }

  async screen(pane: string): Promise<string> {
    return (await this.run(["capture-pane", "-p", "-t", pane])).out;
  }

  /**
   * c4 send(): wait while the pane shows a yes/no prompt (up to 600s, then paste anyway, like c4),
   * bracketed paste through a named buffer, short pause, Enter.
   */
  async paste(pane: string, text: string, bufferName: string, onWait?: () => void): Promise<boolean> {
    for (let i = 0; i < 600; i++) {
      if (!PROMPT_RE.test(await this.screen(pane))) break;
      if (i === 0) onWait?.();
      await sleep(1_000);
    }
    return (await this.type(pane, text, bufferName, true)) === null;
  }

  /** Bracketed paste through a named buffer, then (if submit) a short pause and Enter. Returns null, or why it failed. */
  async type(pane: string, text: string, bufferName: string, submit: boolean): Promise<string | null> {
    if (!(await this.run(["set-buffer", "-b", bufferName, "--", text])).ok) return "set-buffer";
    if (!(await this.run(["paste-buffer", "-p", "-d", "-b", bufferName, "-t", pane])).ok) return "paste-buffer";
    if (!submit) return null;
    await sleep(400);
    return (await this.run(["send-keys", "-t", pane, "Enter"])).ok ? null : "send-keys";
  }

  async setOption(pane: string, name: string, value: string): Promise<boolean> {
    return (await this.run(["set", "-p", "-t", pane, name, value])).ok;
  }
}

export interface RegistryLine {
  slot: number;
  pane: string;
}

/** ~/.claude4/$C4_SESSION/panes: "slot pane_id" per line. */
export function readRegistry(stateDir: string): RegistryLine[] {
  let text = "";
  try {
    text = readFileSync(join(stateDir, "panes"), "utf8");
  } catch {
    return [];
  }
  const out: RegistryLine[] = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(%\d+)$/);
    if (m) out.push({ slot: Number(m[1]), pane: m[2] });
  }
  return out;
}

/**
 * Remove characters that a terminal or tmux would act on: C0 controls (except newline and tab), DEL and C1.
 * Without this, a remote body containing ESC[201~ would end the bracketed paste early and the rest would
 * be typed as keystrokes into the Claude session.
 */
export function sanitizeForPaste(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
