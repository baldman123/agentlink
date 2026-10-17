"use client";
// Owner only: make a code for a name (shown once), see who is online, revoke. The API enforces owner-only;
// this page just says so instead of showing an empty list.
import { useCallback, useEffect, useState } from "react";
import { ApiError, getMe, invitePerson, listPeople, revokePerson, signOut, type Invite, type Person } from "../lib/client/api.ts";
import { Brand } from "./Brand.tsx";

const NAME_RE = /^[a-z0-9_-]{1,32}$/;

function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.code === "owner_only" ? "Only the owner can do that." : e.message;
  return "Can't reach agentlink. Try again.";
}

export function AdminPage() {
  const [state, setState] = useState<"loading" | "owner" | "not_owner" | "error">("loading");
  const [owner, setOwner] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<{ user: string; action: "revoke" | "reinvite" } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const r = await listPeople();
      setOwner(r.owner);
      setPeople(r.people);
      setNow(Date.now());
    } catch (e) {
      if (e instanceof ApiError && e.signedOut) return void signOut(e.code === "revoked" ? "revoked" : undefined);
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    getMe()
      .then((me) => {
        if (!me.owner) return setState("not_owner");
        setState("owner");
        void load();
      })
      .catch((e) => {
        if (e instanceof ApiError && e.signedOut) return void signOut(e.code === "revoked" ? "revoked" : undefined);
        setState("error");
      });
  }, [load]);

  // online / last seen stay fresh while the page is open
  useEffect(() => {
    if (state !== "owner") return;
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [state, load]);

  const create = async (user: string) => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setInvite(await invitePerson(user));
      setName("");
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (user: string) => {
    setBusy(true);
    setError(null);
    try {
      await revokePerson(user);
      if (invite?.user === user) setInvite(null);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.code);
      setCopied(true);
    } catch {
      setCopied(false);
      setError("Copy didn't work here; select the code and copy it by hand.");
    }
  };

  const clean = name.trim().toLowerCase();
  const nameOk = NAME_RE.test(clean);
  const taken = people.find((p) => p.user === clean);

  return (
    <div className="admin">
      <header className="topbar">
        <Brand />
        <span className="grow" />
        <a className="navlink" href="/">
          Back to the app
        </a>
        <button className="btn btn-ghost" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      <main className="admin-main">
        <h1>People</h1>
        {state === "loading" && <div className="skeleton" aria-busy="true"><span style={{ width: "70%" }} /><span style={{ width: "50%" }} /></div>}
        {state === "error" && (
          <div className="empty" role="alert">
            <strong>Can&apos;t reach agentlink right now.</strong>
            <span>Check your connection, then try again.</span>
            <button className="btn" onClick={() => location.reload()}>
              Try again
            </button>
          </div>
        )}
        {state === "not_owner" && (
          <div className="empty">
            <strong>Only Bryant manages people.</strong>
            <span>Your code lets you use the app, not hand out codes.</span>
          </div>
        )}
        {state === "owner" && (
          <>
            <section className="card" aria-labelledby="new-h">
              <h2 id="new-h">New access code</h2>
              <form
                className="invite-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!nameOk || busy || clean === owner) return;
                  if (taken && !taken.revoked_at) return setConfirm({ user: clean, action: "reinvite" });
                  void create(clean);
                }}
              >
                <input
                  className="code-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="their name, e.g. sam"
                  aria-label="Name"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={32}
                />
                <button className="btn btn-primary" type="submit" disabled={!nameOk || busy || clean === owner}>
                  {taken ? "Make a new code" : "Create code"}
                </button>
              </form>
              <div className="form-error" role="alert">
                {error ??
                  (name && !nameOk
                    ? "Lowercase letters, digits, - and _ only, up to 32."
                    : clean === owner
                      ? "That's you; your code is the master code."
                      : taken && !taken.revoked_at
                        ? `${clean} already has a code. A new one turns the old one off.`
                        : "")}
              </div>
              {invite && (
                <div className="reveal" role="status">
                  <span className="reveal-note">
                    Code for <strong>{invite.user}</strong>
                    {invite.reinvited ? " (their old code no longer works)" : ""}. It&apos;s shown only now; copy it and send it to them.
                  </span>
                  <code className="reveal-code" data-testid="new-code">{invite.code}</code>
                  <div className="row">
                    <button className="btn btn-primary" onClick={copy}>
                      {copied ? "Copied" : "Copy"}
                    </button>
                    <button className="btn btn-ghost" onClick={() => setInvite(null)}>
                      Done
                    </button>
                  </div>
                </div>
              )}
            </section>

            <section className="card" aria-labelledby="people-h">
              <h2 id="people-h">Everyone</h2>
              {people.length === 0 ? (
                <div className="empty small">Nobody yet. Make a code above.</div>
              ) : (
                <ul className="people">
                  {[...people]
                    .sort((a, b) => Number(!!a.revoked_at) - Number(!!b.revoked_at) || Number(b.connected) - Number(a.connected) || a.user.localeCompare(b.user))
                    .map((p) => (
                      <li key={p.user} className={`person ${p.revoked_at ? "revoked" : ""}`} data-testid={`person-${p.user}`}>
                        <div className="person-main">
                          <span className="person-name">{p.user}</span>
                          <span className="person-meta">
                            {p.revoked_at
                              ? `turned off ${ago(p.revoked_at, now)}`
                              : p.connected
                                ? "online now"
                                : p.last_seen
                                  ? `last seen ${ago(p.last_seen, now)}`
                                  : "hasn't signed in yet"}
                          </span>
                        </div>
                        <span className="person-tags">
                          {p.user === owner && <span className="tag tag-owner">owner</span>}
                          {p.connected && !p.revoked_at && <span className="tag tag-online">online</span>}
                        </span>
                        {p.user !== owner &&
                          (p.revoked_at ? (
                            <button className="btn" disabled={busy} onClick={() => void create(p.user)}>
                              New code
                            </button>
                          ) : (
                            <button className="btn btn-danger" disabled={busy} onClick={() => setConfirm({ user: p.user, action: "revoke" })}>
                              Revoke
                            </button>
                          ))}
                      </li>
                    ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
      {confirm && (
        <div className="scrim" onMouseDown={() => setConfirm(null)}>
          <div className="dialog" role="alertdialog" aria-labelledby="confirm-h" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && setConfirm(null)}>
            <h2 id="confirm-h">{confirm.action === "revoke" ? `Revoke ${confirm.user}?` : `New code for ${confirm.user}?`}</h2>
            <p>
              {confirm.action === "revoke"
                ? `${confirm.user}'s code stops working now. Their open pages sign out and their laptop disconnects. You can make them a new code later.`
                : `${confirm.user}'s current code stops working now and their laptop disconnects until they use the new one.`}
            </p>
            <div className="row">
              <span className="grow" />
              <button className="btn btn-ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className={confirm.action === "revoke" ? "btn btn-danger" : "btn btn-primary"}
                autoFocus
                onClick={() => {
                  const c = confirm;
                  setConfirm(null);
                  void (c.action === "revoke" ? revoke(c.user) : create(c.user));
                }}
              >
                {confirm.action === "revoke" ? "Revoke" : "Make new code"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
