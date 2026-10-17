import { getDeps } from "../../../../lib/server/deps.ts";
import { newCode, sha256hex } from "../../../../lib/server/crypto.ts";
import { authenticate, HttpError, json, log, readJson, route, USER_RE, type Caller } from "../../../../lib/server/http.ts";
import { isOnline } from "../../../../lib/server/logic.ts";

function ownerOnly(c: Caller): void {
  if (!c.owner) throw new HttpError(403, "owner_only");
}

export const GET = route(async (req) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  ownerOnly(caller);
  const now = d.now();
  const people = (await d.store.listPeople())
    .filter((p) => !p.is_owner)
    .map((p) => ({
      user: p.username, epoch: p.epoch, created_at: p.created_at, invited_at: p.invited_at,
      revoked_at: p.revoked_at, last_seen: p.last_seen, connected: !p.revoked_at && isOnline(p, now),
    }));
  return json(200, { owner: d.env.owner, people });
});

/** Invite (or re-invite) a person: returns their new access code, shown only here. */
export const POST = route(async (req) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  ownerOnly(caller);
  const { user } = await readJson<{ user?: unknown }>(req, 4096);
  if (typeof user !== "string" || !USER_RE.test(user)) throw new HttpError(400, "bad_user", "lowercase letters, digits, - or _; up to 32");
  if (user === d.env.owner) throw new HttpError(400, "owner", "the owner signs in with the master code");
  const code = newCode();
  const { row, reinvited } = await d.store.invitePerson(user, sha256hex(code));
  // A re-invite kills the old code (its epoch no longer matches); tell any client still on it.
  if (reinvited) await d.broadcaster.send(`user:${user}`, "revoked", { user, at: new Date(d.now()).toISOString() }).catch(() => {});
  log("person.invited", { user, epoch: row.epoch, reinvited });
  return json(200, { user, code, epoch: row.epoch, reinvited });
});
