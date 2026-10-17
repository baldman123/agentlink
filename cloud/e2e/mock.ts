// A stand-in for contracts/cloud-api.md in the browser: page.route answers /api/**, and an init script
// installs window.__AL_FAKE_REALTIME__ (lib/client/realtime.ts) so tests can push Realtime events.
import type { BrowserContext, Page, Route } from "@playwright/test";

export const OWNER = "bryant";
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

export interface MockPerson {
  user: string;
  epoch: number;
  created_at: string;
  invited_at: string | null;
  revoked_at: string | null;
  last_seen: string | null;
  connected: boolean;
}

function session(user: string, agent: string, status = "idle", task = "") {
  return {
    address: `${user}/${agent}`,
    user,
    agent,
    kind: agent === "orchestrator" ? "orchestrator" : "worker",
    status,
    task,
    last_activity: iso(30_000),
  };
}
const team = (user: string, busy: Record<string, string> = {}) =>
  ["orchestrator", "worker-1", "worker-2", "worker-3", "worker-4"].map((a) => session(user, a, busy[a] ? "working" : "idle", busy[a] ?? ""));

export function messageRow(m: { id: string; from: string; to: string; body: string; type?: string; reply_to?: string | null; state?: string }) {
  return {
    id: m.id,
    from_addr: m.from,
    to_addr: m.to,
    from_user: m.from.split("/")[0],
    to_user: m.to.split("/")[0],
    reply_to: m.reply_to ?? null,
    hops: 1,
    type: m.type ?? "chat",
    body: m.body,
    timestamp: iso(),
    state: m.state ?? "accepted",
    accepted_at: iso(),
    delivered_at: null,
    drop_reason: null,
  };
}

/** A row of GET /api/calls (contracts/calls.ts). */
export function callRow(c: { id: string; summary: string; kind?: "permission" | "question"; why?: string | null; details?: string; from?: string; minsAgo?: number }) {
  return {
    id: c.id,
    kind: c.kind ?? "permission",
    summary: c.summary,
    details: c.details ?? "",
    why: c.why ?? null,
    from: c.from ?? "the boss",
    asked_at: iso((c.minsAgo ?? 2) * 60_000),
    state: "pending" as "pending" | "answering",
    answer: null as { choice: "yes" | "no" | null; note: string } | null,
    answered_at: null as string | null,
  };
}

export class MockCloud {
  me = { user: OWNER, owner: true };
  validCodes = new Map<string, { user: string; owner: boolean }>([["alc_master", { user: OWNER, owner: true }]]);
  people: MockPerson[] = [
    { user: OWNER, epoch: 0, created_at: iso(86_400_000 * 3), invited_at: null, revoked_at: null, last_seen: iso(5_000), connected: true },
    { user: "sam", epoch: 1, created_at: iso(86_400_000 * 2), invited_at: iso(86_400_000 * 2), revoked_at: null, last_seen: iso(8_000), connected: true },
    { user: "lee", epoch: 1, created_at: iso(86_400_000), invited_at: iso(86_400_000), revoked_at: null, last_seen: iso(3 * 3600_000), connected: false },
  ];
  users = [
    { user: OWNER, connected: true, sessions: team(OWNER, { "worker-1": "build the login page" }) },
    { user: "sam", connected: true, sessions: team("sam") },
  ];
  context = [{ key: "api-plan", title: "API plan", kind: "note", body: "Routes live in **cloud-api.md**.", author: `${OWNER}/orchestrator`, version: 2, updated_at: iso(60_000) }];
  messages: ReturnType<typeof messageRow>[] = [];
  sent: Record<string, unknown>[] = [];
  inputs: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  loginStatus: { status: number; body: Record<string, unknown> } | null = null; // force a login failure
  calls: string[] = [];
  yourCalls: ReturnType<typeof callRow>[] = []; // GET /api/calls; a test "delivers" an answer by removing the row
  answers: { id: string; body: Record<string, unknown> }[] = [];
  answerStatus: { status: number; body: Record<string, unknown> } | null = null; // force an answer failure

  constructor(
    private context_: BrowserContext,
    private baseURL: string,
  ) {}

  realtime() {
    return { url: "http://supabase.invalid", anon_key: "anon", jwt: "jwt-1", jwt_expires_at: new Date(Date.now() + 15 * 60_000).toISOString() };
  }

  /** Sign this browser in without the form (the proxy only looks for the cookie). */
  async signIn() {
    await this.context_.addCookies([{ name: "al_session", value: "test-session", url: this.baseURL, httpOnly: true, sameSite: "Lax" }]);
  }

  async install(page: Page) {
    await page.addInitScript(FAKE_REALTIME);
    await page.route("**/api/**", (route) => this.handle(route, page));
  }

  private json(route: Route, status: number, body?: unknown) {
    return route.fulfill({ status, contentType: "application/json", body: body === undefined ? "" : JSON.stringify(body) });
  }

  private async handle(route: Route, page: Page) {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    this.calls.push(`${method} ${path}`);
    const body = (req.postDataJSON?.() ?? {}) as Record<string, unknown>;
    const signedIn = (await this.context_.cookies(this.baseURL)).some((c) => c.name === "al_session");
    const authed = () => signedIn || path === "/api/auth/login";

    if (path === "/api/config") return this.json(route, 200, { supabase_url: "http://supabase.invalid", supabase_anon_key: "anon", hub_id: "hub-1", hub_name: "agentlink-cloud" });
    if (!authed()) return this.json(route, 401, { error: "unauthorized" });

    if (path === "/api/auth/login" && method === "POST") {
      if (this.loginStatus) return this.json(route, this.loginStatus.status, this.loginStatus.body);
      const who = this.validCodes.get(String(body.code ?? ""));
      if (!who) return this.json(route, 401, { error: "bad_code" });
      this.me = who;
      await this.signIn();
      return this.json(route, 200, { ...who, session: "s", session_expires_at: iso(-86_400_000), hub_id: "hub-1", hub_name: "agentlink-cloud", realtime: this.realtime() });
    }
    if (path === "/api/auth/logout") {
      await this.context_.clearCookies();
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/auth/refresh") return this.json(route, 200, { ...this.me, realtime: this.realtime() });
    if (path === "/api/me") return this.json(route, 200, { ...this.me, realtime: this.realtime() });
    if (path === "/api/snapshot") return this.json(route, 200, { users: this.users, context: this.context, last_seq: 0 });

    if (path === "/api/messages" && method === "GET") {
      const a = url.searchParams.get("address") ?? "";
      const list = this.messages.filter((m) => m.from_addr === a || m.to_addr === a || m.to_addr === "*").reverse();
      return this.json(route, 200, {
        messages: list.map((m) => ({ ...m, from: m.from_addr, to: m.to_addr })),
      });
    }
    if (path === "/api/messages" && method === "POST") {
      this.sent.push(body);
      const id = `m${this.sent.length}-${Math.random().toString(36).slice(2, 8)}`;
      const row = messageRow({ id, from: `${this.me.user}/${String(body.from_agent ?? "human")}`, to: String(body.to), body: String(body.body), type: String(body.type ?? "chat") });
      this.messages.push(row);
      await this.json(route, 200, { id, accepted: true });
      await page.evaluate((r) => window.__rt?.db({ table: "messages", type: "INSERT", row: r }), row);
      return;
    }

    if (path === "/api/panes/input" && method === "POST") {
      this.inputs.push({ headers: req.headers(), body });
      return this.json(route, 202, { id: `in${this.inputs.length}` });
    }
    const inp = path.match(/^\/api\/panes\/input\/(.+)$/);
    if (inp) {
      const i = this.inputs[Number(inp[1].slice(2)) - 1];
      const agents = (i?.body.agents as string[]) ?? [];
      return this.json(route, 200, { id: inp[1], state: "done", results: Object.fromEntries(agents.map((a) => [a, "sent"])) });
    }

    if (path === "/api/calls" && method === "GET") return this.json(route, 200, { calls: this.yourCalls });
    const ans = path.match(/^\/api\/calls\/([^/]+)\/answer$/);
    if (ans && method === "POST") {
      this.answers.push({ id: decodeURIComponent(ans[1]), body });
      if (this.answerStatus) return this.json(route, this.answerStatus.status, this.answerStatus.body);
      const c = this.yourCalls.find((x) => x.id === decodeURIComponent(ans[1]));
      if (!c) return this.json(route, 404, { error: "not_found" });
      if (c.state !== "pending") return this.json(route, 409, { error: "already_answered" });
      const choice = body.choice === "yes" || body.choice === "no" ? body.choice : null;
      const note = typeof body.note === "string" ? body.note : "";
      if (!choice && !(c.kind === "question" && note)) return this.json(route, 400, { error: "bad_answer" });
      Object.assign(c, { state: "answering", answer: { choice, note }, answered_at: iso() });
      return this.json(route, 200, { call: c });
    }

    if (path.startsWith("/api/admin/")) {
      if (!this.me.owner) return this.json(route, 403, { error: "owner_only" });
      if (path === "/api/admin/people" && method === "GET") return this.json(route, 200, { owner: OWNER, people: this.people });
      if (path === "/api/admin/people" && method === "POST") {
        const user = String(body.user);
        const code = `alc_${user}_${Math.random().toString(36).slice(2, 12)}`;
        const old = this.people.find((p) => p.user === user);
        const reinvited = !!old;
        if (old) Object.assign(old, { epoch: old.epoch + 1, revoked_at: null, invited_at: iso() });
        else this.people.push({ user, epoch: 1, created_at: iso(), invited_at: iso(), revoked_at: null, last_seen: null, connected: false });
        this.validCodes.set(code, { user, owner: false });
        return this.json(route, 200, { user, code, epoch: 1, reinvited });
      }
      const rv = path.match(/^\/api\/admin\/people\/([^/]+)\/revoke$/);
      if (rv && method === "POST") {
        const p = this.people.find((x) => x.user === decodeURIComponent(rv[1]));
        if (!p) return this.json(route, 404, { error: "not_found" });
        p.revoked_at = iso();
        p.connected = false;
        return this.json(route, 200, { ok: true, user: p.user });
      }
    }
    return this.json(route, 404, { error: "not_mocked", detail: `${method} ${path}` });
  }
}

declare global {
  interface Window {
    __rt?: {
      db(c: unknown): void;
      status(s: string): void;
      presence(entries: unknown[]): void;
      screen(event: string, payload: unknown): void;
      revoke(): void;
      watching: string[];
      jwt: string;
    };
  }
}

/** Runs in the page before any app code. Records callbacks; the test drives them through window.__rt. */
const FAKE_REALTIME = `
(() => {
  const cbs = { db: [], status: [], presence: [], screens: [], revoked: [] };
  let presenceNow = [{ user: "bryant", kind: "daemon" }, { user: "sam", kind: "daemon" }, { user: "bryant", kind: "web" }];
  window.__rt = {
    watching: [],
    jwt: "",
    db: (c) => cbs.db.forEach((f) => f(c)),
    status: (s) => cbs.status.forEach((f) => f(s)),
    presence: (entries) => { presenceNow = entries; cbs.presence.forEach((f) => f(entries)); },
    screen: (event, payload) => cbs.screens.forEach((f) => f({ event, payload })),
    revoke: () => cbs.revoked.forEach((f) => f()),
  };
  window.__AL_FAKE_REALTIME__ = (creds) => {
    window.__rt.jwt = creds.jwt;
    return {
      setAuth: async (jwt) => { window.__rt.jwt = jwt; },
      db: (onChange, onStatus) => { cbs.db.push(onChange); cbs.status.push(onStatus); onStatus("connecting"); setTimeout(() => onStatus("live"), 30); return () => {}; },
      presence: (me, onSync) => { cbs.presence.push(onSync); setTimeout(() => onSync(presenceNow), 50); return () => {}; },
      screens: (me, onEvent) => { cbs.screens.push(onEvent); return { watch: (a) => { window.__rt.watching = a; }, close: () => {} }; },
      revoked: (me, onRevoked) => { cbs.revoked.push(onRevoked); return () => {}; },
    };
  };
})();
`;
