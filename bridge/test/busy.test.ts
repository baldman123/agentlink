// Unit tests for busy detection (src/tmux.ts isBusy, src/team.ts statusOf) on real Claude Code screens.
// Run: npm test (from bridge/), or tsx test/busy.test.ts
import { statusOf, type SlotView } from "../src/team.ts";
import { isBusy } from "../src/tmux.ts";

let passes = 0;
let failures = 0;
function check(cond: unknown, name: string, detail?: unknown) {
  if (cond) {
    passes++;
    console.error(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail !== undefined ? `\n       ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
}

const RULE = "─".repeat(100);
/** A Claude Code pane: transcript, then the input box and its footer. */
const pane = (body: string, footer: string) => `${body}\n${RULE}\n❯ \n${RULE}\n  ${footer}\n\n\n`;
const slot = (screen: string, state = "done"): SlotView => ({
  slot: 1, pane: "%1", agent: "worker-1", kind: "worker", role: "worker", state, task: "t", screen,
});

console.error("busy detection");
const finished = pane("⏺ All tests pass.\n\n✻ Cooked for 3m 12s", "⏸ manual mode on · ← 2 agents");
check(!isBusy(finished), "a finished turn is not busy");
check(statusOf(slot(finished)) === "idle", "finished -> idle (the website shows done)");

const footerBusy = pane("✢ Tinkering… (3s · ↓ 199 tokens)", "⏸ manual mode on · esc to interrupt · ← 2 agents");
check(isBusy(footerBusy), "'esc to interrupt' in the footer -> busy");

// c4 and the website deliver prompts by pasting; Claude Code then shows a paste hint where
// "esc to interrupt" normally sits, for the whole turn. The spinner line is still there.
const pasted = pane("> [c4 task from the orchestrator]\n  fix it\n\n✢ Tinkering… (3s · ↓ 199 tokens · thought for 1s)", "paste again to expand");
check(isBusy(pasted), "busy while the footer shows the paste hint");
check(statusOf(slot(pasted, "done")) === "working", "done -> new pasted prompt -> working");

const notice = pane("✽ Crafting… (3m 56s · ↓ 13.0k tokens)\n                                   ✔ Update installed · Restart to update", "");
check(isBusy(notice), "busy with a notification instead of the footer");
const hooks = pane("· Zigzagging… (running PreToolUse hooks… 2/3 · 14m 10s · ↓ 18.1k tokens)", "");
check(isBusy(hooks), "busy while hooks run (spinner text before the time)");
const todos = pane("✶ Hashing… (41s · ↓ 2.3k tokens)\n  ⎿  ☐ write the test\n     ☐ fix it\n     ☐ run the suite", "paste again to expand");
check(isBusy(todos), "busy with a todo list under the spinner");

const toolOut = pane("⏺ Bash(npm test)\n  ⎿  grep -o 'x' | head -1 (1m 24s)\n     result… (truncated)\n\n✻ Brewed for 2m 1s", "? for shortcuts");
check(!isBusy(toolOut), "tool output with '… (' or a duration is not a spinner");
const old = pane("✢ Tinkering… (3s · ↓ 199 tokens)\n" + "⏺ line\n".repeat(60) + "✻ Cooked for 9s", "⏸ manual mode on");
check(!isBusy(old), "an old spinner line far up the transcript is not busy");

console.error(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
