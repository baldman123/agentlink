// Fake Claude Code terminal screens for the mock transport. Output uses the same SGR codes a real
// tmux capture-pane -e would contain: 16-colour, 256-colour and truecolor, bold/dim/italic/inverse.
import type { Session, ScreenUpdate } from "../../../contracts/index.ts";
import { SCREEN_MAX_LINES } from "../../../contracts/index.ts";

const E = "\x1b[";
const R = `${E}0m`;
const rgb = (r: number, g: number, b: number) => `${E}38;2;${r};${g};${b}m`;
const bgRgb = (r: number, g: number, b: number) => `${E}48;2;${r};${g};${b}m`;
const BOLD = `${E}1m`;
const DIM = `${E}2m`;
const ITAL = `${E}3m`;
const INV = `${E}7m`;
const CLAUDE = rgb(215, 119, 87); // Claude orange
const OK = `${E}38;5;114m`;
const GREY = `${E}38;5;245m`;
const BLUE = `${E}94m`;

const COLS = 100;
const ROWS = 34;

type Chunk = (task: string) => string[];

const bullet = (s: string) => `${OK}●${R} ${s}`;
const tool = (name: string, arg: string) => `${OK}●${R} ${BOLD}${name}${R}(${arg})`;
const out = (s: string) => `  ${GREY}⎿${R}  ${s}`;
const diffDel = (n: number, s: string) => `      ${GREY}${String(n).padStart(3)}${R} ${bgRgb(78, 30, 36)}${rgb(255, 170, 170)}-  ${s.padEnd(64)}${R}`;
const diffAdd = (n: number, s: string) => `      ${GREY}${String(n).padStart(3)}${R} ${bgRgb(26, 64, 38)}${rgb(170, 240, 180)}+  ${s.padEnd(64)}${R}`;
const ctx = (n: number, s: string) => `      ${GREY}${String(n).padStart(3)}${R}    ${s}`;

const CHUNKS: Chunk[] = [
  (task) => [bullet(`I'll start on ${ITAL}${task.toLowerCase()}${R}. Reading the relevant files first.`), ""],
  () => [tool("Read", "src/db/migrate.ts"), out(`Read ${BOLD}142${R} lines`), ""],
  () => [tool("Search", 'pattern: "applied\\(", path: "src"'), out(`Found ${BOLD}3${R} files`), ""],
  () => [
    tool("Update", "src/db/migrate.ts"),
    out(`Updated ${BOLD}src/db/migrate.ts${R} with ${OK}2 additions${R} and ${E}31m1 removal${R}`),
    ctx(85, `${BLUE}for${R} (${BLUE}const${R} m ${BLUE}of${R} pending) {`),
    ctx(86, `  ${BLUE}const${R} tx = ${BLUE}await${R} db.begin();`),
    diffDel(87, "  await run(tx, m);"),
    diffAdd(87, "  if (await applied(tx, m.id)) continue;"),
    diffAdd(88, "  await run(tx, m);"),
    ctx(89, `  ${BLUE}await${R} tx.commit();`),
    "",
  ],
  () => [
    tool("Bash", "npm test -- migrate"),
    out(`${INV}${OK} PASS ${R} test/migrate.test.ts ${DIM}(6 tests)${R}`),
    out(`${DIM}Time: 2.31 s${R}`),
    "",
  ],
  () => [
    tool("Bash", "git diff --stat"),
    out(` src/db/migrate.ts | 3 ${OK}++${R}${E}31m-${R}`),
    out(` 1 file changed, 2 insertions(+), 1 deletion(-)`),
    "",
  ],
  () => [bullet("Tests pass. The runner now skips migrations that are already applied, so two suites sharing a DB no longer collide."), ""],
  () => [
    tool("Bash", "curl -s localhost:7771/v1/health | jq .hub.state"),
    out(`${E}32m"connected"${R}`),
    "",
  ],
  () => [
    `${E}38;5;214m⚠${R}  ${BOLD}Heads up:${R} token in the env file looks like ${INV}AGENTLINK_TOKEN=[redacted]${R}; leaving it out of the diff.`,
    "",
  ],
];

const SPIN = ["·", "✢", "✳", "✶", "✻", "✽"];
const WORDS = ["Flibbertigibbeting", "Cooking", "Gitifying", "Composing", "Improvising", "Noodling", "Percolating"];

interface Sim {
  lines: string[];
  idx: number;
  startedAt: number;
  tokens: number;
  word: string;
  cookedFor?: string;
  wasBusy: boolean;
}

/** One simulator per agent address. */
export function makeScreenSim(getSession: (address: string) => Session | undefined) {
  const sims = new Map<string, Sim>();

  const sim = (address: string): Sim => {
    let s = sims.get(address);
    if (!s) {
      const session = getSession(address);
      const prompt = `${GREY}>${R} ${session?.task || "Look at the open PR comments"}`;
      s = { lines: [prompt, ""], idx: Math.floor(Math.random() * 3), startedAt: Date.now() - Math.random() * 90_000, tokens: 200 + Math.floor(Math.random() * 900), word: WORDS[Math.floor(Math.random() * WORDS.length)], wasBusy: false };
      // a little history so panes aren't empty on first paint
      for (let i = 0; i < 4; i++) step(s, session);
      sims.set(address, s);
    }
    return s;
  };

  function step(s: Sim, session?: Session) {
    const chunk = CHUNKS[s.idx++ % CHUNKS.length](session?.task || "the task");
    s.lines.push(...chunk);
    s.tokens += 80 + Math.floor(Math.random() * 300);
    if (s.lines.length > SCREEN_MAX_LINES) s.lines.splice(0, s.lines.length - SCREEN_MAX_LINES);
  }

  return {
    /** Advances one agent by a tick (call ~1/s); returns its new screen. */
    tick(address: string): ScreenUpdate {
      const session = getSession(address);
      const s = sim(address);
      const busy = session?.status === "working";
      if (busy && !s.wasBusy) {
        s.startedAt = Date.now();
        s.cookedFor = undefined;
        s.lines.push(`${GREY}>${R} ${session?.task || "continue"}`, "");
      }
      if (!busy && s.wasBusy) {
        const secs = Math.round((Date.now() - s.startedAt) / 1000);
        s.cookedFor = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
        s.lines.push(`${CLAUDE}✻${R} ${DIM}Cooked for ${s.cookedFor}${R}`, "");
      }
      s.wasBusy = busy;
      if (busy && Math.random() < 0.45) step(s, session);
      return this.render(address);
    },
    render(address: string): ScreenUpdate {
      const session = getSession(address);
      const s = sim(address);
      const busy = session?.status === "working";
      const secs = Math.round((Date.now() - s.startedAt) / 1000);
      const rule = `${GREY}${"─".repeat(COLS - 2)}${R}`;
      const footer = busy
        ? [`${CLAUDE}${SPIN[secs % SPIN.length]} ${s.word}…${R} ${DIM}(${secs}s · ↓ ${s.tokens} tokens · esc to interrupt)${R}`, rule, `${GREY}❯${R} ${INV} ${R}`, rule, `  ${E}38;5;214m⏵⏵ auto mode on${R} ${DIM}(shift+tab to cycle)${R}`]
        : session?.status === "waiting"
          ? [`${E}38;5;214m?${R} ${BOLD}Allow Bash(npm publish)?${R} ${DIM}1. Yes  2. No, and tell Claude what to do differently${R}`, rule, `${GREY}❯${R} `, rule, `  ${DIM}waiting for your answer${R}`]
          : session?.status === "error"
            ? [`${E}31m✗ Error:${R} ${session.task || "command failed"}`, rule, `${GREY}❯${R} `, rule, `  ${DIM}? for shortcuts${R}`]
            : [rule, `${GREY}❯${R} `, rule, `  ${DIM}? for shortcuts${R}`];
      // like capture-pane -S -120: scrollback plus the visible screen, capped at SCREEN_MAX_LINES
      const body = s.lines.slice(-(SCREEN_MAX_LINES - footer.length));
      return { agent: address.split("/")[1], text: [...body, ...footer].join("\n"), cols: COLS, rows: ROWS, busy };
    },
  };
}
