// Loop test: bounce one message between two agents on two daemons, each side forwarding what it receives,
// and show the hop limit stops it.
//
//   A sends (hops 0) → hub delivers to B (hops 1) → B forwards (2) → A receives (3) → A forwards (4)
//   → B receives (5) → B's forward would be hops 6 → refused by the forward helper and logged.
//
// Then two backstops are checked: the daemon rejects a raw send with hops 6 (422 hop_limit), and the hub
// drops a hops-5 send whose delivery would be hops 6 (stored with state "dropped", drop_reason "hop_limit").
//
// Usage: tsx scripts/loop-test.ts  [env LOOP_A_DAEMON=http://127.0.0.1:7701 LOOP_B_DAEMON=http://127.0.0.1:7702]

import { randomUUID } from "node:crypto";
import { HOP_LIMIT, type Envelope, type InboxItem } from "../../contracts/index.ts";
import { DaemonClient, DaemonError, HopLimitError } from "../src/client.ts";
import { bodyToText } from "../src/trust.ts";

const AGENT = "looptest";
const A = new DaemonClient({ baseUrl: process.env.LOOP_A_DAEMON ?? "http://127.0.0.1:7701", agent: AGENT });
const B = new DaemonClient({ baseUrl: process.env.LOOP_B_DAEMON ?? "http://127.0.0.1:7702", agent: AGENT });
const TIMEOUT_MS = Number(process.env.LOOP_TIMEOUT_MS) || 15_000;

let failures = 0;
function check(ok: boolean, msg: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(c: DaemonClient, tag: string, seen: Set<string>): Promise<InboxItem> {
  const end = Date.now() + TIMEOUT_MS;
  while (Date.now() < end) {
    const items = await c.inbox({ agent: AGENT, limit: 500 });
    const hit = items.find((i) => !seen.has(i.envelope.id) && bodyToText(i.envelope.body).includes(tag));
    if (hit) {
      seen.add(hit.envelope.id);
      return hit;
    }
    await sleep(200);
  }
  throw new Error(`timed out after ${TIMEOUT_MS}ms waiting for ${tag} at ${c.baseUrl}`);
}

async function main() {
  const [ha, hb] = await Promise.all([A.health(), B.health()]);
  console.log(`A = ${ha.user} @ ${A.baseUrl} (hub ${ha.hub.state})`);
  console.log(`B = ${hb.user} @ ${B.baseUrl} (hub ${hb.hub.state})`);
  if (ha.user === hb.user) throw new Error("the two daemons must belong to different users");
  const addrA = `${ha.user}/${AGENT}`;
  const addrB = `${hb.user}/${AGENT}`;
  const tag = `loop-${randomUUID().slice(0, 8)}`;
  const seen = new Set<string>();
  const toAck: [DaemonClient, string][] = [];

  // ---- 1. bounce with forwarding until the helper refuses ----
  console.log(`\n1. bounce ${tag} between ${addrA} and ${addrB}`);
  const first = await A.send({ to: addrB, type: "chat", body: `${tag}: ping (loop test, safe to ignore)` });
  console.log(`   ${addrA} sent ${first.id} hops 0`);
  let side: "A" | "B" = "B";
  let refusedAt: number | null = null;
  const received: number[] = [];
  for (let step = 0; step < 10; step++) {
    const me = side === "A" ? A : B;
    const other = side === "A" ? addrB : addrA;
    const item = await waitFor(me, tag, seen);
    const env: Envelope = item.envelope;
    toAck.push([me, env.id]);
    received.push(env.hops);
    console.log(`   ${side === "A" ? addrA : addrB} received ${env.id} hops ${env.hops} (remote=${item.remote})`);
    try {
      const res = await me.forward(env, other, { note: "loop test" });
      console.log(`   ${side === "A" ? addrA : addrB} forwarded as ${res.id} hops ${env.hops + 1}`);
    } catch (err) {
      if (err instanceof HopLimitError) {
        refusedAt = err.hops;
        console.log(`   ${side === "A" ? addrA : addrB} REFUSED forward: ${err.message}`);
        break;
      }
      throw err;
    }
    side = side === "A" ? "B" : "A";
  }
  check(JSON.stringify(received) === JSON.stringify([1, 3, 5]), `received hops sequence ${JSON.stringify(received)} == [1,3,5]`);
  check(refusedAt === HOP_LIMIT + 1, `forward helper refused at hops ${refusedAt} (expected ${HOP_LIMIT + 1})`);

  // ---- 2. daemon backstop: a raw send with hops 6 must get 422 ----
  console.log(`\n2. raw daemon send with hops ${HOP_LIMIT + 1} (bypassing the helper)`);
  const raw = await fetch(`${A.baseUrl}/v1/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from_agent: AGENT, to: addrB, type: "chat", body: `${tag}: raw hops 6`, hops: HOP_LIMIT + 1 }),
  });
  const rawBody = await raw.json().catch(() => ({}));
  check(raw.status === 422 && (rawBody as any).error === "hop_limit", `daemon answered ${raw.status} ${JSON.stringify(rawBody)}`);

  // ---- 3. hub backstop: hops 5 is sendable, but delivery would be hops 6 → hub drops ----
  console.log(`\n3. send with hops ${HOP_LIMIT}; hub delivery would make it ${HOP_LIMIT + 1}`);
  const edge = await A.send({ to: addrB, type: "chat", body: `${tag}: edge hops 5`, hops: HOP_LIMIT });
  let state: string | null = null;
  let reason: string | null = null;
  const end = Date.now() + TIMEOUT_MS;
  while (Date.now() < end) {
    try {
      const msgs = await A.messages({ address: addrA, limit: 100 });
      const m = msgs.find((x) => x.id === edge.id);
      if (m) {
        state = m.state;
        reason = m.drop_reason;
        if (m.state !== "accepted") break;
      }
    } catch (err) {
      if (!(err instanceof DaemonError)) throw err;
    }
    await sleep(300);
  }
  check(state === "dropped" && reason === "hop_limit", `hub stored ${edge.id} as state=${state} drop_reason=${reason}`);
  const leaked = (await B.inbox({ agent: AGENT, limit: 500 })).some((i) => i.envelope.id === edge.id);
  check(!leaked, `edge message did not reach ${addrB}`);

  // tidy: mark the test messages handled, including the daemon's rejection note for the edge message
  const notes = (await A.inbox({ agent: AGENT, unhandled: true, limit: 500 })).filter((i) => i.envelope.reply_to === edge.id);
  for (const n of notes) toAck.push([A, n.envelope.id]);
  for (const [c, id] of toAck) await c.ack(id).catch(() => {});

  console.log(`\n${failures === 0 ? "LOOP TEST PASSED" : `LOOP TEST FAILED (${failures})`} — see orchestrator/logs/orchestrator-<user>.log for msg.dropped lines`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`loop test error: ${(err as Error).message}`);
  process.exit(2);
});
