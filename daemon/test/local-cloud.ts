// Test helper: the REAL website API (cloud/app/api/**/route.ts, unmodified) served over plain http, on an in-memory
// store (cloud/test/memory-store.ts) instead of Supabase, with the fake Realtime (fake-realtime.ts) on the same port
// standing in for Supabase Realtime. Unlike fake-cloud.ts, nothing here is re-implemented: routing, recipients,
// acks, presence and context are the production code paths, so a multi-team test exercises what the site really does.
//
// The one piece of glue is what Postgres + Realtime do together: a committed deliveries row is pushed to the
// subscribers of postgres_changes. RealtimeMemoryStore does that on every new delivery (and can hold pushes back,
// as when Realtime is down, so the daemon has to resume from GET /api/deliveries).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Envelope, StoredMessage } from "../../contracts/index.ts";
import { setDeps } from "../../cloud/lib/server/deps.ts";
import { MemoryFileStorage, MemoryStore } from "../../cloud/test/memory-store.ts";
import { attachFakeRealtime, type FakeRealtime } from "./fake-realtime.ts";

const API_DIR = path.resolve(import.meta.dirname, "../../cloud/app/api");

export const MASTER_CODE = "master-code-for-local-cloud-0123456789";

/** Pushes every new deliveries row to Realtime subscribers, the way postgres_changes does after a commit. */
export class RealtimeMemoryStore extends MemoryStore {
  rt: FakeRealtime | null = null;
  /** While false, rows are stored but not pushed (Realtime down / missed events). */
  push = true;
  async acceptMessage(msg: StoredMessage, recipients: string[], delivered: Envelope) {
    const before = this.deliveries.length;
    const fresh = await super.acceptMessage(msg, recipients, delivered);
    if (this.push && this.rt) {
      for (const d of this.deliveries.slice(before)) {
        this.rt.insert("deliveries", { seq: d.seq, message_id: d.message_id, username: d.username, hops: d.envelope.hops, envelope: d.envelope, acked: false, acked_at: null, created_at: new Date().toISOString() });
      }
    }
    return fresh;
  }
}

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
interface RouteEntry { re: RegExp; names: string[]; mod: Record<string, Handler>; file: string }

async function loadRoutes(): Promise<RouteEntry[]> {
  const out: RouteEntry[] = [];
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name === "route.ts" ? [path.join(dir, e.name)] : []));
  for (const file of walk(API_DIR)) {
    const segs = path.relative(API_DIR, path.dirname(file)).split(path.sep).filter(Boolean);
    const names: string[] = [];
    const re = new RegExp(
      "^/api" + segs.map((s) => (/^\[.+\]$/.test(s) ? (names.push(s.slice(1, -1)), "/([^/]+)") : "/" + s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("") + "$",
    );
    out.push({ re, names, mod: (await import(pathToFileURL(file).href)) as Record<string, Handler>, file });
  }
  // static segments beat dynamic ones (Next does the same): fewer params first
  return out.sort((a, b) => a.names.length - b.names.length);
}

export interface LocalCloud {
  url: string;
  rt: FakeRealtime;
  store: RealtimeMemoryStore;
  /** Storage for files, served on the same port at the signed URLs. */
  files: MemoryFileStorage;
  /** Every API request the site answered: method, path, status. */
  requests: Array<{ method: string; path: string; status: number; user?: string }>;
  /** The owner invites a person; returns their access code. */
  invite(user: string): Promise<string>;
  close(): Promise<void>;
}

export async function startLocalCloud(opts: { owner?: string } = {}): Promise<LocalCloud> {
  const routes = await loadRoutes();
  const server = createServer((req, res) => void handle(req, res));
  const rt = attachFakeRealtime(server);
  const store = new RealtimeMemoryStore();
  store.rt = rt;
  const env = {
    owner: opts.owner ?? "bryant",
    masterCode: MASTER_CODE,
    sessionSecret: "local-cloud-session-secret-".padEnd(48, "x"),
    supabaseUrl: "", // set once listening: Realtime is on this same server
    supabaseAnonKey: "anon-local",
    supabaseServiceKey: "service-local",
    supabaseJwtSecret: "local-cloud-jwt-secret-".padEnd(48, "y"),
    hubName: "agentlink local cloud",
  };
  const files = new MemoryFileStorage();
  setDeps({
    env,
    store,
    broadcaster: { send: async (topic, event, payload) => rt.broadcast(`realtime:${topic}`, event, payload as Record<string, unknown>) },
    now: () => Date.now(),
    files,
  });
  const requests: LocalCloud["requests"] = [];

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (await files.handle(req, res)) return; // the signed Storage URLs (uploads.md "Website")
    const url = new URL(req.url ?? "/", "http://local");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const method = req.method ?? "GET";
    const hit = routes.map((r) => ({ r, m: r.re.exec(url.pathname) })).find((x) => x.m && typeof x.r.mod[method] === "function");
    if (!hit) {
      requests.push({ method, path: url.pathname + url.search, status: 404 });
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_found" }));
      return;
    }
    const params = Object.fromEntries(hit.r.names.map((n, i) => [n, decodeURIComponent(hit.m![i + 1])]));
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    headers.set("x-forwarded-for", "127.0.0.1");
    const body = chunks.length && method !== "GET" && method !== "HEAD" ? Buffer.concat(chunks) : undefined;
    let r: Response;
    try {
      r = await hit.r.mod[method](new Request(`http://${req.headers.host}${req.url}`, { method, headers, body }), { params: Promise.resolve(params) });
    } catch (err) {
      r = new Response(JSON.stringify({ error: "crash", detail: String(err) }), { status: 500 });
    }
    requests.push({ method, path: url.pathname + url.search, status: r.status });
    const out = Buffer.from(await r.arrayBuffer());
    const h: Record<string, string> = {};
    r.headers.forEach((v, k) => (h[k] = v));
    res.writeHead(r.status, h).end(out.length ? out : undefined);
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  env.supabaseUrl = url;
  files.base = url;

  const call = async (method: string, p: string, bearer: string, body?: unknown) => {
    const r = await fetch(url + p, { method, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  let ownerSession: string | null = null;
  return {
    url,
    rt,
    store,
    files,
    requests,
    async invite(user) {
      if (!ownerSession) {
        const r = await fetch(url + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: MASTER_CODE }) });
        ownerSession = ((await r.json()) as { session: string }).session;
      }
      const r = await call("POST", "/api/admin/people", ownerSession, { user });
      if (r.status !== 200) throw new Error(`invite ${user}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.code as string;
    },
    close: () =>
      new Promise((resolve) => {
        rt.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
