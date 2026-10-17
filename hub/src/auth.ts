// Protocol v2 challenge-response (contracts/hub-api.md "Auth", formulas in contracts/index.ts).
// Pure functions with no hub state, so the daemon, its fake hub and the tests can import this file
// (../../hub/src/auth.ts) instead of re-deriving the strings. A token is only ever an HMAC key here.
//
//   hub -> client   challenge { nonce, hub_id, hub_name, protocol }
//   client -> hub   hello     { role, user, protocol, since_seq?, cnonce, proof = clientProof(token, nonce, hub_id, user, role, cnonce) }
//   hub -> client   welcome   { ..., server_proof = serverProof(token, cnonce, nonce, hub_id), session }
//
// Which token: the hub's master token is the key only for the hub owner's own user. Everyone else has a
// personal token, personalToken(master, user, epoch), handed out once by `bin/agentlink-hub invite`.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 random bytes as lowercase hex (64 chars). Used for the hub's nonce, the client's cnonce and REST sessions. */
export function newNonce(): string {
  return randomBytes(32).toString("hex");
}

function hmacHex(token: string, message: string): string {
  return createHmac("sha256", token).update(message, "utf8").digest("hex");
}

/**
 * A person's token = HMAC-SHA256(key=master, "agentlink-person|" + user + "|" + epoch), hex. Derived, so the hub
 * stores no per-person secret; revoking or re-inviting bumps the epoch (or marks the row revoked) and the old token dies.
 */
export function personalToken(master: string, user: string, epoch: number): string {
  return hmacHex(master, `agentlink-person|${user}|${epoch}`);
}

/** proof = HMAC-SHA256(key=token, "agentlink-v2|c|" + nonce + "|" + hub_id + "|" + user + "|" + role + "|" + cnonce), hex. */
export function clientProof(token: string, nonce: string, hubId: string, user: string, role: string, cnonce: string): string {
  return hmacHex(token, `agentlink-v2|c|${nonce}|${hubId}|${user}|${role}|${cnonce}`);
}

/** server_proof = HMAC-SHA256(token, "agentlink-v2|s|" + cnonce + "|" + nonce + "|" + hub_id), hex. */
export function serverProof(token: string, cnonce: string, nonce: string, hubId: string): string {
  return hmacHex(token, `agentlink-v2|s|${cnonce}|${nonce}|${hubId}`);
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Constant-time compare of two hex digests; false for anything that isn't 64 lowercase hex chars. */
export function safeEqualHex(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || !HEX64.test(given) || !HEX64.test(expected)) return false;
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

/** A client nonce must be fresh randomness of a sane size (hex, 32-128 chars). */
export function validCnonce(c: unknown): c is string {
  return typeof c === "string" && /^[0-9a-f]{32,128}$/.test(c);
}
