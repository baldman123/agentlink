// Protocol v2 challenge-response (contracts/index.ts, hub-api.md "Auth"). The shared token never leaves
// this browser: it comes from the localhost daemon's /v1/ui-bootstrap and is used only as an HMAC key here.
import type { ClientRole } from "../../contracts/index.ts";

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomHex(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

/** proof = HMAC-SHA256(token, "agentlink-v2|c|" + nonce + "|" + hub_id + "|" + user + "|" + role + "|" + cnonce) */
export const clientProof = (token: string, nonce: string, hubId: string, user: string, role: ClientRole, cnonce: string) =>
  hmacHex(token, `agentlink-v2|c|${nonce}|${hubId}|${user}|${role}|${cnonce}`);

/** server_proof = HMAC-SHA256(token, "agentlink-v2|s|" + cnonce + "|" + nonce + "|" + hub_id) */
export const serverProof = (token: string, cnonce: string, nonce: string, hubId: string) =>
  hmacHex(token, `agentlink-v2|s|${cnonce}|${nonce}|${hubId}`);

/** Constant-time compare of two hex strings (lengths are public). */
export function sameHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const IMPOSTOR_MSG = "Hub failed identity check";
