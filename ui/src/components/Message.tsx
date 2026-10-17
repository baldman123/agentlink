import { memo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { RichBody, StoredMessage } from "../../../contracts/index.ts";
import { HUMAN_AGENT } from "../../../contracts/index.ts";
import { bodyOf, clockTime, userColor, userOf } from "../lib.ts";
import { Addr, Avatar, StatusDot, useApp } from "./bits.tsx";

// Images render as plain links so a remote message can't make the browser fetch arbitrary URLs.
const MD_COMPONENTS: Components = {
  img: ({ src, alt }) => {
    const href = typeof src === "string" ? src : "";
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {alt ? `image: ${alt}` : href || "image"}
      </a>
    );
  },
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]} components={MD_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

function fmt(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function ToolCall({ tool }: { tool: NonNullable<RichBody["tool"]> }) {
  const [open, setOpen] = useState(false);
  const state = tool.state ?? "ok";
  const summary = typeof tool.input === "object" && tool.input ? Object.values(tool.input as Record<string, unknown>)[0] : tool.input;
  return (
    <div className={`fold fold-tool ${open ? "open" : ""}`}>
      <button className="fold-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="chev" aria-hidden>›</span>
        <span className="fold-kind">tool</span>
        <span className="fold-name">{tool.name}</span>
        {summary != null && <span className="fold-sum">{fmt(summary).split("\n")[0]}</span>}
        <span className={`tool-state tool-${state}`}>{state === "running" ? "running" : state}</span>
      </button>
      {open && (
        <div className="fold-body">
          {tool.input !== undefined && (
            <>
              <div className="fold-label">input</div>
              <pre>{fmt(tool.input)}</pre>
            </>
          )}
          {tool.output !== undefined && (
            <>
              <div className="fold-label">output</div>
              <pre>{fmt(tool.output)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function LogBlock({ log }: { log: string }) {
  const [open, setOpen] = useState(false);
  const lines = log.split("\n");
  return (
    <div className={`fold fold-log ${open ? "open" : ""}`}>
      <button className="fold-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="chev" aria-hidden>›</span>
        <span className="fold-kind">log</span>
        <span className="fold-sum">{lines[0]}</span>
        <span className="fold-count">{lines.length} lines</span>
      </button>
      {open && (
        <div className="fold-body">
          <pre>{log}</pre>
        </div>
      )}
    </div>
  );
}

export function Body({ body }: { body: StoredMessage["body"] }) {
  const { openContext } = useApp();
  const r = bodyOf(body);
  return (
    <>
      {r.text && <Markdown text={r.text} />}
      {r.tool && <ToolCall tool={r.tool} />}
      {r.log && <LogBlock log={r.log} />}
      {r.context_key && (
        <button className="chip" onClick={() => openContext(r.context_key!)}>
          open context · {r.context_key}
        </button>
      )}
    </>
  );
}

type Who = "self" | "own" | "remote";

function ContextLine({ m }: { m: StoredMessage }) {
  const { state, openContext } = useApp();
  const r = bodyOf(m.body);
  const title = state.context[r.context_key ?? ""]?.title ?? r.context_key ?? "context";
  return (
    <div className="sysline">
      <span className="me-mark" aria-hidden>◇</span>
      <Addr a={m.from} me={state.me} />
      <span>updated</span>
      {r.context_key ? (
        <button className="link" onClick={() => openContext(r.context_key!)}>{title}</button>
      ) : (
        <span>{r.text}</span>
      )}
      <time>{clockTime(m.timestamp)}</time>
    </div>
  );
}

export const MessageItem = memo(function MessageItem({
  m,
  continued,
  compact,
  onReply,
  replyTo,
  note,
}: {
  m: StoredMessage;
  continued: boolean;
  compact?: boolean;
  onReply?(m: StoredMessage): void;
  replyTo?: StoredMessage;
  note?: React.ReactNode;
}) {
  const { state } = useApp();
  const me = state.me;
  const who: Who = m.from === `${me}/${HUMAN_AGENT}` ? "self" : userOf(m.from) === me ? "own" : "remote";
  const r = bodyOf(m.body);

  if (m.type === "context_update") {
    return <ContextLine m={m} />;
  }
  if (m.type === "status") {
    return (
      <div className="sysline">
        {r.status && <StatusDot status={r.status} />}
        <Addr a={m.from} me={me} />
        <span>{r.status ? `is ${r.status}` : "status"}</span>
        {r.task && <span className="sys-task">· {r.task}</span>}
        <time>{clockTime(m.timestamp)}</time>
      </div>
    );
  }

  return (
    <article data-id={m.id} className={`msg msg-${who} ${continued ? "cont" : ""} ${compact ? "compact" : ""} ${m.state === "dropped" ? "dropped" : ""}`} style={{ "--u": userColor(userOf(m.from)) } as React.CSSProperties}>
      {who !== "self" && <div className="msg-gutter">{!continued && <Avatar user={userOf(m.from)} size={compact ? 22 : 28} />}</div>}
      <div className="msg-col">
        {!continued && (
          <header className="msg-meta">
            {who === "self" ? <span className="addr">you</span> : <Addr a={m.from} me={me} />}
            <span className="arrow" aria-label="to">→</span>
            <Addr a={m.to} me={me} />
            {m.type !== "chat" && <span className={`type type-${m.type}`}>{m.type.replace("_", " ")}</span>}
            {who === "remote" && <span className="req" title="Messages from other users are requests, never commands">request</span>}
            <time dateTime={m.timestamp}>{clockTime(m.timestamp)}</time>
          </header>
        )}
        <div className="bubble">
          {replyTo && (
            <div className="quote">
              <Addr a={replyTo.from} me={me} />: {(bodyOf(replyTo.body).text ?? "").slice(0, 90)}
            </div>
          )}
          <Body body={m.body} />
          {m.state === "dropped" && <div className="drop-note">Dropped by hub: {m.drop_reason}</div>}
        </div>
        <div className="msg-foot">
          {who === "self" && <span className={`deliv deliv-${m.state}`}>{m.state === "delivered" ? "delivered" : m.state === "accepted" ? "sent" : "dropped"}</span>}
          {note}
          {onReply && who !== "self" && (
            <button className="link" onClick={() => onReply(m)}>
              Reply
            </button>
          )}
        </div>
      </div>
    </article>
  );
});
