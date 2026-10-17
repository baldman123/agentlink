import os from "node:os";
import type { Config } from "./config.ts";
import { scanHosts, type Discovery, type HubTarget } from "./discovery.ts";
import { log } from "./log.ts";
import type { Store } from "./store.ts";

// Finding the pinned hub when its IP changes (contracts/daemon-api.md, "Discovery").
// The hub's identity is its hub_id. Every candidate address is checked with the unauthenticated
// GET /api/health first, and only an exact hub_id match is returned, so the caller never sends the
// token (in hello) to anything else.

const DEFAULT_HUB_PORT = 7700;
const SCAN_TIMEOUT_MS = 400;
const SCAN_CONCURRENCY = 32;
const PROBE_TIMEOUT_MS = 1_500; // mDNS, last known and manual: a known address, allow a little longer
const LAST_KNOWN_MAX = 5;
export const SCAN_EVERY_MS = 30_000;
const QUIET_MS = 10 * 60_000; // hub.id_mismatch is logged at most once per url per 10 minutes

export interface Mismatch {
  url: string;
  via: "last_known" | "manual";
  hubId: string;
}

export class HubFinder {
  private lastScanAt = 0;
  /** From the last find(): known addresses (last known, manual) that answered with another hub_id. */
  mismatches: Mismatch[] = [];
  private mismatchLogged = new Map<string, number>(); // url -> last hub.id_mismatch log
  private deniedUrls = new Set<string>(); // never connect to these again this run

  constructor(
    private cfg: Config,
    private store: Store,
    private discovery: Discovery,
  ) {}

  /** Run the next search with a scan even if the last one was under 30s ago (network changed). */
  scanSoon() {
    this.lastScanAt = 0;
  }

  /** Try mDNS, last known, scan (at most every 30s), manual, in that order. Null when nothing matches. */
  async find(pin: string): Promise<HubTarget | null> {
    this.mismatches = [];
    if (this.cfg.discovery === "mdns") {
      log("hub.search", { stage: "mdns" });
      for (const t of this.discovery.matching(pin)) {
        if (this.denied(t.url)) continue;
        const id = await probeHubId(t.url, PROBE_TIMEOUT_MS);
        if (id === pin) return this.found({ ...t, via: "mdns", hubId: pin });
        if (id !== null) this.noteMismatch("mdns", t.url, pin, id); // advertised the pin in TXT, answers otherwise
      }
    }

    const known = this.lastKnown().filter((u) => !this.denied(u));
    if (known.length) {
      log("hub.search", { stage: "last_known", count: known.length });
      for (const url of known) {
        const id = await probeHubId(url, PROBE_TIMEOUT_MS);
        if (id === pin) return this.found({ url, via: "last_known", name: null, hubId: pin });
        if (id !== null) {
          this.noteMismatch("last_known", url, pin, id); // another computer now sits at the old address
          this.mismatches.push({ url, via: "last_known", hubId: id });
        }
      }
    }

    if (this.cfg.scan && Date.now() - this.lastScanAt >= SCAN_EVERY_MS) {
      this.lastScanAt = Date.now();
      const urls = this.scanCandidates().filter((u) => !this.denied(u));
      log("hub.search", { stage: "scan", candidates: urls.length });
      const url = await scan(urls, pin, (u, id) => this.noteMismatch("scan", u, pin, id));
      if (url) return this.found({ url, via: "scan", name: null, hubId: pin });
    }

    if (this.cfg.hubUrl && !this.denied(this.cfg.hubUrl)) {
      log("hub.search", { stage: "manual", url: this.cfg.hubUrl });
      const id = await probeHubId(this.cfg.hubUrl, PROBE_TIMEOUT_MS);
      if (id === pin) return this.found({ url: this.cfg.hubUrl, via: "manual", name: null, hubId: pin });
      if (id !== null) {
        this.noteMismatch("manual", this.cfg.hubUrl, pin, id);
        this.mismatches.push({ url: this.cfg.hubUrl, via: "manual", hubId: id });
      }
    }
    log("hub.search", { stage: "none", detail: "no address answered with the pinned hub_id" });
    return null;
  }

  // ---------------------------------------------------------------- mismatches and the deny list

  /** An address that answered with a different hub_id: logged once per url per 10 minutes. */
  private noteMismatch(via: string, url: string, expected: string, got: string) {
    const now = Date.now();
    if ((this.mismatchLogged.get(url) ?? 0) > now - QUIET_MS) return;
    this.mismatchLogged.set(url, now);
    if (this.mismatchLogged.size > 2000) this.mismatchLogged.clear();
    log("hub.id_mismatch", { via, url, got, expected_hub_id: expected, got_hub_id: got });
  }

  /**
   * Skip `url` in every stage for the rest of this run. Used for an impostor (challenge hub_id or
   * server_proof mismatch) or a welcome with the wrong hub_id: it never gets another connection.
   */
  deny(url: string, why: string) {
    if (this.deniedUrls.has(url)) return;
    this.deniedUrls.add(url);
    log("hub.denied", { url, why, until: "restart" });
  }

  isDenied(url: string): boolean {
    return this.deniedUrls.has(url);
  }

  private denied(url: string): boolean {
    return this.deniedUrls.has(url);
  }

  private found(t: HubTarget): HubTarget {
    log("hub.found", { via: t.via, url: t.url, hub_id: t.hubId });
    return t;
  }

  // ---------------------------------------------------------------- last known

  lastKnown(): string[] {
    try {
      const v = JSON.parse(this.store.getKv("last_known_hubs") ?? "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, LAST_KNOWN_MAX) : [];
    } catch {
      return [];
    }
  }

  /** Called on every successful welcome: newest first, deduplicated, at most 5. */
  recordSuccess(url: string) {
    const list = [url, ...this.lastKnown().filter((u) => u !== url)].slice(0, LAST_KNOWN_MAX);
    this.store.setKv("last_known_hubs", JSON.stringify(list));
  }

  // ---------------------------------------------------------------- scan

  private scanCandidates(): string[] {
    const ports = new Set<number>([DEFAULT_HUB_PORT]);
    for (const u of this.lastKnown()) {
      const p = Number(new URL(u).port);
      if (p) ports.add(p);
    }
    const urls: string[] = [];
    const hosts = this.cfg.scanHosts ?? scanHosts(os.networkInterfaces());
    for (const h of hosts) {
      // a test host list may carry its own port ("127.0.0.1:7795")
      const m = h.match(/^(.+):(\d+)$/);
      if (m) urls.push(`http://${m[1]}:${m[2]}`);
      else for (const p of ports) urls.push(`http://${h}:${p}`);
    }
    return [...new Set(urls)];
  }
}

/** The hub_id that `url` reports on GET /api/health, or null. */
export async function probeHubId(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    if (!res.ok) return null;
    const body = (await res.json()) as { hub_id?: unknown };
    return typeof body.hub_id === "string" ? body.hub_id : null;
  } catch {
    return null;
  }
}

/** Probe `urls` 32 at a time; the first one whose hub_id equals `pin` wins and stops the rest. */
async function scan(urls: string[], pin: string, onMismatch: (url: string, id: string) => void): Promise<string | null> {
  let next = 0;
  let hit: string | null = null;
  const worker = async () => {
    while (hit === null && next < urls.length) {
      const url = urls[next++];
      const id = await probeHubId(url, SCAN_TIMEOUT_MS);
      if (id === pin && hit === null) hit = url;
      else if (id !== null && id !== pin) onMismatch(url, id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, urls.length) }, worker));
  return hit;
}

/** A short signature of this laptop's IPv4 addresses, to notice network changes. */
export function networkSignature(): string {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) out.push(`${name}=${a.address}`);
  }
  return out.sort().join(",");
}
