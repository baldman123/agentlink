// Files in a composer (contracts/uploads.md): the paperclip, drag and drop, and pasted screenshots. Each file streams
// to this laptop's daemon as soon as it's added, so the chip shows real progress; sending only passes the upload ids.
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { ATTACHMENTS_MAX, UPLOAD_MAX_LOCAL_BYTES, formatBytes, sizeError, type UploadResult } from "../../../contracts/index.ts";
import { UploadUnavailable } from "../lib.ts";
import { useApp } from "./bits.tsx";

export interface PendingFile {
  key: string;
  name: string;
  size: number;
  loaded: number;
  state: "uploading" | "done" | "error";
  result?: UploadResult;
  error?: string;
  abort: AbortController;
}

let seq = 0;

/** Chrome names every pasted screenshot "image.png"; give it a name that says when it was taken. */
function nameFor(f: File): string {
  if (f.name && f.name !== "image.png") return f.name;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "");
  return `screenshot-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

/**
 * State and handlers for one composer's files. `crossesHub` says whether the current target is another person, which
 * lowers the size limit to UPLOAD_MAX_HUB_BYTES (the daemon checks it again on send).
 */
export function useAttachments(crossesHub: boolean) {
  const { transport } = useApp();
  const [items, setItems] = useState<PendingFile[]>([]);
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const live = useRef(items);
  live.current = items;

  const patch = (key: string, p: Partial<PendingFile>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const add = useCallback(
    (files: File[]) => {
      setNotice("");
      const room = ATTACHMENTS_MAX - live.current.length;
      if (files.length > room) setNotice(`At most ${ATTACHMENTS_MAX} files per message; ${files.length - Math.max(room, 0)} left out.`);
      for (const f of files.slice(0, Math.max(room, 0))) {
        const item: PendingFile = { key: `f${++seq}`, name: nameFor(f), size: f.size, loaded: 0, state: "uploading", abort: new AbortController() };
        if (f.size > UPLOAD_MAX_LOCAL_BYTES) {
          setItems((xs) => [...xs, { ...item, state: "error", error: sizeError(f.size, false)! }]);
          continue;
        }
        setItems((xs) => [...xs, item]);
        transport
          .upload(f, item.name, (loaded) => patch(item.key, { loaded }), item.abort.signal)
          .then((result) => patch(item.key, { state: "done", loaded: f.size, result, name: result.name }))
          .catch((e: Error) => {
            if (e.name === "AbortError") return;
            patch(item.key, { state: "error", error: e instanceof UploadUnavailable ? e.message : `upload failed: ${e.message}` });
          });
      }
    },
    [transport],
  );

  const remove = (key: string) => {
    const x = live.current.find((i) => i.key === key);
    if (!x) return;
    x.abort.abort();
    if (x.result) void transport.deleteUpload(x.result.id);
    setItems((xs) => xs.filter((i) => i.key !== key));
  };

  // A component that unmounts mid-upload stops its uploads (the finished ones stay on disk, unsent).
  useEffect(() => () => live.current.forEach((x) => x.abort.abort()), []);

  const tooBig = crossesHub ? items.filter((x) => x.state === "done" && sizeError(x.size, true)) : [];
  const uploading = items.some((x) => x.state === "uploading");
  const failed = items.some((x) => x.state === "error");
  const ids = items.filter((x) => x.state === "done" && x.result).map((x) => x.result!.id);
  /** Why sending is blocked, or "" when the files are ready. */
  const blocker = uploading
    ? "Waiting for files to finish uploading…"
    : failed
      ? "Remove the files that didn't upload."
      : tooBig.length
        ? `${tooBig[0].name}: ${sizeError(tooBig[0].size, true)}.`
        : "";

  /** Pasting files or a screenshot attaches them; pasting text works as before. */
  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (!files.length) return;
    const text = e.clipboardData.getData("text/plain");
    // Finder puts the file name in text/plain next to the file; a spreadsheet puts real text next to a picture of it
    if (text && !files.some((f) => f.name === text.trim())) return;
    e.preventDefault();
    add(files);
  };

  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes("Files");
  const dropHandlers = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      add([...e.dataTransfer.files]);
    },
  };

  return {
    items,
    ids,
    paths: items.filter((x) => x.result).map((x) => x.result!.path),
    blocker,
    notice,
    dragging,
    add,
    remove,
    /** After a successful send: forget the chips (the files stay where they were delivered). */
    clear: () => setItems([]),
    onPaste,
    dropHandlers,
  };
}

const Clip = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 11.5 12.6 19.9a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8" />
  </svg>
);

/** The paperclip: opens the file picker (any type, several at once). */
export function AttachButton({ onFiles, disabled, className = "" }: { onFiles(files: File[]): void; disabled?: boolean; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={`attach-btn ${className}`} onClick={() => input.current?.click()} disabled={disabled} title="Attach files (or drop them here, or paste a screenshot)" aria-label="Attach files">
        <Clip />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        data-testid="attach-input"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = ""; // picking the same file again still fires
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

export function AttachmentChips({ items, onRemove, crossesHub }: { items: PendingFile[]; onRemove(key: string): void; crossesHub: boolean }) {
  if (!items.length) return null;
  return (
    <ul className="att-chips" aria-label="Files to send">
      {items.map((x) => {
        const pct = x.size ? Math.min(100, Math.round((x.loaded / x.size) * 100)) : 100;
        const big = crossesHub && x.state === "done" ? sizeError(x.size, true) : null;
        const bad = x.state === "error" || !!big;
        return (
          <li key={x.key} className={`att-chip ${bad ? "att-bad" : ""} att-${x.state}`} title={x.result?.path ?? x.error ?? x.name}>
            <span className="att-name">{x.name}</span>
            <span className="att-size">{formatBytes(x.size)}</span>
            {x.state === "uploading" && (
              <span className="att-prog" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Uploading ${x.name}`}>
                <span style={{ width: `${pct}%` }} />
                <em>{pct}%</em>
              </span>
            )}
            {(x.error || big) && <span className="att-err">{x.error ?? big}</span>}
            <button type="button" className="att-x" onClick={() => onRemove(x.key)} aria-label={`Remove ${x.name}`}>
              ✕
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Files on a sent or received message. */
export function MessageFiles({ files }: { files: NonNullable<UploadResult[]> | { name: string; size: number; path?: string; error?: string }[] }) {
  if (!files.length) return null;
  return (
    <ul className="msg-files">
      {files.map((f, i) => (
        <li key={i} className={f.error ? "att-bad" : ""} title={f.path ?? f.error ?? ""}>
          <Clip />
          <span className="att-name">{f.name}</span>
          <span className="att-size">{formatBytes(f.size)}</span>
          {!f.path && f.error && <span className="att-err">{f.error}</span>}
        </li>
      ))}
    </ul>
  );
}
