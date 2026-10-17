// What the routes do, apart from HTTP: logging in, routing and storing messages (the LAN hub's rules, hub-api.md),
// presence, and the context_update fan-out.
import { ADDRESS_RE, HOP_LIMIT, SESSION_TIMEOUT_MS, type Envelope, type MessageType, type StoredMessage, type UserPresence } from "../../../contracts/index.ts";
import type { Deps } from "./deps.ts";
import { checkAttachments } from "./files.ts";
import { mintRealtimeJwt, mintSession, safeEqual, sha256hex } from "./crypto.ts";
import { HttpError, log, USER_RE } from "./http.ts";
import type { PersonRow, SessionRow } from "./store.ts";

// ---------------------------------------------------------------- login

export const LOGIN_WINDOW_MS = 15 * 60_000;
export const LOGIN_MAX_PER_IP = 10;
export const LOGIN_MAX_TOTAL = 200;

/** Resolves an access code to its person, enforcing the rate limit and recording failures. */
export async function login(d: Deps, code: unknown, user: unknown, ip: string): Promise<PersonRow> {
  const since = new Date(d.now() - LOGIN_WINDOW_MS).toISOString();
  const [mine, all] = await Promise.all([d.store.countLoginFailures(ip, since), d.store.countLoginFailures(null, since)]);
  if (mine >= LOGIN_MAX_PER_IP || all >= LOGIN_MAX_TOTAL) {
    log("login.rate_limited", { ip, mine, all });
    throw new HttpError(429, "rate_limited", undefined, { retry_after_s: Math.ceil(LOGIN_WINDOW_MS / 1000) });
  }
  const fail = async (status: number, err: string, why: string) => {
    await d.store.recordLoginFailure(ip);
    log("login.failed", { ip, why });
    return new HttpError(status, err);
  };
  if (typeof code !== "string" || code.length < 8 || code.length > 200) throw await fail(401, "bad_code", "malformed code");
  if (user !== undefined && (typeof user !== "string" || !USER_RE.test(user))) throw await fail(401, "bad_code", "malformed user");

  let person: PersonRow | null;
  if (safeEqual(code, d.env.masterCode)) {
    person = await d.store.ensureOwner(d.env.owner);
  } else {
    person = await d.store.getPersonByCodeHash(sha256hex(code));
    if (person?.is_owner) person = null;
  }
  if (!person) throw await fail(401, "bad_code", "unknown code");
  if (user !== undefined && user !== person.username) throw await fail(401, "bad_code", "code is for another user");
  if (person.revoked_at) throw await fail(403, "revoked", "revoked code");
  log("login.ok", { user: person.username, ip });
  return person;
}

/** The login/refresh reply body: API session + Realtime credentials. */
export async function tokenBundle(d: Deps, person: PersonRow) {
  const nowS = Math.floor(d.now() / 1000);
  const session = await mintSession(d.env.sessionSecret, person.username, person.epoch, nowS);
  return {
    user: person.username,
    owner: person.username === d.env.owner,
    session: session.token,
    session_expires_at: session.expires_at,
    hub_id: await d.store.hubId(),
    hub_name: d.env.hubName,
    realtime: await realtimeBlock(d, person),
  };
}

export async function realtimeBlock(d: Deps, person: PersonRow) {
  const rt = await mintRealtimeJwt(d.env.supabaseJwtSecret, person.username, person.epoch, Math.floor(d.now() / 1000));
  return { url: d.env.supabaseUrl, anon_key: d.env.supabaseAnonKey, ...rt };
}

export function sessionCookie(token: string, https: boolean, maxAge: number): string {
  return `al_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${https ? "; Secure" : ""}`;
}

// ---------------------------------------------------------------- messages

const MESSAGE_TYPES: MessageType[] = ["task", "result", "chat", "context_update", "status"];
const userOf = (addr: string) => addr.split("/")[0];
const isAgentAddress = (a: unknown): a is string => typeof a === "string" && ADDRESS_RE.test(a) && !a.endsWith("/*");
const isTarget = (a: unknown): a is string => a === "*" || (typeof a === "string" && ADDRESS_RE.test(a));

export type Rejection = "hop_limit" | "bad_address" | "bad_envelope" | "from_mismatch" | "unknown_target" | "bad_attachment";

/** Builds the envelope for the browser form of POST /api/messages. */
export function envelopeFromForm(user: string, b: any, now: number): Envelope {
  const fromAgent = b.from_agent ?? "human";
  return {
    id: crypto.randomUUID(),
    from: `${user}/${fromAgent}`,
    to: b.to,
    reply_to: b.reply_to ?? null,
    hops: 0,
    type: b.type,
    body: b.body,
    timestamp: new Date(now).toISOString(),
  };
}

function shapeOk(e: any): boolean {
  return (
    !!e && typeof e === "object" && typeof e.id === "string" && e.id.length > 0 && e.id.length <= 128 &&
    MESSAGE_TYPES.includes(e.type) && Number.isInteger(e.hops) && e.hops >= 0 &&
    (typeof e.body === "string" || (!!e.body && typeof e.body === "object" && !Array.isArray(e.body))) &&
    typeof e.timestamp === "string" && (e.reply_to === null || e.reply_to === undefined || typeof e.reply_to === "string")
  );
}

/** Every active person, the owner included. */
async function activeUsers(d: Deps): Promise<string[]> {
  return (await d.store.listPeople()).filter((p) => !p.revoked_at).map((p) => p.username);
}

/**
 * The hub's send path: validate, refuse or drop, store with one delivery per recipient. A duplicate id answers the
 * way it did the first time and is not routed again.
 */
export async function acceptEnvelope(d: Deps, caller: string, raw: any): Promise<{ id: string; accepted: true } | { id: string; rejected: true; reason: Rejection }> {
  const id = typeof raw?.id === "string" ? raw.id : "";
  if (!shapeOk(raw)) return { id, rejected: true, reason: "bad_envelope" };
  let env: Envelope = { id: raw.id, from: raw.from, to: raw.to, reply_to: raw.reply_to ?? null, hops: raw.hops, type: raw.type, body: raw.body, timestamp: raw.timestamp };

  const existing = await d.store.getMessage(env.id);
  if (existing) {
    if (userOf(existing.from) !== caller) return { id, rejected: true, reason: "bad_envelope" };
    if (existing.state === "dropped") return { id, rejected: true, reason: (existing.drop_reason as Rejection) ?? "bad_envelope" };
    return { id, accepted: true };
  }
  if (!isAgentAddress(env.from) || !isTarget(env.to)) return { id, rejected: true, reason: "bad_address" };
  if (userOf(env.from) !== caller) return { id, rejected: true, reason: "from_mismatch" };

  const active = await activeUsers(d);
  let recipients: string[];
  if (env.to === "*") recipients = active.filter((u) => u !== caller);
  else {
    const target = userOf(env.to);
    if (!active.includes(target)) return { id, rejected: true, reason: "unknown_target" };
    recipients = [target];
  }

  // Files (uploads.md "Website"): only the sender's own finished uploads, rewritten from the rows. Readers are added
  // before the message is stored, so a recipient can always fetch what its delivery names.
  const files = await checkAttachments(d, caller, env);
  if ("refused" in files) {
    log("msg.rejected", { id, from: env.from, to: env.to, reason: files.refused });
    return { id, rejected: true, reason: "bad_attachment" };
  }
  env = files.env;
  if (files.fileIds.length) await d.store.addFileRecipients(files.fileIds, env.to === "*" ? ["*"] : recipients);

  const now = new Date(d.now()).toISOString();
  const base: StoredMessage = { ...env, state: "accepted", accepted_at: now, delivered_at: null, drop_reason: null };
  if (env.hops > HOP_LIMIT || env.hops + 1 > HOP_LIMIT) {
    await d.store.acceptMessage({ ...base, state: "dropped", drop_reason: "hop_limit" }, [], { ...env, hops: env.hops + 1 });
    log("msg.dropped", { id, from: env.from, to: env.to, type: env.type, hops: env.hops, reason: "hop_limit" });
    return { id, rejected: true, reason: "hop_limit" };
  }
  const fresh = await d.store.acceptMessage(base, recipients, { ...env, hops: env.hops + 1 });
  if (fresh) log("msg.accepted", { id, from: env.from, to: env.to, type: env.type, hops: env.hops, recipients: recipients.length });
  return { id, accepted: true };
}

/** A context write notifies every active person with a context_update delivery, like the LAN hub. */
export async function notifyContext(d: Deps, entry: { key: string; title: string; author: string }): Promise<void> {
  const now = new Date(d.now()).toISOString();
  for (const user of await activeUsers(d)) {
    const env: Envelope = {
      id: crypto.randomUUID(), from: entry.author, to: `${user}/*`, reply_to: null, hops: 0, type: "context_update",
      body: { text: `${entry.title} updated`, context_key: entry.key }, timestamp: now,
    };
    await d.store.acceptMessage({ ...env, state: "accepted", accepted_at: now, delivered_at: null, drop_reason: null }, [user], { ...env, hops: 1 });
  }
}

// ---------------------------------------------------------------- presence

export const ONLINE_MS = SESSION_TIMEOUT_MS; // 30s without a heartbeat -> offline

export const isOnline = (p: PersonRow, now: number) => !!p.last_seen && now - Date.parse(p.last_seen) <= ONLINE_MS;

export async function presence(d: Deps): Promise<UserPresence[]> {
  const now = d.now();
  const [people, sessions] = await Promise.all([d.store.listPeople(), d.store.listSessions()]);
  const byUser = new Map<string, SessionRow[]>();
  for (const s of sessions) byUser.set(s.user, [...(byUser.get(s.user) ?? []), s]);
  return people
    .filter((p) => !p.revoked_at)
    .map((p) => ({
      user: p.username,
      connected: isOnline(p, now),
      sessions: (byUser.get(p.username) ?? []).map(({ last_heartbeat, ...s }) => ({
        ...s,
        status: !isOnline(p, now) || now - Date.parse(last_heartbeat) > ONLINE_MS ? "offline" : s.status,
      })),
    }));
}
