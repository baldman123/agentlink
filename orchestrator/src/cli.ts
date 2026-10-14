// agentlink CLI — talks to the local daemon (127.0.0.1:7701 by default).
// Remote messages are shown as untrusted REQUESTS; nothing in a message is ever executed.

import { HOP_LIMIT, type ContextKind, type InboxItem, type MessageType, type RichBody, type SessionStatus } from "../../contracts/index.ts";
import { CONTEXT_KINDS, DaemonClient, DaemonError, HopLimitError, MESSAGE_TYPES, SESSION_STATUSES } from "./client.ts";
import {
  approvalState,
  bodyToText,
  decide,
  formatContext,
  formatItem,
  formatPeers,
  forwardBlockReason,
  isUntrusted,
  itemToJson,
  loadDecisions,
  recordReplyDecision,
  verifiedReplies,
  type DecisionRecord,
} from "./trust.ts";

/** One line per item: id8, type, from → to, trust/approval, body start (JSON-quoted so it can't fake a line). */
function briefLine(it: InboxItem, d: DecisionRecord | undefined, verified: boolean): string {
  const e = it.envelope;
  const trust = isUntrusted(it) ? `REMOTE:${approvalState(e, d, verified)}` : "local";
  const text = bodyToText(e.body).replace(/\s+/g, " ").trim();
  const snippet = JSON.stringify(text.length > 70 ? text.slice(0, 69) + "…" : text);
  return `${e.id.slice(0, 8)}  ${e.type.padEnd(14)} ${e.from} → ${e.to}  ${trust}${it.handled ? " [handled]" : ""}  ${snippet}`;
}

const HELP = `agentlink — orchestrator CLI for the local agentlink daemon

Usage: agentlink <command> [args] [--daemon URL | --port N] [--json]

  send <to> <type> <body|->     send a message (type: ${MESSAGE_TYPES.join("|")}); "-" reads body from stdin
       [--reply-to ID] [--from AGENT] [--rich]   --rich parses body as a JSON RichBody
  inbox [--agent A] [--all] [--watch] [--brief] unhandled items (--all includes handled; --watch streams new ones;
                                 --brief prints one line per item)
  reply <id> <text|->            answer an item: sends a result to its sender with reply_to set, records approval
                                 if it was a pending remote request, and marks it handled
  ack <id>                       mark an inbox item handled
  forward <id> <to> [--note TEXT] relay a received message (hops+1; refused when > ${HOP_LIMIT})
  approve <id> [--note TEXT]     record the local user's approval of a remote request and tell the requester
  decline <id> [reason]          record a decline and send the reason back

  <id> may be the full id or a unique prefix of at least 4 characters (the bridge pastes 8).
  The sender is --from AGENT, else $AGENTLINK_AGENT, else "orchestrator".
  ctx list [query]               list shared context entries
  ctx get <key>
  ctx set <key> --title T --kind ${CONTEXT_KINDS.join("|")} [--body B | stdin] [--base-version N]
  peers                          users and sessions known to the hub
  status <${SESSION_STATUSES.filter((s) => s !== "offline").join("|")}> [task] [--agent A]
  health                         daemon + hub link state
  outbox                         messages waiting to reach the hub

Env: AGENTLINK_DAEMON_URL or AGENTLINK_DAEMON_PORT (default 7701), AGENTLINK_AGENT (default "orchestrator").`;

interface Parsed {
  pos: string[];
  flags: Record<string, string | true>;
}

const BOOL_FLAGS = new Set(["all", "watch", "json", "rich", "brief", "help", "h"]);

function parseArgs(argv: string[]): Parsed {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--") || (a.startsWith("-") && a.length === 2 && isNaN(Number(a)))) {
      const raw = a.replace(/^--?/, "");
      const eq = raw.indexOf("=");
      if (eq >= 0) flags[raw.slice(0, eq)] = raw.slice(eq + 1);
      else if (BOOL_FLAGS.has(raw) || i + 1 >= argv.length) flags[raw] = true;
      else flags[raw] = argv[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

function str(f: Parsed["flags"], k: string): string | undefined {
  const v = f[k];
  return typeof v === "string" ? v : undefined;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function out(json: boolean, data: unknown, text: string) {
  process.stdout.write((json ? JSON.stringify(data, null, 2) : text) + "\n");
}

function fail(msg: string, code = 1): never {
  process.stderr.write(`agentlink: ${msg}\n`);
  process.exit(code);
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...args] = pos;
  const json = flags.json === true;
  if (!cmd || flags.help || flags.h || cmd === "help") {
    out(false, null, HELP);
    return;
  }
  const baseUrl = str(flags, "daemon") ?? (str(flags, "port") ? `http://127.0.0.1:${str(flags, "port")}` : undefined);
  // sender: --from, else AGENTLINK_AGENT, else "orchestrator" (DaemonClient falls back to the env var)
  const client = new DaemonClient({ baseUrl, agent: str(flags, "from") });
  // local.env (via bin/agentlink) names the user; refuse to act as someone else if the port points at another daemon
  const expectedUser = process.env.AGENTLINK_USER;
  if (expectedUser) {
    const actual = await client.getUser();
    if (actual !== expectedUser) fail(`daemon at ${client.baseUrl} belongs to "${actual}", but AGENTLINK_USER is "${expectedUser}"; check data/local.env or --port`);
  }

  switch (cmd) {
    case "send": {
      const [to, type, bodyArg] = args;
      if (!to || !type || bodyArg === undefined) fail("usage: send <to> <type> <body|->");
      if (!MESSAGE_TYPES.includes(type as MessageType)) fail(`type must be one of ${MESSAGE_TYPES.join(", ")}`);
      const raw = bodyArg === "-" ? (await readStdin()).replace(/\n$/, "") : bodyArg;
      let body: string | RichBody = raw;
      if (flags.rich) {
        try {
          body = JSON.parse(raw) as RichBody;
        } catch {
          fail("--rich body is not valid JSON");
        }
      }
      const res = await client.send({ to, type: type as MessageType, body, reply_to: str(flags, "reply-to") ?? null, from_agent: str(flags, "from") });
      out(json, res, `queued ${res.id} → ${to}`);
      return;
    }

    case "inbox": {
      const agent = str(flags, "agent");
      const user = await client.getUser();
      const print = async (items: InboxItem[]) => {
        const decisions = loadDecisions(user);
        const replies = await verifiedReplies(client, items);
        for (const it of items) {
          const d = decisions.get(it.envelope.id);
          const v = replies.has(it.envelope.id);
          if (json) process.stdout.write(JSON.stringify(itemToJson(it, d, v)) + "\n");
          else if (flags.brief === true) process.stdout.write(briefLine(it, d, v) + "\n");
          else process.stdout.write(formatItem(it, d, v) + "\n");
        }
      };
      const items = await client.inbox({ agent, unhandled: flags.all !== true, limit: 100 });
      if (!items.length && !json && flags.watch !== true) process.stdout.write(flags.all ? "inbox empty\n" : "no unhandled messages\n");
      await print(items);
      if (flags.watch === true) {
        if (!json) process.stderr.write(`watching inbox${agent ? ` of ${agent}` : ""} (ctrl-c to stop)…\n`);
        const ac = new AbortController();
        process.on("SIGINT", () => {
          ac.abort();
          process.exit(0);
        });
        const seen = new Set(items.map((i) => i.envelope.id));
        // reconnect forever; the daemon may restart
        for (;;) {
          try {
            await client.stream(
              async (it) => {
                if (seen.has(it.envelope.id)) return;
                seen.add(it.envelope.id);
                await print([it]);
              },
              { agent, signal: ac.signal },
            );
          } catch (err) {
            process.stderr.write(`stream error: ${(err as Error).message}; retrying in 2s\n`);
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      return;
    }

    case "reply": {
      const [ref, textArg] = args;
      if (!ref || textArg === undefined) fail('usage: reply <id> "<text>"  ("-" reads the text from stdin)');
      const text = textArg === "-" ? (await readStdin()).replace(/\n$/, "") : args.slice(1).join(" ");
      if (!text.trim()) fail("reply text is empty");
      const item = await client.resolveInboxItem(ref);
      const e = item.envelope;
      const user = await client.getUser();
      const prior = loadDecisions(user).get(e.id);
      if (prior?.decision === "declined") fail(`${e.id} was declined by ${prior.by} at ${prior.at}; not replying`);
      if (e.from.split("/")[0] === user && e.from.split("/")[1] === "agentlink") fail(`${e.id} is a local daemon note; nothing to reply to (ack it instead)`);
      const verified = (await verifiedReplies(client, [item])).has(e.id);
      // hops: send() sees reply_to in this inbox and uses original.hops + 1, refusing past the limit
      const res = await client.send({ to: e.from, type: "result", body: text, reply_to: e.id, from_agent: str(flags, "from") });
      const recorded = recordReplyDecision(user, item, res.id, { verifiedReply: verified });
      await client.ack(e.id);
      out(
        json,
        { id: res.id, to: e.from, reply_to: e.id, approval_recorded: !!recorded, handled: true },
        `replied to ${e.id.slice(0, 8)} (${e.from}) with result ${res.id}; ${recorded ? "recorded as approved, " : ""}marked handled`,
      );
      return;
    }

    case "ack": {
      if (!args[0]) fail("usage: ack <id>");
      const id = (await client.resolveInboxItem(args[0])).envelope.id;
      await client.ack(id);
      out(json, { ok: true, id }, `acked ${id}`);
      return;
    }

    case "forward": {
      const [ref, to] = args;
      if (!ref || !to) fail("usage: forward <id> <to>");
      const item = await client.resolveInboxItem(ref);
      const id = item.envelope.id;
      const verified = (await verifiedReplies(client, [item])).has(id);
      const blocked = forwardBlockReason(item, loadDecisions(await client.getUser()).get(id), verified);
      if (blocked) fail(blocked);
      const res = await client.forward(item.envelope, to, { from_agent: str(flags, "from"), note: str(flags, "note") });
      out(json, res, `forwarded ${id} → ${to} as ${res.id} (hops ${item.envelope.hops + 1})`);
      return;
    }

    case "approve":
    case "decline": {
      const [ref, ...rest] = args;
      if (!ref) fail(`usage: ${cmd} <id> ${cmd === "decline" ? "[reason]" : "[--note TEXT]"}`);
      const id = (await client.resolveInboxItem(ref)).envelope.id;
      const reason = cmd === "decline" ? rest.join(" ") || str(flags, "reason") : str(flags, "note");
      const { record, item, reply_error } = await decide(client, id, cmd === "approve" ? "approved" : "declined", { reason, from_agent: str(flags, "from") });
      const who = item.envelope.from;
      const told = reply_error
        ? `recorded, but could not tell ${who}: ${reply_error}`
        : cmd === "approve"
          ? `told ${who} work may start (status ${record.reply_id})`
          : `sent result ${record.reply_id} to ${who}${record.reason ? ` with reason "${record.reason}"` : ""}`;
      out(
        json,
        { ...record, reply_error },
        cmd === "approve"
          ? `approved ${id}; ${told}. Nothing was run automatically — do the work, send a result with --reply-to ${id}, then ack it.${item.remote ? "" : "\n(note: this was a local message)"}`
          : `declined ${id}; ${told}; item acked.`,
      );
      return;
    }

    case "ctx": {
      const [sub, key] = args;
      if (sub === "list") {
        const entries = await client.contextList(key);
        out(
          json,
          entries,
          entries.length
            ? entries.map((e) => `${e.key}  v${e.version}  [${e.kind}]  ${JSON.stringify(e.title)}  — ${e.author} ${e.updated_at}`).join("\n")
            : "no context entries",
        );
      } else if (sub === "get") {
        if (!key) fail("usage: ctx get <key>");
        const e = await client.contextGet(key);
        out(json, e, formatContext(e, await client.getUser()));
      } else if (sub === "set") {
        if (!key) fail("usage: ctx set <key> --title T --kind K [--body B | stdin]");
        const title = str(flags, "title");
        const kind = (str(flags, "kind") ?? "note") as ContextKind;
        if (!title) fail("--title is required");
        if (!CONTEXT_KINDS.includes(kind)) fail(`--kind must be one of ${CONTEXT_KINDS.join(", ")}`);
        const body = str(flags, "body") ?? (await readStdin());
        const bv = str(flags, "base-version");
        const e = await client.contextSet(key, { title, kind, body, base_version: bv ? Number(bv) : undefined, agent: str(flags, "agent") });
        out(json, e, `saved ${e.key} v${e.version}`);
      } else fail("usage: ctx list|get <key>|set <key> ...");
      return;
    }

    case "peers": {
      const users = await client.peers();
      out(json, users, formatPeers(users, await client.getUser()));
      return;
    }

    case "status": {
      const [status, ...task] = args;
      const allowed = SESSION_STATUSES.filter((s) => s !== "offline");
      if (!(allowed as string[]).includes(status)) fail(`usage: status <${allowed.join("|")}> [task]`);
      const agent = str(flags, "agent") ?? client.defaultAgent;
      const s = await client.setSession(agent, { status: status as SessionStatus, task: task.join(" ") });
      out(json, s, `${s.address ?? agent}: ${s.status}${s.task ? ` — ${s.task}` : ""}`);
      return;
    }

    case "health": {
      const h = await client.health();
      out(
        json,
        h,
        `daemon ${client.baseUrl}  user ${h.user}\nhub: ${h.hub.state}${h.hub.url ? ` ${h.hub.url}` : ""}${h.hub.via ? ` via ${h.hub.via}` : ""}${h.hub.hub_name ? ` (${h.hub.hub_name})` : ""}\noutbox ${h.outbox_depth}  inbox unhandled ${h.inbox_unhandled}`,
      );
      return;
    }

    case "outbox": {
      const items = await client.outbox();
      out(
        json,
        items,
        items.length
          ? items.map((i) => `${i.envelope.id} → ${i.envelope.to} [${i.envelope.type}] attempts ${i.attempts}${i.last_error ? ` err: ${i.last_error}` : ""}`).join("\n")
          : "outbox empty",
      );
      return;
    }

    default:
      fail(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

main().catch((err) => {
  if (err instanceof HopLimitError) fail(err.message, 3);
  if (err instanceof DaemonError) fail(err.message, err.status === 0 ? 2 : 1);
  fail((err as Error).message);
});
