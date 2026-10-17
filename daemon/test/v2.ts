// Test helper: open a role=ui hub socket with the v2 challenge-response handshake
// (contracts/hub-api.md "Auth"). Returns the socket, every server frame it got, and the REST session.
import { createHmac, randomBytes } from "node:crypto";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerFrame } from "../../contracts/index.ts";

export interface V2Socket {
  ws: WebSocket;
  frames: ServerFrame[];
  session: string;
  hubId: string;
}

const hmac = (key: string, msg: string) => createHmac("sha256", key).update(msg).digest("hex");

export function openUi(url: string, token: string, user = "e2e-ui"): Promise<V2Socket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames: ServerFrame[] = [];
    let nonce = "";
    let hubId = "";
    const cnonce = randomBytes(32).toString("hex");
    const timer = setTimeout(() => reject(new Error("v2 handshake timed out")), 5_000);
    ws.on("message", (d) => {
      const f = JSON.parse(d.toString()) as ServerFrame;
      frames.push(f);
      if (f.op === "challenge") {
        nonce = f.nonce;
        hubId = f.hub_id;
        const proof = hmac(token, `agentlink-v2|c|${nonce}|${hubId}|${user}|ui|${cnonce}`);
        ws.send(JSON.stringify({ op: "hello", role: "ui", user, protocol: PROTOCOL_VERSION, cnonce, proof }));
      } else if (f.op === "welcome") {
        clearTimeout(timer);
        if (f.server_proof !== hmac(token, `agentlink-v2|s|${cnonce}|${nonce}|${hubId}`)) return reject(new Error("bad server_proof"));
        resolve({ ws, frames, session: f.session, hubId });
      } else if (f.op === "error") {
        clearTimeout(timer);
        reject(new Error(`hub refused: ${f.message}`));
      }
    });
    ws.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
