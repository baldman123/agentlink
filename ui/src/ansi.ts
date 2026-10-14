// ANSI SGR → styled segments. Pure data out (React renders the spans); never HTML.
// Handles 16 / 256 / truecolor fg+bg, bold, dim, italic, underline, inverse, strikethrough.
// Any non-SGR escape sequence is dropped (the bridge already strips them; this is a second guard).

export interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
}
export interface Segment {
  text: string;
  style: Style;
}
export type Line = Segment[];

// xterm-ish palette tuned for a dark navy background
export const PALETTE16 = [
  "#1b1f2a", "#e5534b", "#57ab5a", "#c69026", "#539bf5", "#b083f0", "#39c5cf", "#c9d1d9",
  "#636e7b", "#ff7b72", "#7ee787", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#f0f6fc",
];

function color256(n: number): string | undefined {
  if (n < 0 || n > 255 || Number.isNaN(n)) return undefined;
  if (n < 16) return PALETTE16[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  return `rgb(${steps[Math.floor(i / 36)]},${steps[Math.floor(i / 6) % 6]},${steps[i % 6]})`;
}

/** Applies one SGR parameter list to `st`, returning the new style. */
function applySgr(st: Style, params: number[]): Style {
  const s: Style = { ...st };
  if (params.length === 0) params = [0];
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) {
      for (const k of Object.keys(s)) delete s[k as keyof Style];
    } else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 7) s.inverse = true;
    else if (p === 9) s.strike = true;
    else if (p === 21 || p === 22) { s.bold = false; s.dim = false; }
    else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if (p === 27) s.inverse = false;
    else if (p === 29) s.strike = false;
    else if (p >= 30 && p <= 37) s.fg = PALETTE16[p - 30];
    else if (p === 39) delete s.fg;
    else if (p >= 40 && p <= 47) s.bg = PALETTE16[p - 40];
    else if (p === 49) delete s.bg;
    else if (p >= 90 && p <= 97) s.fg = PALETTE16[p - 90 + 8];
    else if (p >= 100 && p <= 107) s.bg = PALETTE16[p - 100 + 8];
    else if (p === 38 || p === 48) {
      const key = p === 38 ? "fg" : "bg";
      if (params[i + 1] === 5) {
        const c = color256(params[i + 2]);
        if (c) s[key] = c;
        i += 2;
      } else if (params[i + 1] === 2) {
        const [r, g, b] = [params[i + 2], params[i + 3], params[i + 4]].map((v) => Math.max(0, Math.min(255, v | 0)));
        s[key] = `rgb(${r},${g},${b})`;
        i += 4;
      }
    }
  }
  return s;
}

// SGR: ESC [ params m. Other CSI / OSC / single-char escapes are removed.
// CSI = ESC [ <params 0x30-0x3F> <intermediates 0x20-0x2F> <final>; OSC = ESC ] … BEL|ST; charset = ESC ( B etc.
const ESC_RE = /\x1b(?:\[([0-?]*)[ -/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()*+][ -~]|[@-Z\\-_])/g;

export function parseAnsi(text: string): Line[] {
  const lines: Line[] = [];
  let style: Style = {};
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line: Line = [];
    let last = 0;
    ESC_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    const push = (t: string) => {
      // drop other control characters except tab
      const clean = t.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
      if (!clean) return;
      const prev = line[line.length - 1];
      if (prev && prev.style === style) prev.text += clean;
      else line.push({ text: clean, style });
    };
    while ((m = ESC_RE.exec(raw))) {
      push(raw.slice(last, m.index));
      last = ESC_RE.lastIndex;
      if (m[2] === "m" && /^[0-9;:]*$/.test(m[1] ?? "")) style = applySgr(style, (m[1] ?? "").split(/[;:]/).filter((x) => x !== "").map(Number));
    }
    push(raw.slice(last));
    lines.push(line);
  }
  // trim trailing empty lines (tmux pads the pane bottom)
  while (lines.length > 1 && lines[lines.length - 1].every((s) => !s.text.trim())) lines.pop();
  return lines;
}

/** Inline CSS for a segment. Inverse swaps fg/bg against the pane defaults. */
export function cssOf(s: Style): React.CSSProperties | undefined {
  if (!s.fg && !s.bg && !s.bold && !s.dim && !s.italic && !s.underline && !s.inverse && !s.strike) return undefined;
  let fg = s.fg;
  let bg = s.bg;
  if (s.inverse) {
    fg = s.bg ?? "var(--term-bg)";
    bg = s.fg ?? "var(--term-fg)";
  }
  const deco = [s.underline && "underline", s.strike && "line-through"].filter(Boolean).join(" ");
  return {
    color: fg,
    backgroundColor: bg,
    fontWeight: s.bold ? 700 : undefined,
    opacity: s.dim ? 0.62 : undefined,
    fontStyle: s.italic ? "italic" : undefined,
    textDecoration: deco || undefined,
  };
}
