// The env, store and broadcaster the routes use. Production builds them from process.env on first use; tests
// swap in a MemoryStore and a recording broadcaster with setDeps().
import { readEnv, type CloudEnv } from "./env.ts";
import type { Broadcaster, FileStorage, Store } from "./store.ts";
import { SupabaseBroadcaster, SupabaseFileStorage, SupabaseStore } from "./supabase-store.ts";

export interface Deps {
  env: CloudEnv;
  store: Store;
  broadcaster: Broadcaster;
  now(): number; // ms
  /** Storage for files; tests that don't touch files leave it out. */
  files?: FileStorage;
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
    files: new SupabaseFileStorage(env.supabaseUrl, env.supabaseServiceKey, env.filesBucket ?? "agentlink-files"),
  };
  return deps;
}

/** Tests only. */
export function setDeps(d: Deps | null): void {
  deps = d;
}
