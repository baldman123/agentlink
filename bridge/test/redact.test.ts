// Unit tests for src/redact.ts: every pattern in contracts/screens.md, the live token, SGR-only stripping, the cap.
// Run: npm test (from bridge/), or tsx test/redact.test.ts
import { SCREEN_MAX_BYTES, SCREEN_MAX_LINES } from "../../contracts/index.ts";
import { loadToken } from "../src/config.ts";
import { REDACTED, capScreen, cleanScreen, redact, stripAll, stripToSgr } from "../src/redact.ts";

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
/** `secret` must be gone and `[redacted]` present; `keep` (if given) must survive. */
function hides(input: string, secret: string, name: string, keep?: string, token?: string) {
  const out = redact(input, token);
  check(!out.includes(secret) && out.includes(REDACTED) && (keep === undefined || out.includes(keep)), name, out);
}

const E = "\u001b";

console.error("redaction: contract patterns");
const TOKEN = "f3a9c2e71b8d4a60c5e2b9d7a1f04c3e";
hides(`curl -H x ${TOKEN} done`, TOKEN, "the shared token value", "done", TOKEN);
hides(`hello ${TOKEN}${TOKEN}`, TOKEN, "the token repeated / adjacent", "hello", TOKEN);
hides("export AGENTLINK_TOKEN=abc123secret && npm start", "abc123secret", "TOKEN=", "&& npm start");
hides("TOKEN=abc123secret", "abc123secret", "TOKEN= at line start");
hides("SECRET=hunter2hunter2 next", "hunter2hunter2", "SECRET=", "next");
hides("DB_PASSWORD='p a s s w o r d' tail", "p a s s w o r d", "PASSWORD= with a quoted value", "tail");
hides('PASSWORD="quoted pass"', "quoted pass", "PASSWORD= double-quoted");
hides("password=lowercase1", "lowercase1", "password= (case-insensitive)");
hides("OPENAI_API_KEY=sk-proj-abc", "sk-proj-abc", "API_KEY=");
hides("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig", "eyJhbGciOiJIUzI1NiJ9", "Authorization: Bearer");
hides("authorization: bearer abcdef0123456789", "abcdef0123456789", "authorization: bearer (case-insensitive)");
hides("key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX end", "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX", "sk-… (20+)", "end");
check(redact("sk-short") === "sk-short", "sk-… shorter than 20 is left alone");
hides("ghp_16C7e42F292c6912E7710c838347Ae178B4a", "ghp_16C7e42F292c6912E7710c838347Ae178B4a", "ghp_…");
hides("github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "github_pat_…");
hides("xoxb-123456789012-abcdefghijkl", "xoxb-123456789012-abcdefghijkl", "xoxb-…");
hides("xoxa-2-abcdefghijklmnop", "xoxa-2-abcdefghijklmnop", "xoxa-…");
hides("xoxp-123456789012-abcdefgh", "xoxp-123456789012-abcdefgh", "xoxp-…");
hides("aws AKIAIOSFODNN7EXAMPLE key", "AKIAIOSFODNN7EXAMPLE", "AKIA[0-9A-Z]{16}", "key");
const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nQyNTUxOQAAACD\n-----END OPENSSH PRIVATE KEY-----";
hides(`before\n${KEY}\nafter`, "b3BlbnNzaC1rZXktdjEAAAAA", "-----BEGIN … PRIVATE KEY----- block", "after");
check(redact(`before\n${KEY}\nafter`).startsWith("before"), "text before a key block survives");
hides("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nmore", "MIIEpAIBAAKCAQEA", "a key block cut off at the bottom");
hides("MIIEpAIBAAKCAQEA\n-----END EC PRIVATE KEY-----\nafter", "MIIEpAIBAAKCAQEA", "a key block whose BEGIN scrolled off", "after");
hides(`${E}[32mTOKEN=${E}[0mabc`, "TOKEN=abc", "TOKEN= value is redacted even right after a colour code");
check(redact("ordinary output: 42 tests passed") === "ordinary output: 42 tests passed", "ordinary text is unchanged");

console.error("redaction: the live token");
const live = loadToken();
if (live) {
  const out = cleanScreen(`$ echo ${live}\n${live}\n`, live);
  check(!out.includes(live) && out.includes(REDACTED), "the live token (AGENTLINK_TOKEN or data/.token) is redacted");
} else {
  console.error("  skip no live token in AGENTLINK_TOKEN or data/.token");
}

console.error("escape stripping");
const colored = `${E}[1;31mRED${E}[0m plain ${E}[38;5;214morange${E}[m`;
check(stripToSgr(colored) === colored, "SGR colour codes are kept");
const noisy = `${E}]0;window title${E}\\${E}[2J${E}[H${E}[?25l${E}[31mred${E}[0m${E}[10;5Hx${E}(B${E}=\r\nnext\u0007\u0008line${E}P1;2|data${E}\\`;
const cleaned = stripToSgr(noisy);
check(cleaned === `${E}[31mred${E}[0mx\nnextline`, "OSC, cursor, mode, charset, DCS, BEL, BS and CR are removed", cleaned);
check(!/\u001b(?!\[[0-9;]*m)/.test(stripToSgr(`a${E}`)) && !stripToSgr(`a${E}[`).includes(E), "a truncated escape at the end is removed");
check(!stripToSgr("x\u009b31my").includes("\u009b"), "8-bit C1 CSI is removed");
check(stripAll(colored) === "RED plain orange", "stripAll leaves plain text");

console.error("size cap");
const many = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
const capped = capScreen(many);
check(capped.split("\n").length === SCREEN_MAX_LINES && capped.endsWith("line 299"), `keeps the last ${SCREEN_MAX_LINES} lines`);
const wide = Array.from({ length: 100 }, (_, i) => `${i}:` + "x".repeat(2_000)).join("\n");
const cw = capScreen(wide);
check(Buffer.byteLength(cw, "utf8") <= SCREEN_MAX_BYTES && cw.endsWith("99:" + "x".repeat(2_000)) && !cw.startsWith("0:"), "drops the oldest lines to fit the byte cap");
const huge = capScreen("é".repeat(SCREEN_MAX_BYTES));
check(Buffer.byteLength(huge, "utf8") <= SCREEN_MAX_BYTES, "a single over-long line is cut to fit");
const late = cleanScreen(`${KEY.split("\n")[0]}\n${"pad\n".repeat(400)}tail`, null);
check(!late.includes("pad") || late.includes(REDACTED), "redaction runs before the cap (a cut key block can't leak)");

console.error("tall panes");
// A 240-row pane running Claude Code: the conversation at the top, ~200 blank rows, the input box at the bottom.
// Keeping only the last SCREEN_MAX_LINES lines would send blank rows and the prompt box, and none of the conversation.
const convo = Array.from({ length: 30 }, (_, i) => `${E}[38;5;246mreply ${i}${E}[39m`);
const tall = [...convo, ...Array.from({ length: 200 }, (_, i) => (i === 50 ? `${E}[0m   ` : "")), "✳ Working… (12s)", "────", "❯ ", "────"].join("\n");
const tallOut = cleanScreen(tall, null);
const tallPlain = stripAll(tallOut).split("\n");
check(tallPlain.some((l) => l === "reply 0") && tallPlain.some((l) => l === "reply 29") && tallOut.endsWith("────"), "a tall pane keeps its conversation and its input box", tallPlain.slice(0, 5));
check(!/\n\s*\n\s*\n/.test(stripAll(tallOut)), "a run of blank rows becomes one blank line");
check(tallOut.includes(`${E}[0m`), "colour codes on the dropped blank rows are kept");
check(stripAll(cleanScreen("a\n\nb", null)) === "a\n\nb", "a single blank line is left alone");

console.error(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
