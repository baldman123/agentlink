// Access codes, API session tokens and the Supabase JWTs the API mints (contracts/cloud-api.md "Identity and auth").
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export const SESSION_TTL_S = 30 * 24 * 3600;
export const REALTIME_TTL_S = 15 * 60;

export const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Constant-time string compare (via fixed-length digests, so lengths don't leak either). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** A personal access code: "alc_" + 32 random bytes, base64url. Only its sha256 is stored. */
export const newCode = () => `alc_${randomBytes(32).toString("base64url")}`;

const key = (secret: string) => new TextEncoder().encode(secret);
const iso = (s: number) => new Date(s * 1000).toISOString();

export interface SessionClaims {
  sub: string;
  epoch: number;
}

/** API session: HS256 with AGENTLINK_SESSION_SECRET, typ "session", 30 days. */
export async function mintSession(secret: string, user: string, epoch: number, now = Math.floor(Date.now() / 1000)) {
  const exp = now + SESSION_TTL_S;
  const token = await new SignJWT({ epoch, typ: "session" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(key(secret));
  return { token, expires_at: iso(exp) };
}

export async function verifySession(secret: string, token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ["HS256"] });
    if (payload.typ !== "session" || typeof payload.sub !== "string" || typeof payload.epoch !== "number") return null;
    return { sub: payload.sub, epoch: payload.epoch };
  } catch {
    return null;
  }
}

/** Supabase JWT for Realtime/PostgREST reads: role authenticated, app_user, epoch; 15 minutes. */
export async function mintRealtimeJwt(secret: string, user: string, epoch: number, now = Math.floor(Date.now() / 1000)) {
  const exp = now + REALTIME_TTL_S;
  const jwt = await new SignJWT({ role: "authenticated", app_user: user, epoch })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user)
    .setAudience("authenticated")
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(key(secret));
  return { jwt, jwt_expires_at: iso(exp) };
}

/**
 * Signature on an input frame (cloud-api.md "Typing into your own panes"): HMAC-SHA256 keyed with sha256(code) hex,
 * so the daemon, which knows its own code, can check the frame came from the API for this user.
 */
export function inputSig(codeHash: string, f: { user: string; id: string; at: string; agents: string[]; submit: boolean; text: string }): string {
  const msg = `agentlink-input-v1\n${f.user}\n${f.id}\n${f.at}\n${f.agents.join(",")}\n${f.submit ? "1" : "0"}\n${f.text}`;
  return createHmac("sha256", codeHash).update(msg, "utf8").digest("hex");
}
