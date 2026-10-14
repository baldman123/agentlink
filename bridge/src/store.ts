import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Outcome = "pasted" | "skipped";

interface StoreFile {
  v: 1;
  items: Record<string, { at: string; outcome: Outcome; reason?: string }>; // inbox ids already handled by the bridge
  agents: string[]; // agents this bridge registered with the daemon, so a restart can DELETE stale ones
}

const MAX_ITEMS = 5_000;

/** Which inbox ids were already pasted (or deliberately skipped). A small JSON file, rewritten atomically. */
export class Store {
  readonly firstRun: boolean;
  private data: StoreFile;

  constructor(private path: string) {
    this.firstRun = !existsSync(path);
    this.data = { v: 1, items: {}, agents: [] };
    if (!this.firstRun) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as StoreFile;
        this.data = { v: 1, items: parsed.items ?? {}, agents: parsed.agents ?? [] };
      } catch {
        // A torn file would otherwise re-paste everything; keep it aside and start empty but not "first run".
        renameSync(path, `${path}.corrupt-${Date.now()}`);
      }
    }
    this.save();
  }

  has(id: string): boolean {
    return id in this.data.items;
  }

  mark(id: string, outcome: Outcome, reason?: string): void {
    this.data.items[id] = { at: new Date().toISOString(), outcome, ...(reason ? { reason } : {}) };
    const ids = Object.keys(this.data.items);
    if (ids.length > MAX_ITEMS) {
      ids.sort((a, b) => this.data.items[a].at.localeCompare(this.data.items[b].at));
      for (const old of ids.slice(0, ids.length - MAX_ITEMS)) delete this.data.items[old];
    }
    this.save();
  }

  get agents(): string[] {
    return [...this.data.agents];
  }

  setAgents(agents: string[]): void {
    const sorted = [...new Set(agents)].sort();
    if (sorted.join() === this.data.agents.join()) return;
    this.data.agents = sorted;
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.path);
  }
}
