// The env, store and broadcaster the routes use. Production builds them from process.env on first use; tests
// swap in a MemoryStore and a recording broadcaster with setDeps().
import { readEnv, type CloudEnv } from "./env.ts";
import type { Broadcaster, Store } from "./store.ts";
import { SupabaseBroadcaster, SupabaseStore } from "./supabase-store.ts";

export interface Deps {
  env: CloudEnv;
  store: Store;
  broadcaster: Broadcaster;
  now(): number; // ms
}

let deps: Deps | null = null;

export function getDeps(): Deps {
  if (deps) return deps;
  const env = readEnv();
  deps = {
    env,
    store: new SupabaseStore(env.supabaseUrl, env.supabaseServiceKey),
    broadcaster: new SupabaseBroadcaster(env.supabaseUrl, env.supabaseServiceKey),
    now: () => Date.now(),
  };
  return deps;
}

/** Tests only. */
export function setDeps(d: Deps | null): void {
  deps = d;
}
