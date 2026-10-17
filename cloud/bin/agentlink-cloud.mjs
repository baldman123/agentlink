#!/usr/bin/env node
// People admin for the agentlink cloud (contracts/cloud-api.md "People"). Run it as ~/agentlink/bin/agentlink-cloud.
//
//   agentlink-cloud invite <user>    give <user> access; prints their access code once and how they join
//   agentlink-cloud revoke <user>    their code stops working; their daemon and browser are signed out now
//   agentlink-cloud list             who is invited, revoked, online
//
// Signs in with the master code (AGENTLINK_MASTER_CODE, else asked for on the terminal) at the site in
// AGENTLINK_CLOUD_URL (or --url). The code is sent only to that site, over https unless it's localhost. No dependencies.
import { createInterface } from "node:readline";

const USER_RE = /^[a-z0-9_-]{1,32}$/;

function die(msg, code = 1) {
  console.error(`agentlink-cloud: ${msg}`);
  process.exit(code);
}

const args = process.argv.slice(2);
let url = process.env.AGENTLINK_CLOUD_URL || "";
const ui = args.indexOf("--url");
if (ui !== -1) {
  url = args[ui + 1] || "";
  args.splice(ui, 2);
}
const [cmd, user] = args;

if (!cmd || cmd === "-h" || cmd === "--help") {
  console.log(`usage: agentlink-cloud invite <user> | revoke <user> | list   [--url https://<app>.vercel.app]

  invite <user>  give <user> access. Prints their access code (once) and what they run. Inviting someone
                 again issues a new code; the old one stops working at once.
  revoke <user>  their code stops working and their daemon and browser are signed out.
  list           everyone invited, with state.

Needs AGENTLINK_CLOUD_URL (or --url) and the master code (AGENTLINK_MASTER_CODE, or typed when asked).`);
  process.exit(cmd ? 0 : 1);
}

url = url.replace(/\/+$/, "");
let parsed;
try {
  parsed = new URL(url);
} catch {
  die("set AGENTLINK_CLOUD_URL (or --url) to the site, e.g. https://agentlink-xyz.vercel.app");
}
const local = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
if (parsed.protocol !== "https:" && !local) die("refusing to send the master code over plain http to a non-local site");

async function askHidden(prompt) {
  if (!process.stdin.isTTY) return "";
  process.stdout.write(prompt);
  const rl = createInterface({ input: process.stdin, terminal: true });
  rl._writeToOutput = () => {}; // don't echo
  const answer = await new Promise((r) => rl.question("", r));
  rl.close();
  process.stdout.write("\n");
  return answer.trim();
}

async function api(method, path, { bearer, body } = {}) {
  let res;
  try {
    res = await fetch(`${url}${path}`, {
      method,
      headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    die(`can't reach ${url} (${e.cause?.code ?? e.message})`, 2);
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text.slice(0, 200) };
  }
  return { status: res.status, body: json };
}

const master = process.env.AGENTLINK_MASTER_CODE || (await askHidden("master code: "));
if (!master) die("no master code: set AGENTLINK_MASTER_CODE or run this in a terminal to be asked");

const login = await api("POST", "/api/auth/login", { body: { code: master } });
if (login.status === 429) die(`too many failed sign-ins from here; try again in ${login.body.retry_after_s ?? 900}s`);
if (login.status !== 200) die(login.body.error === "bad_code" ? "the site refused the master code" : `sign-in failed: HTTP ${login.status} ${login.body.error ?? ""}`);
if (!login.body.owner) die("that code isn't the master code (it signs in as a regular person)");
const session = login.body.session;

if (cmd === "invite") {
  if (!user || !USER_RE.test(user)) die("invite needs a user name: lowercase letters, digits, - or _ (up to 32)");
  const r = await api("POST", "/api/admin/people", { bearer: session, body: { user } });
  if (r.status !== 200) die(r.body.detail || r.body.error || `HTTP ${r.status}`);
  console.log(`${r.body.reinvited ? "re-invited" : "invited"} ${user}${r.body.reinvited ? " (their old code no longer works; anything signed in with it was signed out)" : ""}

  code   ${r.body.code}
         (shown only this once; send it to ${user} privately, never in a public channel)

${user} can sign in on the website with it: ${url}/login
To connect ${user}'s claude4 team, on their laptop (with a copy of agentlink and npm install done):

  AGENTLINK_HUB_URL=${url} scripts/team-up.sh --user ${user}

and paste the code when it asks for the token. The code only works for the name ${user}.
Undo with: bin/agentlink-cloud revoke ${user}`);
} else if (cmd === "revoke") {
  if (!user || !USER_RE.test(user)) die("revoke needs a user name");
  const r = await api("POST", `/api/admin/people/${encodeURIComponent(user)}/revoke`, { bearer: session });
  if (r.status === 404) die(`${user} is not an active invitee`);
  if (r.status !== 200) die(r.body.detail || r.body.error || `HTTP ${r.status}`);
  console.log(`revoked ${user}: their code no longer works and they were signed out. Invite again to give them a new code.`);
} else if (cmd === "list") {
  const r = await api("GET", "/api/admin/people", { bearer: session });
  if (r.status !== 200) die(r.body.error || `HTTP ${r.status}`);
  console.log(`${url}  owner ${r.body.owner} (master code)`);
  if (!r.body.people.length) console.log("  nobody invited yet: bin/agentlink-cloud invite <user>");
  for (const p of r.body.people) {
    const state = p.revoked_at ? `revoked ${p.revoked_at}` : p.connected ? "online" : `invited${p.last_seen ? `, last seen ${p.last_seen}` : ", never connected"}`;
    console.log(`  ${p.user.padEnd(16)} ${state.padEnd(44)} invited ${p.invited_at}${p.epoch > 1 ? ` (code #${p.epoch})` : ""}`);
  }
} else {
  die(`unknown command '${cmd}' (invite | revoke | list)`);
}
