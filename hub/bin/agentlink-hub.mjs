#!/usr/bin/env node
// People admin for the hub on this laptop (contracts/hub-api.md "People"). Run it as ~/agentlink/bin/agentlink-hub.
//
//   agentlink-hub invite <user>    give <user> access; prints their personal token once and the join command
//   agentlink-hub revoke <user>    their token stops working and they are disconnected now
//   agentlink-hub list             who is invited, revoked, connected
//
// It talks to the hub at 127.0.0.1 with the master token (Authorization: Admin <master>); the hub only accepts
// that from loopback. Master token: AGENTLINK_TOKEN, else <data>/.token. Hub port: --port, AGENTLINK_HUB_PORT,
// <data>/local.env, else 7700. <data> = AGENTLINK_DATA_DIR or <repo>/data. No dependencies.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATA = process.env.AGENTLINK_DATA_DIR || path.join(ROOT, "data");
const USER_RE = /^[a-z0-9_-]{1,32}$/;

function die(msg, code = 1) {
  console.error(`agentlink-hub: ${msg}`);
  process.exit(code);
}

function fileVal(key) {
  try {
    const m = fs.readFileSync(path.join(DATA, "local.env"), "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

const args = process.argv.slice(2);
let port = process.env.AGENTLINK_HUB_PORT || "";
const pi = args.indexOf("--port");
if (pi !== -1) {
  port = args[pi + 1] || "";
  args.splice(pi, 2);
}
port ||= fileVal("AGENTLINK_HUB_PORT") || "7700";
if (!/^\d+$/.test(port)) die(`--port must be a number (got '${port}')`);
const [cmd, user] = args;

if (!cmd || cmd === "-h" || cmd === "--help") {
  console.log(`usage: agentlink-hub invite <user> | revoke <user> | list   [--port N]

  invite <user>  give <user> access to this hub. Prints their personal token (once) and the command
                 they run. Inviting someone again issues a new token and the old one stops working.
  revoke <user>  their token stops working and they are disconnected at once.
  list           everyone invited, with state.`);
  process.exit(cmd ? 0 : 1);
}

let master = process.env.AGENTLINK_TOKEN || "";
if (!master) {
  try {
    master = fs.readFileSync(path.join(DATA, ".token"), "utf8").trim();
  } catch {}
}
if (!master) die(`no master token: run this on the hub laptop (it reads ${path.join(DATA, ".token")}), or set AGENTLINK_TOKEN`);

async function call(method, p, body) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { authorization: `Admin ${master}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    die(`no hub answering on 127.0.0.1:${port}; is it running on this laptop? (scripts/team-up.sh --host-hub)`, 2);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: text };
  }
  if (res.status === 401) die("the hub refused the master token; is this the hub laptop's data folder?");
  if (!res.ok) die(json.detail || json.error || `HTTP ${res.status}`);
  return json;
}

/** This laptop's LAN IPv4 addresses, Wi-Fi/Ethernet (en*) first. */
function lanIps() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === "IPv4" && !a.internal) out.push({ name, ip: a.address });
  }
  out.sort((a, b) => Number(b.name.startsWith("en")) - Number(a.name.startsWith("en")));
  return out.map((x) => x.ip);
}

if (cmd === "invite") {
  if (!user || !USER_RE.test(user)) die("invite needs a user name: lowercase letters, digits, - or _ (up to 32)");
  const r = await call("POST", "/api/admin/people", { user });
  const ip = lanIps()[0];
  const url = `http://${ip || "<this laptop's IP>"}:${port}`;
  console.log(`${r.reinvited ? "re-invited" : "invited"} ${user}${r.reinvited ? " (their old token no longer works; anything of theirs that was connected was disconnected)" : ""}

  token   ${r.token}
          (shown only this once; send it to ${user} privately, never in a public channel)

On ${user}'s laptop, with a copy of the project (see SETUP.md) and npm install done:

  scripts/team-up.sh --user ${user} --join ${r.hub_id} --hub-url ${url}

It asks for the token; paste it there. The token only works for the user name ${user}.
Undo with: bin/agentlink-hub revoke ${user}`);
} else if (cmd === "revoke") {
  if (!user || !USER_RE.test(user)) die("revoke needs a user name");
  await call("POST", `/api/admin/people/${encodeURIComponent(user)}/revoke`);
  console.log(`revoked ${user}: their token no longer works and they were disconnected. Invite again to give them a new token.`);
} else if (cmd === "list") {
  const r = await call("GET", "/api/admin/people");
  console.log(`hub ${r.hub_name} (id ${r.hub_id}), owner ${r.owner} (master token)`);
  if (!r.people.length) console.log("  nobody invited yet: bin/agentlink-hub invite <user>");
  for (const p of r.people) {
    const state = p.revoked_at ? `revoked ${p.revoked_at}` : p.connected ? "connected" : "invited, not connected";
    console.log(`  ${p.user.padEnd(16)} ${state.padEnd(36)} invited ${p.invited_at}${p.epoch > 1 ? ` (token #${p.epoch})` : ""}`);
  }
} else {
  die(`unknown command '${cmd}' (invite | revoke | list)`);
}
