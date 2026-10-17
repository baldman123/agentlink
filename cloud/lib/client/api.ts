// Browser side of contracts/cloud-api.md. The session rides in the httpOnly al_session cookie; the browser
// sends Origin itself on POST/PUT/DELETE, which the API checks.

export interface RealtimeCreds {
  url: string;
  anon_key: string;
  jwt: string;
  jwt_expires_at: string;
}
export interface Me {
  user: string;
  owner: boolean;
  realtime: RealtimeCreds;
}
export interface LoginResult extends Me {
  hub_id: string;
  hub_name: string;
}
export interface CloudConfig {
  supabase_url: string;
  supabase_anon_key: string;
  hub_id: string;
  hub_name: string;
}
export interface Person {
  user: string;
  epoch: number;
  created_at: string;
  invited_at: string | null;
  revoked_at: string | null;
  last_seen: string | null;
  connected: boolean;
}
export interface Invite {
  user: string;
  code: string;
  epoch: number;
  reinvited: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
  /** The session is gone for good (revoked, re-invited, or never valid): sign in again. */
  get signedOut() {
    return this.status === 401;
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const r = await fetch(path, {
    credentials: "same-origin",
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (r.status === 204) return undefined as T;
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) {
    const code = typeof body.error === "string" ? body.error : `http_${r.status}`;
    const detail = typeof body.detail === "string" ? body.detail : "";
    throw new ApiError(r.status, code, detail || code, body);
  }
  return body as T;
}

export const getMe = () => api<Me>("/api/me");
export const getConfig = () => api<CloudConfig>("/api/config");
export const login = (code: string) => api<LoginResult>("/api/auth/login", { method: "POST", json: { code } });
export const refresh = () => api<LoginResult>("/api/auth/refresh", { method: "POST" });
export const logout = () => api<void>("/api/auth/logout", { method: "POST" });

export const listPeople = () => api<{ owner: string; people: Person[] }>("/api/admin/people");
export const invitePerson = (user: string) => api<Invite>("/api/admin/people", { method: "POST", json: { user } });
export const revokePerson = (user: string) => api<{ ok: true; user: string }>(`/api/admin/people/${encodeURIComponent(user)}/revoke`, { method: "POST" });

/** Sign out and land on the sign-in page (used on revoke too). */
export async function signOut(reason?: "revoked") {
  try {
    await logout();
  } catch {
    /* the cookie may already be useless; still leave */
  }
  location.replace(reason ? `/login?reason=${reason}` : "/login");
}

/** What a failed login means for a person typing a code. */
export function loginErrorText(e: unknown): string {
  if (!(e instanceof ApiError)) return "Can't reach agentlink right now. Check your connection and try again.";
  switch (e.code) {
    case "bad_code":
      return "That code doesn't work. Check it and try again.";
    case "revoked":
      return "This code was turned off. Ask Bryant for a new one.";
    case "rate_limited": {
      const s = Number(e.body.retry_after_s) || 0;
      return `Too many tries. Wait ${s > 90 ? `${Math.ceil(s / 60)} minutes` : `${s || "a few"} seconds`} and try again.`;
    }
    default:
      return `Sign-in failed (${e.message}). Try again in a moment.`;
  }
}
