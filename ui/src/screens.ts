// Live terminal screens, kept outside the app reducer: up to 2 updates/s per pane would otherwise
// re-render the whole app. Each pane subscribes to its own address with useScreen().
import { useSyncExternalStore } from "react";
import type { Address, ScreenUpdate } from "../../contracts/index.ts";
import { userOf } from "./lib.ts";

export interface ScreenState {
  screen: ScreenUpdate;
  at: string;
}

/** How long after subscribing we wait for the hub's initial screen before calling it "not shared". */
export const NOT_SHARED_AFTER_MS = 2500;

const screens = new Map<Address, ScreenState>();
const subscribedAt = new Map<Address, number>();
const sharingUsers = new Set<string>(); // users we've received at least one screen from
const notSharingUsers = new Set<string>(); // users whose subscribed screens never arrived
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version++;
  for (const l of listeners) l();
}

export const screenStore = {
  put(address: Address, screen: ScreenUpdate, at: string) {
    screens.set(address, { screen, at });
    sharingUsers.add(userOf(address));
    notSharingUsers.delete(userOf(address));
    emit();
  },
  gone(address: Address) {
    if (screens.delete(address)) emit();
  },
  /** Called whenever the UI changes its subscription; remembers when each address was first asked for. */
  subscribed(addresses: Address[]) {
    const now = Date.now();
    const keep = new Set(addresses);
    for (const a of addresses) if (!subscribedAt.has(a)) subscribedAt.set(a, now);
    for (const a of [...subscribedAt.keys()]) if (!keep.has(a)) subscribedAt.delete(a);
    emit();
    // re-render once the "not shared" grace period has passed
    setTimeout(emit, NOT_SHARED_AFTER_MS + 50);
  },
  /** After a reconnect the hub re-sends current screens; restart the grace period. */
  resetGrace() {
    const now = Date.now();
    for (const a of subscribedAt.keys()) subscribedAt.set(a, now);
    setTimeout(emit, NOT_SHARED_AFTER_MS + 50);
  },
  get: (a: Address) => screens.get(a),
  sharing: (user: string) => sharingUsers.has(user),
  /** "not_sharing" only once we've asked for one of the user's screens and the grace period passed empty. */
  userSharing(user: string): "yes" | "no" | "unknown" {
    if (sharingUsers.has(user)) return "yes";
    if (notSharingUsers.has(user)) return "no";
    const now = Date.now();
    for (const [a, t] of subscribedAt)
      if (userOf(a) === user && now - t >= NOT_SHARED_AFTER_MS) {
        notSharingUsers.add(user); // remembered after we stop subscribing; cleared if a screen ever arrives
        return "no";
      }
    return "unknown";
  },
  /** "live" | "waiting" (subscribed, grace period running) | "not_shared" */
  availability(a: Address): "live" | "waiting" | "not_shared" {
    if (screens.has(a)) return "live";
    const t = subscribedAt.get(a);
    if (t != null && Date.now() - t < NOT_SHARED_AFTER_MS) return "waiting";
    return "not_shared";
  },
};

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Re-renders when any screen changes; components read only what they need via screenStore. */
export function useScreensVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/** The latest screen for one address; re-renders only when that address's screen object changes. */
export function useScreen(address: Address | null): ScreenState | undefined {
  return useSyncExternalStore(subscribe, () => (address ? screens.get(address) : undefined));
}
