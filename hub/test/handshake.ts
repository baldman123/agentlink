// Protocol v2 client handshake for tests (hub smoke test, daemon tests, impostor test).
//   challenge (hub) -> check hub_id against the pin -> hello{cnonce, proof} -> welcome: verify server_proof -> session
// Nothing secret is ever sent: the token is only the HMAC key.
import { PROTOCOL_VERSION, type ClientRole, type ServerFrame } from "../../contracts/index.ts";
import { clientProof, newNonce, safeEqualHex, serverProof } from "../src/auth.ts";

/** The minimal socket surface the helper needs (a `ws` WebSocket fits). */
export interface FrameSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface HandshakeOptions {
  token: string;
  user: string;
  role: ClientRole;
  pinHubId?: string; // refuse (close, send nothing) when the challenge carries another hub_id
  since_seq?: number;
}

export type HandshakeResult =
  | { ok: true; welcome: Extract<ServerFrame, { op: "welcome" }>; session: string; nonce: string; cnonce: string; hello: Record<string, unknown> }
  | { ok: false; reason: "hub_id_mismatch" | "bad_server_proof" | "not_challenge" | "auth_failed" | "closed"; detail?: unknown };

/** Build the v2 hello for a challenge. Exposed so tests can tamper with it or replay it. */
export function helloFor(challenge: { nonce: string; hub_id: string }, o: HandshakeOptions, cnonce = newNonce()) {
  return {
    op: "hello" as const,
    role: o.role,
    user: o.user,
    protocol: PROTOCOL_VERSION,
    ...(o.since_seq !== undefined ? { since_seq: o.since_seq } : {}),
    cnonce,
    proof: clientProof(o.token, challenge.nonce, challenge.hub_id, o.user, o.role, cnonce),
  };
}

/**
 * Drive the handshake over a socket whose incoming frames arrive through `next()` (one parsed frame per call,
 * null when the socket closed). Resolves with the welcome and REST session, or why it stopped.
 */
export async function handshake(ws: FrameSocket, next: () => Promise<ServerFrame | null>, o: HandshakeOptions): Promise<HandshakeResult> {
  const first = await next();
  if (!first) return { ok: false, reason: "closed" };
  if (first.op !== "challenge") return { ok: false, reason: "not_challenge", detail: first };
  if (o.pinHubId && first.hub_id !== o.pinHubId) {
    ws.close(1000, "hub_id mismatch"); // send nothing at all to a hub that isn't the pinned one
    return { ok: false, reason: "hub_id_mismatch", detail: first.hub_id };
  }
  const hello = helloFor(first, o);
  ws.send(JSON.stringify(hello));
  const reply = await next();
  if (!reply) return { ok: false, reason: "closed" };
  if (reply.op === "error") return { ok: false, reason: "auth_failed", detail: reply };
  if (reply.op !== "welcome") return { ok: false, reason: "not_challenge", detail: reply };
  if (!safeEqualHex(reply.server_proof, serverProof(o.token, hello.cnonce, first.nonce, first.hub_id))) {
    ws.close(1000, "bad server proof"); // an impostor that doesn't know the token
    return { ok: false, reason: "bad_server_proof" };
  }
  return { ok: true, welcome: reply, session: reply.session, nonce: first.nonce, cnonce: hello.cnonce, hello };
}
