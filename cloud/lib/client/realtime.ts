// The live side of contracts/cloud-api.md ("Realtime summary"), behind a small interface so the browser
// tests can drive it without a Supabase server: when a page defines window.__AL_FAKE_REALTIME__ (only
// the Playwright tests do), that factory is used instead of supabase-js.
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";

export type DbTable = "messages" | "sessions" | "context";
export interface DbChange {
  table: DbTable;
  type: "INSERT" | "UPDATE" | "DELETE";
  row: Record<string, unknown>; // `new` for INSERT/UPDATE, `old` for DELETE (REPLICA IDENTITY FULL)
}
export type LiveStatus = "connecting" | "live" | "down";
export interface PresenceEntry {
  user: string;
  kind?: "daemon" | "web";
  watching?: "*" | string[];
}
export interface ScreenEvent {
  event: "screen" | "screen.gone";
  payload: Record<string, unknown>;
}

export interface Live {
  /** A refreshed JWT; resolves once Realtime uses it. */
  setAuth(jwt: string): Promise<void>;
  /** messages / sessions / context row changes; status follows the channel. */
  db(onChange: (c: DbChange) => void, onStatus: (s: LiveStatus) => void): () => void;
  /** Channel `presence`: tracks `<me>:web`, reports every entry on each sync. */
  presence(me: string, onSync: (entries: PresenceEntry[]) => void): () => void;
  /** Channel `screens`: tracks what this browser watches ([] = nothing) and delivers screen events. */
  screens(me: string, onEvent: (e: ScreenEvent) => void): { watch(addresses: string[]): void; close(): void };
  /** Channel `user:<me>`: the server says this person was revoked or re-invited. */
  revoked(me: string, onRevoked: () => void): () => void;
}

export interface RealtimeCredsLike {
  url: string;
  anon_key: string;
  jwt: string;
}

declare global {
  interface Window {
    __AL_FAKE_REALTIME__?: (creds: RealtimeCredsLike) => Live;
  }
}

export async function openLive(creds: RealtimeCredsLike): Promise<Live> {
  if (typeof window !== "undefined" && window.__AL_FAKE_REALTIME__) return window.__AL_FAKE_REALTIME__(creds);
  return supabaseLive(creds);
}

function entriesOf(ch: RealtimeChannel): PresenceEntry[] {
  const state = ch.presenceState<PresenceEntry>();
  return Object.values(state).flat();
}

// contracts/cloud-api.md "Client setup": both `accessToken` (else supabase-js's auth module puts Realtime back
// on the anon key) and an awaited setAuth before the first subscribe (else the first joins go out as anon,
// and private channels and filtered postgres_changes are refused).
async function supabaseLive(creds: RealtimeCredsLike): Promise<Live> {
  let jwt = creds.jwt;
  const sb: SupabaseClient = createClient(creds.url, creds.anon_key, { accessToken: async () => jwt });
  await sb.realtime.setAuth(jwt);
  const rand = Math.random().toString(36).slice(2, 10);

  return {
    async setAuth(next) {
      jwt = next;
      await sb.realtime.setAuth(next);
    },

    db(onChange, onStatus) {
      onStatus("connecting");
      const ch = sb.channel(`db-${rand}`);
      for (const table of ["messages", "sessions", "context"] as const) {
        ch.on("postgres_changes", { event: "*", schema: "public", table }, (p) => {
          const type = p.eventType as DbChange["type"];
          const row = (type === "DELETE" ? p.old : p.new) as Record<string, unknown>;
          onChange({ table, type, row });
        });
      }
      ch.subscribe((status) => {
        if (status === "SUBSCRIBED") onStatus("live");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") onStatus("down");
      });
      return () => void sb.removeChannel(ch);
    },

    presence(me, onSync) {
      const ch = sb.channel("presence", { config: { private: true, presence: { key: `${me}:web` } } });
      ch.on("presence", { event: "sync" }, () => onSync(entriesOf(ch)));
      ch.subscribe((status) => {
        if (status === "SUBSCRIBED") void ch.track({ user: me, kind: "web", at: new Date().toISOString() });
      });
      return () => void sb.removeChannel(ch);
    },

    screens(me, onEvent) {
      const ch = sb.channel("screens", { config: { private: true, presence: { key: `${me}:${rand}` } } });
      let watching: string[] = [];
      let joined = false;
      const sync = () => {
        if (!joined) return;
        if (watching.length) void ch.track({ user: me, watching });
        else void ch.untrack();
      };
      ch.on("broadcast", { event: "screen" }, ({ payload }) => onEvent({ event: "screen", payload }));
      ch.on("broadcast", { event: "screen.gone" }, ({ payload }) => onEvent({ event: "screen.gone", payload }));
      ch.subscribe((status) => {
        joined = status === "SUBSCRIBED";
        sync();
      });
      return {
        watch(addresses) {
          watching = addresses;
          sync();
        },
        close: () => void sb.removeChannel(ch),
      };
    },

    revoked(me, onRevoked) {
      const ch = sb.channel(`user:${me}`, { config: { private: true } });
      ch.on("broadcast", { event: "revoked" }, () => onRevoked());
      ch.subscribe();
      return () => void sb.removeChannel(ch);
    },
  };
}
