// Request helpers shared by the API routes: JSON replies, who is calling (bearer or cookie), the same-origin rule
// for cookie writes, and one error boundary.
import { getDeps, type Deps } from "./deps.ts";
import { ConfigError } from "./env.ts";
import { verifySession } from "./crypto.ts";
import type { PersonRow } from "./store.ts";

export const COOKIE = "al_session";
export const USER_RE = /^[a-z0-9_-]{1,32}$/;
export const AGENT_RE = /^[a-z0-9_-]{1,32}$/;

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail?: string, readonly extra: Record<string, unknown> = {}) {
    super(code);
  }
}

export function json(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  if (body === undefined) return new Response(null, { status, headers: { "cache-control": "no-store", ...headers } });
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

export function log(event: string, fields: Record<string, unknown> = {}): void {
  // never pass codes, tokens or message text here
  console.log(JSON.stringify({ ts: new Date().toISOString(), component: "cloud", event, ...fields }));
}

export async function readJson<T = any>(req: Request, max = 256 * 1024): Promise<T> {
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, "too_large");
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new HttpError(400, "bad_json");
  }
}

export function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i !== -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** The first x-forwarded-for hop (Vercel sets it), else x-real-ip, else "unknown". */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

function siteOrigin(req: Request): string {
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

export function isHttps(req: Request): boolean {
  return (req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "")) === "https";
}

export interface Caller {
  user: string;
  owner: boolean;
  epoch: number;
  person: PersonRow;
  via: "bearer" | "cookie";
}

/**
 * Who is calling. Bearer first, then the cookie. The session is re-checked against people on every request, so a
 * revoke or re-invite takes effect at once. Cookie-authenticated writes must come from this site's own origin.
 */
export async function authenticate(req: Request, d: Deps = getDeps()): Promise<Caller> {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const token = bearer ?? cookieValue(req, COOKIE);
  if (!token) throw new HttpError(401, "unauthorized");
  const claims = await verifySession(d.env.sessionSecret, token);
  if (!claims) throw new HttpError(401, "unauthorized");
  const person = await d.store.getPerson(claims.sub);
  const owner = claims.sub === d.env.owner;
  if (!person || person.revoked_at || person.epoch !== claims.epoch || (owner ? !person.is_owner : person.is_owner)) {
    throw new HttpError(401, "revoked");
  }
  const via = bearer ? "bearer" : "cookie";
  if (via === "cookie" && req.method !== "GET" && req.method !== "HEAD") {
    if (req.headers.get("origin") !== siteOrigin(req)) throw new HttpError(403, "bad_origin");
  }
  return { user: claims.sub, owner, epoch: claims.epoch, person, via };
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

/** Wraps a route: HttpError -> its JSON reply, a missing env var -> 500 config, anything else -> 500 internal. */
export function route<C = unknown>(fn: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.code, ...(err.detail ? { detail: err.detail } : {}), ...err.extra });
      if (err instanceof ConfigError) {
        log("config.error", { detail: err.message });
        return json(500, { error: "config", detail: err.message });
      }
      log("route.error", { path: new URL(req.url).pathname, error: String(err) });
      return json(500, { error: "internal" });
    }
  };
}

/** Next 16 passes dynamic params as a promise. */
export type Params<P> = { params: Promise<P> };
