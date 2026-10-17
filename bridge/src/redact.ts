// Screen text cleanup before anything leaves this laptop (contracts/screens.md).
// Order matters: stripToSgr -> redact -> capScreen. Redaction runs on the whole capture before the cap, so a
// private key block can't be half-cut into an unredacted tail.
import { SCREEN_MAX_BYTES, SCREEN_MAX_LINES } from "../../contracts/index.ts";

export const REDACTED = "[redacted]";

const ESC = "\u001b";
const SGR_RE = /^\u001b\[[0-9;]*m$/;
// CSI, OSC (BEL or ST terminated), DCS/SOS/PM/APC (ST terminated), charset selection, and any other 2-byte escape.
const ESCAPE_SEQ_RE =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[PX^_][\s\S]*?\u001b\\|\u001b[()*+][0-9A-Za-z]|\u001b[@-Z\\-_=>78]/g;

/** Keep only SGR colour codes (ESC [ digits/; m). Every other escape sequence and control character is removed. */
export function stripToSgr(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(ESCAPE_SEQ_RE, (seq) => (SGR_RE.test(seq) ? seq : ""))
    .replace(/\u001b(?!\[[0-9;]*m)/g, "") // a stray or truncated ESC
    .replace(/[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f-\u009f]/g, ""); // C0 (except \t \n ESC), DEL, C1
}

/** Remove every escape sequence (for matching text such as "esc to interrupt"). */
export function stripAll(text: string): string {
  return stripToSgr(text).replace(/\u001b\[[0-9;]*m/g, "");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A value: a quoted string, or a run up to whitespace, a quote, or the next colour code.
const VALUE = `(?:"[^"\\n]*"?|'[^'\\n]*'?|[^\\s'"${ESC}]+)`;

// Colour codes a shell or highlighter may put between a key and its value.
const SGR_GAP = `(?:${ESC}\\[[0-9;]*m)*`;

const PATTERNS: [RegExp, string][] = [
  // KEY=value: anything after TOKEN=, SECRET=, PASSWORD=, API_KEY= (also as a suffix: AGENTLINK_TOKEN=, DB_PASSWORD=)
  [new RegExp(`((?:TOKEN|SECRET|PASSWORD|API_KEY)=${SGR_GAP})${VALUE}`, "gi"), `$1${REDACTED}`],
  [new RegExp(`(Authorization:\\s*Bearer\\s+${SGR_GAP})${VALUE}`, "gi"), `$1${REDACTED}`],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{8,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{8,}/g, REDACTED],
  [/\bxox[abp]-[A-Za-z0-9-]{8,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
];

const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/** Private key blocks, including ones cut off by the top or bottom of the capture. */
function redactKeyBlocks(text: string): string {
  let out = text.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, REDACTED);
  const begin = out.search(KEY_BEGIN);
  if (begin >= 0) out = out.slice(0, begin) + REDACTED; // BEGIN with no END: the rest of the screen is key material
  const endMatch = out.match(KEY_END);
  if (endMatch && endMatch.index !== undefined) out = REDACTED + out.slice(endMatch.index + endMatch[0].length); // END whose BEGIN scrolled off
  return out;
}

/** Best-effort secret redaction (contracts/screens.md). `token` is the shared agentlink token, if known. */
export function redact(text: string, token?: string | null): string {
  let out = text;
  if (token && token.length >= 6) out = out.replace(new RegExp(escapeRe(token), "g"), REDACTED);
  out = redactKeyBlocks(out);
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Keep the last SCREEN_MAX_LINES lines, then drop the oldest lines until the UTF-8 size fits SCREEN_MAX_BYTES. */
export function capScreen(text: string, maxLines = SCREEN_MAX_LINES, maxBytes = SCREEN_MAX_BYTES): string {
  let lines = text.split("\n");
  if (lines.length > maxLines) lines = lines.slice(lines.length - maxLines);
  let size = Buffer.byteLength(lines.join("\n"), "utf8");
  let drop = 0;
  while (size > maxBytes && drop < lines.length) {
    size -= Buffer.byteLength(lines[drop], "utf8") + 1;
    drop++;
  }
  lines = lines.slice(drop);
  let out = lines.join("\n");
  // A single line longer than the cap: keep its tail.
  while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(Math.ceil(out.length / 8));
  return out;
}

const BLANK_RE = /^(?:\s|\u001b\[[0-9;]*m)*$/;

/**
 * Each run of blank lines becomes one blank line that keeps the run's colour codes. A tall pane (claude4web's are
 * 240 rows) running Claude Code is mostly blank rows between the conversation and the input box, so without this
 * the last SCREEN_MAX_LINES lines would be blank rows and the prompt, and none of the conversation.
 */
export function collapseBlankRuns(text: string): string {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) out.push(run.length === 1 ? run[0] : run.join("").replace(/[^\u001b[0-9;m]/g, ""));
    run = [];
  };
  for (const line of text.split("\n")) {
    if (BLANK_RE.test(line)) run.push(line);
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join("\n");
}

/** The whole pipeline for one capture. */
export function cleanScreen(raw: string, token?: string | null): string {
  const text = stripToSgr(raw).replace(/\n+$/, "");
  return capScreen(collapseBlankRuns(redact(text, token)));
}
