#!/usr/bin/env node
// claude4 permission gate (a Claude Code PreToolUse hook).
//
// Every tool call by a claude4 Claude comes through here first and lands in one of three lanes:
//   allow        routine work: reading, searching, editing inside the project, tests and builds, c4
//   coordinator  everything else: the coordinator (the boss, or the orchestrator quarter) gets a
//                request in its pane and answers with c4 approve / deny / escalate
//   user         important actions: the owner answers Claude's own prompt in that pane. The
//                coordinator can't approve these.
// The coordinator's own calls skip its lane: routine and gray-area calls run, important ones go to
// The owner. With no coordinator yet, gray-area requests go to the owner as well.
// Autopilot (c4 autopilot on, the file <state>/autopilot): the owner handed every call to the boss. What would
// reach them goes to the coordinator instead, the coordinator's own calls run, and everything is logged on the
// board. One hard block stays: merging or pushing into main is refused outright and goes nowhere.
// Every request carries `summary` (a plain-English sentence for the owner) and `detail` (the raw command or file).
// Where the owner answers: in the browser view (the session has an "approvals-ui" marker) their calls
// wait in the YOUR CALLS tab on the boss circle; in Terminal they're Claude's own prompt in the pane.
// In the browser view nobody waits for them: the call is refused at once with "sent to the owner's calls as #ID"
// so the worker carries on with other work, and a detached watcher (this file run with --watch ID PANE)
// pastes their answer into the pane when it comes. An approval leaves a one-time grant (requests/ID.grant,
// a hash of the tool and its exact input); the same call retried takes the grant and runs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const SESSION = process.env.C4_SESSION || "";
const PANE = process.env.TMUX_PANE || "";
const STATE = path.join(HOME, ".claude4", SESSION);
const WAIT_MS = 9 * 60_000;
const WATCH_MS = 24 * 3600_000;      // how long a watcher waits for the owner's answer
const GRANT_MS = 24 * 3600_000;      // how long an approval stays usable
const WEB = fs.existsSync(path.join(STATE, "approvals-ui"));
const AUTOPILOT = fs.existsSync(path.join(STATE, "autopilot"));
const reqDir = path.join(STATE, "requests");
const tmux = (...args) => { try { return execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
const who = (s) => (s === 0 ? "the boss" : `quarter ${s}`);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
function event(kind, from, to, text) {
  try { fs.appendFileSync(path.join(STATE, "events.jsonl"), JSON.stringify({ t: Math.floor(Date.now() / 1000), kind, from, to, text: String(text).slice(0, 160) }) + "\n"); } catch {}
}
function board(line) {
  try { fs.appendFileSync(path.join(STATE, "board.md"), `- ${new Date().toTimeString().slice(0, 5)} ${line}\n`); } catch {}
}

// Text typed but not yet sent in a pane's input box (same rules as draft() in c4): the lines between the
// last two divider lines, without the ❯ prompt and an empty box's hints.
function draft(pane) {
  const lines = tmux("capture-pane", "-p", "-t", pane).split("\n");
  const div = lines.map((l, i) => (l.includes("──────") ? i : -1)).filter((i) => i >= 0);
  if (div.length < 2) return "";
  const [a, b] = div.slice(-2);
  return lines.slice(a + 1, b).map((l, i) => {
    let s = l.replace(/^\s*❯?\s*/, "");
    if (i === 0) s = s.replace(/^Try ".*"$/, "");
    return s.replace(/^Press up to edit queued messages$/, "");
  }).filter(Boolean).join("\n");
}
// Paste text into a pane's Claude as one message and send it, like c4's send(): wait while the pane shows a
// yes/no prompt (the Enter would answer it) and while someone is typing in its input box (up to 5 minutes).
const DIALOG = /Do you want to proceed\?|Enter to confirm|Esc to cancel/;
function paste(pane, text) {
  // Only the bottom of the screen counts: a tall pane still shows old, answered prompts higher up.
  const bottom = () => tmux("capture-pane", "-p", "-t", pane).split("\n").filter((l) => l.trim()).slice(-12).join("\n");
  for (let i = 0; i < 600 && DIALOG.test(bottom()); i++) execFileSync("sleep", ["1"]);
  for (let i = 0; i < 300 && draft(pane); i++) execFileSync("sleep", ["1"]);
  tmux("set-buffer", "-b", "c4perm", "--", text);
  tmux("paste-buffer", "-p", "-d", "-b", "c4perm", "-t", pane);
  execFileSync("sleep", ["0.4"]);
  tmux("send-keys", "-t", pane, "Enter");
}

// The owner's calls from one slot still waiting for their answer.
function openCalls(s) {
  let files = [];
  try { files = fs.readdirSync(reqDir).filter((f) => f.endsWith(".json")); } catch {}
  return files.map((f) => readJson(path.join(reqDir, f)))
    .filter((r) => r && r.needsBryant && r.slot === s && !fs.existsSync(path.join(reqDir, `${r.id}.bryant`)));
}
// Header: "needs your call" while any of the pane's calls is open, without the pane being stuck.
function markCalls(pane, s) {
  const open = openCalls(s);
  tmux("set", "-p", "-t", pane, "@calls", open.map((r) => `#${r.id}`).join(" "));
  if (open.length) tmux("set", "-p", "-t", pane, "@state", "needs-you");
  else {
    tmux("set", "-pu", "-t", pane, "@calls");
    if (tmux("show", "-pqv", "-t", pane, "@state") === "needs-you") tmux("set", "-pu", "-t", pane, "@state");
  }
}

// ── watcher: node permission.mjs --watch ID PANE (spawned detached by bryantDecides) ──
if (process.argv[2] === "--watch") {
  const [, , , id, pane] = process.argv;
  const file = path.join(reqDir, `${id}.json`), answer = path.join(reqDir, `${id}.bryant`);
  const end = Date.now() + WATCH_MS;
  const alive = () => tmux("display", "-p", "-t", pane, "#{pane_id}") === pane;
  while (Date.now() < end && !fs.existsSync(answer)) {
    await new Promise((r) => setTimeout(r, 2000));
    if (!alive()) process.exit(0);            // the worker's pane is gone; nobody to tell
  }
  const r = readJson(file) || {};
  const s = Number(r.slot);
  const what = r.summary || r.what || "your request";
  const call = r.tool === "Bash" ? "command" : "call";
  let text;
  if (!fs.existsSync(answer)) {
    try { fs.writeFileSync(answer, "expired\nno answer within 24 hours"); } catch {}
    board(`**✗ #${id} expired** for ${who(s)}: the owner didn't answer in 24 hours`);
    text = `[c4 answer from the owner on #${id}]\nNo answer in 24 hours, so #${id} expired: ${what}\nIf you still need it, run the ${call} again to send them a fresh request.`;
  } else {
    const [verdict, ...rest] = fs.readFileSync(answer, "utf8").trim().split("\n");
    const note = rest.join(" ").trim();
    if (verdict === "approve" && r.hash) {
      fs.writeFileSync(path.join(reqDir, `${id}.grant`), JSON.stringify({ id, slot: s, hash: r.hash, t: Date.now() }));
      text = `[c4 answer from the owner on #${id}]\nApproved: ${what}${note ? `\nHis note: ${note}` : ""}\nRun the exact same ${call} again and it will go through (once):\n${r.command || r.what || ""}`;
    } else {
      text = `[c4 answer from the owner on #${id}]\nDenied: ${what}${note ? `\nHis note: ${note}` : ""}\nDon't retry it; take another route, or c4 ask the orchestrator if you're stuck.`;
    }
  }
  if (!alive()) process.exit(0);
  markCalls(pane, s);
  paste(pane, text);
  process.exit(0);
}

const say = (decision, reason) => {
  if (decision) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason },
    }));
  }
  process.exit(0);
};

let input;
try { input = JSON.parse(fs.readFileSync(0, "utf8")); } catch { say(); }
if (!SESSION || !PANE) say();

// Which slot this pane is, and who coordinates.
const registry = (() => {
  try {
    return fs.readFileSync(path.join(STATE, "panes"), "utf8").split("\n").filter(Boolean).map((l) => l.trim().split(/\s+/));
  } catch { return []; }
})();
const mine = registry.find(([, pane]) => pane === PANE);
if (!mine) say();                                   // not a claude4 pane: leave it alone
const slot = Number(mine[0]);
const roleOf = (pane) => tmux("show", "-pqv", "-t", pane, "@role");
const coordinator = registry.find(([, pane]) => roleOf(pane) === "orchestrator");
const iAmCoordinator = coordinator && coordinator[1] === PANE;

const tool = input.tool_name || "";
const args = input.tool_input || {};
const cwd = input.cwd || process.cwd();

// ── classify ─────────────────────────────────────────────────────────────
const SECRET = /(^|\/)(\.env[^/]*|\.ssh\/|id_[a-z0-9]+|[^/]*credentials[^/]*|[^/]*\.pem|[^/]*\.p12|\.netrc|\.npmrc|\.pgpass|token)$/i;
const CRITICAL_BASH = [
  [/\bgit\s+(push|merge|rebase|reset\s+--hard|clean\s+-\w*f|branch\s+-D|filter-branch|update-ref)\b/, "changes git history or pushes"],
  [/\bgit\s+(checkout|restore)\s+(--\s|\.|-f)/, "throws away uncommitted work"],
  [/\brm\s+(-\w*r\w*f|-\w*f\w*r|-r\s+-f|-f\s+-r|--recursive)/, "deletes files recursively"],
  [/\bsudo\b|\bsu\s/, "runs as an administrator"],
  [/\b(brew|port)\s+(install|uninstall|upgrade|remove)\b|\bnpm\s+(i|install|uninstall)\s+(-g|--global)\b|\bpip3?\s+install\b(?!.*--user)/, "installs or removes software"],
  [/\b(npm|pnpm|yarn)\s+publish\b|\bgh\s+(pr\s+merge|release|repo\s+(delete|create))\b/, "publishes or merges on GitHub/npm"],
  [/\bvercel\b.*\b(deploy|--prod|promote|rollback|rm|remove)\b|\bnetlify\b.*\bdeploy\b|\bfly\s+deploy\b/, "deploys"],
  [/\bsupabase\s+(db\s+(push|reset)|migration\s+up)\b|\bpsql\b.*\b(drop|delete|update|insert|alter|truncate)\b/i, "changes a live database"],
  [/\bcurl\b[^|]*\s-X\s*(POST|PUT|PATCH|DELETE)\b|\bcurl\b[^|]*\s(-d|--data)\b/i, "sends data to a server"],
  [/\b(launchctl|crontab|killall|shutdown|reboot|diskutil|mkfs|dd\s+if=)\b|\bchmod\s+-R\b|\bchown\b/, "changes the system"],
  [/\bsecurity\s+(find|delete|add)-|\bosascript\b/, "touches the keychain or controls other apps"],
  [/(^|[\s"'])~?\/?(\S*\/)?\.claude\/(settings[^ ]*\.json|CLAUDE\.md)|\.claude\.json\b/, "edits Claude's own settings"],
];
const READ_ONLY_BASH = /^(cd|ls|ll|cat|head|tail|less|wc|grep|rg|ag|find|fd|tree|pwd|echo|printf|which|whereis|type|file|stat|du|df|date|env|printenv|uname|whoami|hostname|sort|uniq|cut|tr|diff|cmp|jq|basename|dirname|realpath|readlink|sed\s+-n|awk|true|false|test|\[)\b/;
const ROUTINE_BASH = [
  /^c4\s/,
  /^git\s+(status|diff|log|show|branch(?!\s+-[dD])|remote\s+-v|rev-parse|ls-files|blame|stash\s+list|fetch|add|commit|switch\s+-c|checkout\s+-b|worktree\s+list)\b/,
  /^(npm|pnpm|yarn|bun)\s+(test|t|run\s+(test|lint|typecheck|build|check|format:check)\b|ci\b|ls\b|outdated\b|view\b)/,
  /^npx\s+(tsc|vitest|jest|eslint|prettier|playwright\s+test)\b/,
  /^(pytest|python3?\s+-m\s+(pytest|unittest)|cargo\s+(test|build|check|clippy)|go\s+(test|build|vet)|swift\s+(build|test)|make\s+(test|check|build)?$|tsc\b|node\s+--check\b|node\s+-e\b)/,
  /^(\.\/)?node_modules\/\.bin\//,
];

function bashLane(cmd) {
  const c = String(cmd || "").trim();
  // A lone c4 call is team talk; its message text can mention anything ("…run rm -rf…").
  // Judge it with the quoted text taken out, so nothing can be chained after it.
  const bare = c.replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
  if (/\bc4\s+(decide|answer|autopilot\s+(on|off))\b/.test(bare) || /\.claude4\/[^\s'"]*\/(requests|questions|autopilot)\b|approvals-ui/.test(c)) return ["owner", "answers something only the owner can"];
  if (/^c4\s/.test(bare) && !/[;&|`<>]|\$\(|\n/.test(bare)) return ["allow", "team talk"];
  for (const [re, why] of CRITICAL_BASH) if (re.test(c)) return ["user", why];
  if (/(^|[\s<>|;&])(\S*\/)?\.env[\w.-]*\b/.test(c) && /\b(cat|less|head|tail|grep|source|\.|cp|scp|curl)\b/.test(c)) return ["user", "reads a secrets file"];
  const parts = c.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);
  const hasWrite = /(^|[^<>&2])>{1,2}\s*(?!\/dev\/null)/.test(c) || /`|\$\(/.test(c);
  if (!hasWrite && parts.every((p) => READ_ONLY_BASH.test(p) && !/\s-(delete|exec)\b/.test(p) && !/\bsed\s+-i\b/.test(p))) return ["allow", "read-only command"];
  if (!hasWrite && parts.length && parts.every((p) => ROUTINE_BASH.some((re) => re.test(p)) || READ_ONLY_BASH.test(p))) return ["allow", "routine dev command"];
  return ["coordinator", "runs a command"];
}

const inside = (p, root) => { const r = path.resolve(root), f = path.resolve(cwd, p); return f === r || f.startsWith(r + path.sep); };
const TMP = [os.tmpdir(), "/tmp", "/private/tmp", path.join(HOME, ".claude4"), path.join(HOME, ".claude", "projects")];   // last: Claude's own memory notes

function pathLane(p, writing) {
  const f = path.resolve(cwd, String(p || ""));
  if (SECRET.test(f)) return ["user", writing ? "writes a secrets file" : "reads a secrets file"];
  if (writing && /\/\.claude4\/[^/]+\/(requests|questions)\/|\/(approvals-ui|autopilot)$/.test(f)) return ["owner", "writes to the approval queue"];
  if (/\/\.claude\/(settings[^/]*\.json|CLAUDE\.md)$|\/\.claude\.json$|\/\.(zshrc|zshenv|zprofile|bashrc|bash_profile)$/.test(f)) return ["user", "changes shell or Claude settings"];
  if (!writing) return ["allow", "reads a file"];
  if (inside(f, cwd) || TMP.some((t) => inside(f, t))) return ["allow", "edits inside the project"];
  return ["coordinator", `writes outside the project (${f})`];
}

function lane() {
  if (tool === "Bash") return bashLane(args.command);
  if (["Read", "NotebookRead"].includes(tool)) return pathLane(args.file_path || args.notebook_path, false);
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) return pathLane(args.file_path || args.notebook_path, true);
  if (["Glob", "Grep", "LS", "WebSearch", "WebFetch", "TodoWrite", "Task", "Agent", "ToolSearch", "Skill", "ExitPlanMode", "AskUserQuestion", "BashOutput", "KillShell", "Monitor"].includes(tool)) return ["allow", "routine tool"];
  if (tool.startsWith("mcp__")) {
    const name = tool.split("__").slice(2).join("__").toLowerCase();
    if (/(send|delete|trash|remove|merge|deploy|publish|execute_sql|apply_migration|buy|purchase|share|forward|reply|transfer|revoke|rotate|create_api_key|cancel|pay)/.test(name)) return ["user", `uses ${tool}`];
    if (/^(list|get|search|read|query|find|fetch|count|aggregate|describe|show|check|browser_(snapshot|take_screenshot|console|network)|tabs_context)/.test(name)) return ["allow", "reads through a connector"];
    return ["coordinator", `uses ${tool}`];
  }
  return ["coordinator", `uses ${tool}`];
}

function describe() {
  if (tool === "Bash") return `Bash: ${String(args.command || "").replace(/\s+/g, " ").slice(0, 300)}`;
  const p = args.file_path || args.notebook_path || args.path;
  if (p) return `${tool}: ${p}`;
  return `${tool}: ${JSON.stringify(args).slice(0, 300)}`;
}

// ── plain English for the owner ─────────────────────────────────────────────
// One sentence a non-programmer can follow: what will happen, to what, and why it matters. Rules, no model call.
const tilde = (p) => String(p || "").replace(HOME, "~");
const folder = (d) => path.basename(d || cwd) || d;
const clip = (t, n = 70) => { t = String(t).replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const hostOf = (c) => { const m = c.match(/https?:\/\/([^\/\s'"?:]+)/); return m ? m[1] : null; };
const git = (...a) => { try { return execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
const branchNow = () => git("branch", "--show-current");
const MAIN = /^(main|master)$/;

function bashSummary(c) {
  const where = `in ${folder(cwd)}`;
  let m;
  if ((m = c.match(/\bvercel\b[^|;&]*/)) && /\b(deploy|--prod|promote|rollback|rm|remove)\b/.test(m[0])) {
    if (/\b(rm|remove)\b/.test(m[0])) return `Delete a Vercel deployment or project from ${folder(cwd)}: the site it served goes away.`;
    if (/\b(promote|rollback)\b/.test(m[0])) return `Switch which version of the ${folder(cwd)} website is live on Vercel: visitors see the change right away.`;
    return /--prod\b/.test(m[0])
      ? `Deploy the ${folder(cwd)} website to Vercel (production): visitors see this version right away.`
      : `Deploy a preview of the ${folder(cwd)} website to Vercel: it gets a public link, the live site is unchanged.`;
  }
  if (/\b(netlify|fly)\b.*\bdeploy\b/.test(c)) return `Deploy ${folder(cwd)} to ${/netlify/.test(c) ? "Netlify" : "Fly.io"}: visitors see this version right away.`;
  if ((m = c.match(/\bgh\s+pr\s+merge\s*(\d+)?/))) return `Merge pull request ${m[1] ? `#${m[1]} ` : ""}on GitHub: the code lands in the shared branch for everyone.`;
  if (/\bgh\s+release\b/.test(c)) return `Publish a GitHub release for ${folder(cwd)}: it becomes public on GitHub.`;
  if ((m = c.match(/\bgh\s+repo\s+(delete|create)\b/))) return m[1] === "delete" ? "Delete a GitHub repository: its code and history are gone for good." : "Create a new GitHub repository.";
  if (/\b(npm|pnpm|yarn)\s+publish\b/.test(c)) return `Publish the ${folder(cwd)} package to npm: anyone can download it, and a version can't be reused.`;
  if ((m = c.match(/\bgit\s+push\b([^|;&]*)/))) {
    const args = m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith("-"));
    const target = args[1] ? args[1].split(":").pop() : branchNow() || "the current branch";
    return `Upload the ${folder(cwd)} commits on ${target} to GitHub${/\s(-f|--force)/.test(m[1]) ? " and overwrite what's there (force push)" : ""}: the code leaves this Mac.`;
  }
  if ((m = c.match(/\bgit\s+merge\s+(?:-\S+\s+)*(\S+)/))) return `Merge the git branch ${m[1]} into ${branchNow() || "the current branch"} ${where}.`;
  if (/\bgit\s+rebase\b/.test(c)) return `Rewrite the git history of ${branchNow() || "the current branch"} ${where} (rebase).`;
  if (/\bgit\s+reset\s+--hard\b|\bgit\s+(checkout|restore)\s+(--\s|\.|-f)|\bgit\s+clean\b/.test(c)) return `Throw away unsaved code changes ${where}: they can't be recovered.`;
  if ((m = c.match(/\bgit\s+branch\s+-D\s+(\S+)/))) return `Delete the git branch ${m[1]} ${where}, including work only on it.`;
  if (/\bgit\s+(filter-branch|update-ref)\b/.test(c)) return `Rewrite git history ${where}: hard to undo.`;
  if ((m = c.match(/\brm\s+(?:-\S+\s+)+([^|;&]+)/))) return `Permanently delete ${clip(m[1].split(/\s+/).map(tilde).join(", "), 60)} (folders and everything in them): it can't be undone.`;
  if ((m = c.match(/\bsudo\s+([^|;&]+)/))) return `Run "${clip(m[1], 50)}" as the Mac's administrator: it can change anything on the system.`;
  if ((m = c.match(/\b(brew|port)\s+(install|uninstall|upgrade|remove)\s+([^|;&]*)/))) return `${m[2] === "install" ? "Install" : m[2] === "upgrade" ? "Upgrade" : "Remove"} ${clip(m[3] || "software", 40)} on this Mac with ${m[1] === "brew" ? "Homebrew" : "MacPorts"}.`;
  if ((m = c.match(/\bnpm\s+(i|install|uninstall)\s+(?:-g|--global)\s+([^|;&]*)/))) return `${m[1] === "uninstall" ? "Remove" : "Install"} ${clip(m[2] || "a program", 40)} for every project on this Mac (npm global).`;
  if ((m = c.match(/\bpip3?\s+install\s+([^|;&]*)/))) return `Install the Python package ${clip(m[1], 40)} for the whole Mac.`;
  if (/\bsupabase\s+(db\s+(push|reset)|migration\s+up)\b/.test(c)) return `Change the structure of the live Supabase database${/reset/.test(c) ? " and wipe its data" : ""}: real data is affected.`;
  if (/\bpsql\b/i.test(c)) return `Change data in a live database with psql: real records are affected.`;
  if (/\bcurl\b/.test(c)) {
    const method = (c.match(/\s-X\s*([A-Z]+)/) || [])[1] || "POST";
    const verb = { DELETE: "Delete something on", PATCH: "Change something on", PUT: "Replace something on" }[method] || "Send data to";
    const host = hostOf(c);
    if (host && /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|[\w-]+\.local)$/i.test(host)) {
      const port = (c.match(/https?:\/\/[^\/\s'"?]+:(\d+)/) || [])[1];
      return `${verb} a local server on this Mac (${host}${port ? `:${port}` : ""}, ${method} request): nothing leaves this machine, but it can change what that local app stores.`;
    }
    return `${verb} ${host || "a web server"} (${method} request): it changes something outside this Mac.`;
  }
  if ((m = c.match(/\b(launchctl|crontab|killall|shutdown|reboot|diskutil|mkfs|chown|chmod\s+-R)\b/))) return `Change system settings on this Mac (${m[1]}): it affects more than this project.`;
  if (/\bsecurity\s+(find|delete|add)-/.test(c)) return "Read or change saved passwords in the Mac keychain.";
  if (/\bosascript\b/.test(c)) return "Control other apps on this Mac with AppleScript.";
  if ((m = c.match(/(\S*\.env[\w.-]*)/)) && /\b(cat|less|head|tail|grep|source|cp|scp|curl)\b/.test(c)) return `Read the secrets file ${tilde(m[1])}: it holds passwords or API keys.`;
  if (/\.claude\/(settings|CLAUDE)|\.claude\.json/.test(c)) return "Change Claude's own settings on this Mac.";
  if (/\bc4\s+(decide|answer|autopilot)\b/.test(c)) return "Answer an approval meant for the owner, or switch autopilot, from inside the team.";
  if ((m = c.match(/^\s*(?:cd\s+\S+\s*&&\s*)?(?:python3?|node|bash|sh|zsh|ruby|deno|bun|tsx|npx\s+tsx)\s+(?:-\S+\s+)*([^\s|;&]+\.(?:py|m?js|ts|sh|rb))\b(.*)/)))
    return `Run the script ${m[1]} ${where}${m[2].trim() ? ` (with ${clip(m[2], 40)})` : ""}: it does whatever that script does, so check it if you're unsure.`;
  const prog = path.basename((c.match(/^\s*(?:cd\s+\S+\s*&&\s*)?(?:\w+=\S*\s+)*(\S+)/) || [])[1] || "a command");
  const purpose = TOOL_PURPOSE[prog.replace(/\d+(\.\d+)*$/, "")];
  return `Run ${prog}${purpose ? ` (${purpose})` : ""} ${where}: "${clip(c, 200)}".`;
}
// What common programs are for, for the catch-all sentence.
const TOOL_PURPOSE = {
  npm: "the JavaScript package manager: installs libraries and runs the project's scripts", pnpm: "a JavaScript package manager: installs libraries and runs the project's scripts",
  yarn: "a JavaScript package manager: installs libraries and runs the project's scripts", bun: "a JavaScript runtime and package manager",
  npx: "runs a JavaScript tool from npm, downloading it first if needed", node: "runs JavaScript code", deno: "runs JavaScript/TypeScript code", tsx: "runs TypeScript code",
  python: "runs Python code", pip: "installs Python packages", uv: "a Python package and project manager", ruby: "runs Ruby code",
  git: "version control: records and shares code changes", gh: "GitHub's command-line tool", tmux: "the terminal window manager claude4 runs in",
  curl: "fetches or sends data over the web", wget: "downloads files from the web", ssh: "logs into another computer", scp: "copies files to or from another computer",
  rsync: "copies or syncs folders", docker: "runs apps in containers", make: "runs the project's build steps", cargo: "builds and runs Rust code", go: "builds and runs Go code",
  swift: "builds and runs Swift code", xcodebuild: "builds Apple apps", open: "opens a file, folder or link in its Mac app", kill: "stops a running program", pkill: "stops running programs by name",
  mv: "moves or renames files", cp: "copies files", mkdir: "creates folders", ln: "creates a shortcut (link) to a file", touch: "creates an empty file or updates its date",
  sqlite3: "reads or changes a local SQLite database", supabase: "manages a Supabase database project", vercel: "manages Vercel website hosting", lsof: "lists programs using files or network ports",
  claude: "starts Claude Code", c4: "claude4's team messaging", jq: "reads and reshapes JSON data", sed: "edits text", perl: "runs Perl code", zsh: "runs a shell script", bash: "runs a shell script", sh: "runs a shell script",
};

function summarize() {
  if (tool === "Bash") return bashSummary(String(args.command || "").replace(/\s+/g, " ").trim());
  const p = args.file_path || args.notebook_path || args.path;
  if (p) {
    const f = path.resolve(cwd, String(p)), writing = ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool);
    if (SECRET.test(f)) return `${writing ? "Change" : "Read"} the secrets file ${tilde(f)}: it holds passwords or API keys.`;
    if (/\/\.(zshrc|zshenv|zprofile|bashrc|bash_profile)$/.test(f)) return `Change the shell startup file ${tilde(f)}: it affects every terminal on this Mac.`;
    if (/\/\.claude\//.test(f) || /\.claude\.json$/.test(f)) return `Change Claude's own settings (${tilde(f)}).`;
    return writing ? `Change the file ${tilde(f)}, outside the ${folder(cwd)} project.` : `Read the file ${tilde(f)}.`;
  }
  if (tool.startsWith("mcp__")) {
    const [, server = "", ...rest] = tool.split("__");
    const app = server.replace(/^claude_ai_/, "").replace(/_/g, " ");
    const action = rest.join(" ").replace(/[_-]+/g, " ").trim();
    const target = args.to || args.recipient || args.url || args.project_id || args.name || "";
    return `Use ${app} to ${action}${target ? ` (${clip(Array.isArray(target) ? target.join(", ") : target, 50)})` : ""}.`;
  }
  return `Use the ${tool} tool.`;
}

// ── what a call card shows ───────────────────────────────────────────────
// The exact call, uncut up to 2000 characters: the command, the file, or a connector's input.
function fullCall() {
  if (tool === "Bash") return String(args.command || "").trim().slice(0, 2000);
  const p = args.file_path || args.notebook_path || args.path;
  return (p ? String(p) : JSON.stringify(args, null, 1)).slice(0, 2000);
}
// Who asks and what it's working on: the pane's task line (c4 status shows the same), and the folder.
function asker() {
  const task = tmux("show", "-pqv", "-t", PANE, "@task");
  return { name: who(slot), task, folder: tilde(cwd) };
}
// Card text: the rules sentence (or the boss's note), then who needs it for what, where. Max 400 for the website.
function cardSummary(first) {
  const a = asker();
  const capName = a.name[0].toUpperCase() + a.name.slice(1);
  const tail = a.task ? ` ${capName} needs it for its task "${clip(a.task, 90)}" (folder ${a.folder}).` : ` ${capName} needs it for its work in ${a.folder}.`;
  return `${clip(first, 400 - tail.length)}${tail}`;
}
function cardDetail(why) {
  const a = asker();
  const label = tool === "Bash" ? "Exact command" : args.file_path || args.notebook_path || args.path ? `${tool} on the file` : `${tool} with`;
  return [`What happens: ${summarize()}`, `Asked by: ${a.name}${a.task ? `, working on "${a.task}"` : ""}`, `Folder: ${a.folder}`,
    `Why it came to you: ${why}.`, "", `${label}:`, fullCall()].join("\n");
}

// The owner's standing rule, no exceptions: nothing merges into main or pushes to main. Checked in autopilot,
// where there's nobody else to stop it.
function mainBranchMove() {
  if (tool.startsWith("mcp__")) return /merge_pull_request|merge_pr\b/i.test(tool) ? "merges a pull request" : null;
  if (tool !== "Bash") return null;
  const c = String(args.command || "");
  if (/\bgh\s+pr\s+merge\b/.test(c)) return "merges a pull request";
  if (/\bgh\s+api\b[^|;&]*\/(merges|pulls\/\d+\/merge)\b/.test(c)) return "merges through the GitHub API";
  const parts = c.split(/\s*(?:&&|\|\||;|\||\n)\s*/);
  let onMain = MAIN.test(branchNow());
  for (const p of parts) {
    const sw = p.match(/\bgit\s+(?:checkout|switch)\s+(?:-\S+\s+)*(\S+)\s*$/);
    if (sw) { onMain = MAIN.test(sw[1]); continue; }
    const push = p.match(/\bgit\s+push\b(.*)/);
    if (push) {
      const a = push[1].trim().split(/\s+/).filter(Boolean);
      if (a.some((x) => x === "--all" || x === "--mirror")) return "pushes every branch, main included";
      const refs = a.filter((x) => !x.startsWith("-")).slice(1);
      if (refs.some((r) => MAIN.test(r.replace(/^\+/, "").split(":").pop().replace(/^refs\/heads\//, "")))) return "pushes to main";
      if (!refs.length && onMain) return "pushes to main (main is checked out)";
    }
    if (/\bgit\s+(merge|rebase|cherry-pick|am)\b/.test(p) && onMain && !/--abort\b/.test(p)) return "changes main directly";
    if (/\bgit\s+update-ref\s+refs\/heads\/(main|master)\b/.test(p)) return "rewrites main";
  }
  return null;
}

// ── helpers ──────────────────────────────────────────────────────────────
// The exact call, for one-time grants: tool name plus its input with keys sorted. Fields that don't change
// what the call does are left out: Claude rewrites a Bash call's description on every retry.
const COSMETIC = new Set(["description", "timeout", "run_in_background"]);
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`
  : JSON.stringify(v));
const HASH = crypto.createHash("sha256")
  .update(`${tool}\n${canon(Object.fromEntries(Object.entries(args).filter(([k]) => !COSMETIC.has(k))))}`).digest("hex");

// The owner approved this exact call earlier: use up its grant. Rename first, so two hooks can't both take it.
function takeGrant() {
  let files = [];
  try { files = fs.readdirSync(reqDir).filter((f) => f.endsWith(".grant")); } catch {}
  for (const f of files) {
    const p = path.join(reqDir, f), g = readJson(p);
    if (!g || g.hash !== HASH || g.slot !== slot) continue;
    try { fs.renameSync(p, `${p.slice(0, -6)}.used`); } catch { continue; }
    if (Date.now() - g.t <= GRANT_MS) return g.id;
  }
  return null;
}
function askBryant(why) {
  const what = describe(), summary = summarize();
  event("needs-you", slot, slot, summary);
  board(`**⚠ ${who(slot)} needs the owner** ${summary} (${why}) \`${what}\``);
  tmux("set", "-p", "-t", PANE, "@state", "needs-you");
  tmux("display", "-d", "8000", "-t", SESSION, `⚠ ${who(slot)} needs your approval: ${summary.slice(0, 80)}`);
  try {
    execFileSync("osascript", ["-e",
      `display notification ${JSON.stringify(summary.slice(0, 180))} with title ${JSON.stringify(`claude4: ${who(slot)} needs your approval`)} sound name "Glass"`]);
  } catch {}
  say("ask", `claude4: ${summary} This ${why}, so the owner decides.`);
}

// A call going through means any earlier wait for the boss is over. "Needs your call" stays while one of
// this pane's calls is still in the owner's inbox.
function clearWait() {
  const st = tmux("show", "-pqv", "-t", PANE, "@state");
  if (st === "waiting") tmux("set", "-pu", "-t", PANE, "@state");
  if (st === "needs-you") markCalls(PANE, slot);
}

// Put the worker's header back the way it was before it started waiting.
function restoreState(before) {
  if (before && before !== "needs-you" && before !== "waiting") tmux("set", "-p", "-t", PANE, "@state", before);
  else tmux("set", "-pu", "-t", PANE, "@state");
}
function newRequest(laneName, why, needsBryant, extra = {}) {
  fs.mkdirSync(reqDir, { recursive: true });
  const id = `${slot}${Date.now().toString(36).slice(-4)}`;
  const what = describe();
  fs.writeFileSync(path.join(reqDir, `${id}.json`), JSON.stringify({ id, slot, tool, summary: cardSummary(summarize()), detail: cardDetail(why), what, command: fullCall(), why, task: asker().task, lane: laneName, needsBryant, cwd, hash: HASH, t: Date.now(), ...extra }));
  return id;
}
const watcherAlive = (r) => { try { return !!r.watcher && process.kill(r.watcher, 0); } catch { return false; } };
// A detached `node permission.mjs --watch ID PANE` that outlives this hook and pastes the owner's answer.
function startWatcher(id) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--watch", id, PANE], {
    detached: true, stdio: "ignore", env: { ...process.env, C4_SESSION: SESSION, TMUX_PANE: PANE },
  });
  child.unref();
  const file = path.join(reqDir, `${id}.json`), r = readJson(file);
  if (r) { r.watcher = child.pid; try { fs.writeFileSync(file, JSON.stringify(r)); } catch {} }
}
const dontWait = (id) => `Don't wait: carry on with any other part of your task that doesn't need this. When they answer, it arrives in your input as "[c4 answer from the owner on #${id}]"; if he approved, run the exact same ${tool === "Bash" ? "command" : "call"} again and it will go through. Only if nothing else is left, c4 blocked "waiting on the owner's #${id}".`;
// Browser view: put it in the owner's inbox on the boss circle and refuse the call for now, so the worker
// isn't stuck while they decide. A watcher delivers their answer.
// `note`: the boss's plain-English line when it escalates; it replaces the rules-built summary.
function bryantDecides(id, why, note = "") {
  const file = path.join(reqDir, `${id}.json`);
  let summary = summarize();
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    r.needsBryant = true; r.why = why; r.hash = HASH; r.detail = cardDetail(why);
    if (note.trim()) r.summary = cardSummary(note.trim());
    summary = r.summary || summary;
    fs.writeFileSync(file, JSON.stringify(r));
  } catch {}
  const what = summary;
  event("needs-you", slot, slot, what);
  board(`**⚠ ${who(slot)} needs the owner** #${id} ${what} (${why})`);
  try {
    execFileSync("osascript", ["-e",
      `display notification ${JSON.stringify(what.slice(0, 180))} with title ${JSON.stringify(`claude4: ${who(slot)} needs your call`)} subtitle "Answer it on the boss circle" sound name "Glass"`]);
  } catch {}
  startWatcher(id);
  markCalls(PANE, slot);
  say("deny", `claude4: sent to the owner's calls as #${id} (${what}). ${dontWait(id)}`);
}
function toBryant(why) {
  if (!WEB) askBryant(why);
  // The same call is already in their inbox: don't file it twice. Restart its watcher if that died.
  const same = openCalls(slot).find((r) => r.hash === HASH);
  if (same) {
    if (!watcherAlive(same)) startWatcher(same.id);
    markCalls(PANE, slot);
    say("deny", `claude4: this is already in the owner's calls as #${same.id}, still unanswered. ${dontWait(same.id)}`);
  }
  bryantDecides(newRequest("user", why, true), why);
}

// ── decide ───────────────────────────────────────────────────────────────
const [laneName, why] = lane();
if (process.env.C4_CLASSIFY) { process.stdout.write(`${laneName}\t${why}`); process.exit(0); }   // for tests
if (process.env.C4_SUMMARY) { process.stdout.write(`${summarize()}\t${AUTOPILOT ? mainBranchMove() || "" : ""}`); process.exit(0); }   // for tests
if (process.env.C4_CARD) { process.stdout.write(JSON.stringify({ summary: cardSummary(summarize()), detail: cardDetail(why) }, null, 1)); process.exit(0); }   // for tests
if (laneName === "allow") { clearWait(); say("allow", `claude4: ${why}`); }
// The owner approved this exact call (the main-branch block still wins in autopilot).
const granted = !(AUTOPILOT && mainBranchMove()) && takeGrant();
if (granted) {
  board(`**✓ #${granted} ran** for ${who(slot)}: the owner's approval used`);
  clearWait();
  say("allow", `claude4: approved by the owner (#${granted})`);
}
if (AUTOPILOT) {
  const block = mainBranchMove();
  if (block) {
    board(`**⛔ autopilot blocked** ${who(slot)}: ${summarize()} (${block}; never allowed) \`${describe()}\``);
    event("deny", 0, slot, `blocked: ${block}`);
    say("deny", `claude4: this ${block}. The owner's standing rule is that nothing merges or pushes into main, autopilot or not. Push a feature branch and open a pull request instead; he merges.`);
  }
  if (laneName === "owner") {
    board(`**⛔ autopilot blocked** ${who(slot)}: ${summarize()} (only the owner can do this)`);
    say("deny", "claude4: only the owner can do this; autopilot doesn't change that.");
  }
}
if (laneName === "owner" || (laneName === "user" && !AUTOPILOT)) toBryant(why);
if (iAmCoordinator) {
  if (laneName === "user") board(`**🤖 autopilot: the boss ran** ${summarize()} (${why}) \`${describe()}\``);
  say("allow", `claude4: the coordinator's own call (${why}${laneName === "user" ? "; autopilot" : ""})`);
}
if (!coordinator) toBryant(`${why}, and there's no boss yet`);

// Gray area, or (autopilot) something that would have gone to the owner: ask the coordinator and wait.
const handed = laneName === "user";   // only reached in autopilot
const id = newRequest("coordinator", why, false, handed ? { autopilot: true } : {});
const what = describe(), summary = summarize();
event("perm", slot, Number(coordinator[0]), summary);
board(`**? ${who(slot)} asks${handed ? " (autopilot: the owner's call, handed to the boss)" : ""}** #${id} ${summary} \`${what}\``);
const beforeWait = tmux("show", "-pqv", "-t", PANE, "@state");
tmux("set", "-p", "-t", PANE, "@state", "waiting");
paste(coordinator[1], `[c4 permission request #${id} from ${who(slot)}]
${summary}
Command: ${fullCall()}
(${why}; working in ${cwd})${handed ? `
AUTOPILOT: this would normally go to the owner. They handed these calls to you, so decide it yourself, carefully: it's logged on the board for them to review.` : ""}
Answer with one of: c4 approve ${id} | c4 deny ${id} "why"${AUTOPILOT ? "" : ` | c4 escalate ${id} "<plain-English sentence for the owner: what happens, to what, why it matters>"`}`);

const decisionFile = path.join(reqDir, `${id}.decision`);
const deadline = Date.now() + WAIT_MS;
while (Date.now() < deadline) {
  if (fs.existsSync(decisionFile)) {
    const [verdict, ...rest] = fs.readFileSync(decisionFile, "utf8").trim().split("\n");
    restoreState(beforeWait);
    if (verdict === "approve") say("allow", `claude4: approved by the coordinator${handed ? " (autopilot)" : ""}`);
    if (verdict === "deny") say("deny", `claude4: the coordinator said no${rest.length ? `: ${rest.join(" ")}` : ""}`);
    if (WEB) bryantDecides(id, "the boss passed this to you", rest.join(" "));
    askBryant("needs the owner's call (escalated by the coordinator)");
  }
  execFileSync("sleep", ["1"]);
}
restoreState(beforeWait);
if (AUTOPILOT) {
  board(`**✗ #${id} timed out** (autopilot): the boss didn't answer in 9 minutes, so it was refused`);
  say("deny", "claude4: the boss didn't answer in 9 minutes (autopilot is on, so it isn't sent to the owner). Ask the boss again or take another route.");
}
if (WEB) bryantDecides(id, "the boss didn't answer in 9 minutes");
askBryant("got no answer from the coordinator in 9 minutes");
