import { useEffect, useMemo, useRef, useState } from "react";
import type { ContextEntry, ContextKind } from "../../../contracts/index.ts";
import { HUMAN_AGENT } from "../../../contracts/index.ts";
import { relTime } from "../lib.ts";
import { Addr, Skeleton, useApp, useNow } from "./bits.tsx";
import { Markdown } from "./Message.tsx";

const KINDS: ContextKind[] = ["note", "decision", "api_spec"];
const KIND_LABEL: Record<ContextKind, string> = { note: "note", decision: "decision", api_spec: "API spec" };
const KEY_RE = /^[a-z0-9._-]{1,64}$/;

interface Draft {
  key: string;
  title: string;
  kind: ContextKind;
  body: string;
  base_version?: number;
  isNew: boolean;
}

function Editor({ draft, onDone }: { draft: Draft; onDone(): void }) {
  const { state, dispatch, transport } = useApp();
  const [d, setD] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [conflict, setConflict] = useState<ContextEntry | null>(null);
  const keyTaken = d.isNew && !!state.context[d.key];
  const keyBad = d.isNew && d.key !== "" && !KEY_RE.test(d.key);

  const save = async (base_version = d.base_version) => {
    if (!d.title.trim() || !d.key || keyBad || keyTaken) return;
    setBusy(true);
    setErr("");
    const r = await transport
      .putContext(d.key, { title: d.title.trim(), kind: d.kind, body: d.body, base_version, agent: HUMAN_AGENT })
      .catch((e: Error) => ({ ok: false as const, error: `Save failed: ${e.message}` }));
    setBusy(false);
    if (r.ok) {
      dispatch({ type: "context.local", entry: r.entry });
      onDone();
    } else if ("conflict" in r) setConflict(r.conflict);
    else setErr(r.error);
  };

  return (
    <div className="editor">
      {d.isNew && (
        <label className="field">
          <span>Key</span>
          <input value={d.key} onChange={(e) => setD({ ...d, key: e.target.value.toLowerCase() })} placeholder="api-schema" autoFocus />
          {keyBad && <em className="err">Use a–z, 0–9, dot, dash or underscore.</em>}
          {keyTaken && <em className="err">That key exists. Edit the existing card instead.</em>}
        </label>
      )}
      <div className="field-row">
        <label className="field grow">
          <span>Title</span>
          <input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} autoFocus={!d.isNew} />
        </label>
        <label className="field">
          <span>Kind</span>
          <select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as ContextKind })}>
            {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Body (markdown)</span>
        <textarea
          rows={8}
          value={d.body}
          onChange={(e) => setD({ ...d, body: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            }
          }}
        />
      </label>
      {conflict && (
        <div className="conflict" role="alert">
          <strong>
            <Addr a={conflict.author} me={state.me} /> saved v{conflict.version} while you were editing.
          </strong>
          <div className="conflict-preview"><Markdown text={conflict.body} /></div>
          <div className="row">
            <button className="btn" onClick={() => { setD({ ...d, title: conflict.title, kind: conflict.kind, body: conflict.body, base_version: conflict.version }); setConflict(null); }}>
              Load theirs
            </button>
            <button className="btn btn-primary" onClick={() => { const v = conflict.version; setConflict(null); setD({ ...d, base_version: v }); save(v); }}>
              Overwrite v{conflict.version}
            </button>
          </div>
        </div>
      )}
      {err && <div className="err">{err}</div>}
      <div className="row">
        <span className="grow" />
        <button className="btn btn-ghost" onClick={onDone}>Cancel</button>
        <button className="btn btn-primary" onClick={() => save()} disabled={busy || !d.title.trim() || !d.key || keyBad || keyTaken}>
          {busy ? "Saving…" : d.isNew ? "Create" : "Save"}
        </button>
      </div>
    </div>
  );
}

function Card({ e, open, toggle, edit }: { e: ContextEntry; open: boolean; toggle(): void; edit(): void }) {
  const { state } = useApp();
  const now = useNow();
  const flashAt = state.flash[e.key];
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [open]);
  return (
    <article ref={ref} className={`card ${open ? "open" : ""}`}>
      {flashAt && Date.now() - flashAt < 3000 && <span key={flashAt} className="flash" aria-hidden />}
      <button className="card-head" onClick={toggle} aria-expanded={open}>
        <span className={`ckind ckind-${e.kind}`}>{KIND_LABEL[e.kind]}</span>
        <span className="card-title">{e.title}</span>
        <span className="card-ver">v{e.version}</span>
      </button>
      <div className="card-meta">
        <Addr a={e.author} me={state.me} />
        <time dateTime={e.updated_at}>{relTime(e.updated_at, now)}</time>
        <code className="card-key">{e.key}</code>
      </div>
      <div className={`card-body ${open ? "" : "clamp"}`} onClick={open ? undefined : toggle}>
        <Markdown text={e.body} />
      </div>
      {open && (
        <div className="row">
          <span className="grow" />
          <button className="btn" onClick={edit}>Edit</button>
        </div>
      )}
    </article>
  );
}

export function ContextPanel() {
  const { state, contextFocus } = useApp();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    if (contextFocus) {
      setOpen(contextFocus.key);
      setQ("");
    }
  }, [contextFocus]);

  const entries = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return Object.values(state.context)
      .filter((e) => !needle || e.key.includes(needle) || e.title.toLowerCase().includes(needle) || e.body.toLowerCase().includes(needle))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }, [state.context, q]);

  if (!state.snapshotReady) return <div className="pad"><Skeleton lines={6} /></div>;

  return (
    <div className="ctx">
      <div className="ctx-tools">
        <input className="search" type="search" placeholder="Search context" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search shared context" />
        <button className="btn" onClick={() => setDraft({ key: "", title: "", kind: "note", body: "", isNew: true })}>New</button>
      </div>
      {draft?.isNew && <Editor draft={draft} onDone={() => setDraft(null)} />}
      <div className="cards">
        {entries.length === 0 && !draft && (
          <div className="empty">
            {q ? <><strong>Nothing matches "{q}".</strong><span>Search covers keys, titles and bodies.</span></>
               : <><strong>No shared context yet.</strong><span>Add a note, decision or API spec every agent can read.</span></>}
          </div>
        )}
        {entries.map((e) =>
          draft && !draft.isNew && draft.key === e.key ? (
            <div key={e.key} className="card open"><Editor draft={draft} onDone={() => setDraft(null)} /></div>
          ) : (
            <Card
              key={e.key}
              e={e}
              open={open === e.key}
              toggle={() => setOpen(open === e.key ? null : e.key)}
              edit={() => setDraft({ key: e.key, title: e.title, kind: e.kind, body: e.body, base_version: e.version, isNew: false })}
            />
          ),
        )}
      </div>
    </div>
  );
}
