import { EventEmitter } from "node:events";
import type { NetworkInterfaceInfo } from "node:os";
import { Bonjour, type Browser, type Service } from "bonjour-service";
import { MDNS_SERVICE_TYPE } from "../../contracts/index.ts";
import { log } from "./log.ts";

export interface HubTarget {
  url: string; // http://host:port
  via: "mdns" | "last_known" | "scan" | "manual";
  name: string | null;
  hubId: string | null; // TXT hub_id for mDNS targets; unknown (null) for the manual URL
}

const MDNS_WAIT_MS = 5_000;

/**
 * Finds the hub. mDNS browsing for _agentlink._tcp runs for the life of the daemon; the manual
 * AGENTLINK_HUB_URL is used when mDNS has found nothing (after a 5s grace period at startup), or
 * always when AGENTLINK_DISCOVERY=manual. Emits "up" when mDNS finds a hub.
 */
export class Discovery extends EventEmitter {
  private bonjour: Bonjour | null = null;
  private browser: Browser | null = null;
  private found = new Map<string, HubTarget>(); // keyed by host:port, insertion order = discovery order
  private keyByService = new Map<string, string>(); // instance name -> host:port, for "down" events
  private startedAt = Date.now();

  constructor(
    private mode: "mdns" | "manual",
    private manualUrl: string | null,
    private hubName: string | null = null,
  ) {
    super();
  }

  start() {
    this.startedAt = Date.now();
    if (this.mode === "manual") return;
    try {
      this.bonjour = new Bonjour({}, (err: unknown) => log("mdns.error", { detail: String(err) }));
      this.browser = this.bonjour.find({ type: MDNS_SERVICE_TYPE });
      this.browser.on("up", (svc: Service) => this.onUp(svc));
      this.browser.on("down", (svc: Service) => this.onDown(svc));
    } catch (err) {
      log("mdns.error", { detail: String(err) });
    }
  }

  stop() {
    try {
      this.browser?.stop();
      this.bonjour?.destroy();
    } catch {
      // shutting down anyway
    }
  }

  /** Re-query the network; called while disconnected so a hub that came back is found quickly. */
  refresh() {
    try {
      this.browser?.update();
    } catch {
      // ignore
    }
  }

  private onUp(svc: Service) {
    const host = pickHost(svc);
    if (!host || !svc.port) return;
    const txt = (svc.txt ?? {}) as Record<string, string>;
    const url = `http://${host.includes(":") ? `[${host}]` : host}:${svc.port}`;
    if (this.hubName && txt.name !== this.hubName && txt.hub_id !== this.hubName) {
      log("hub.ignored", { url, name: txt.name ?? null, hub_id: txt.hub_id ?? null, want: this.hubName });
      return;
    }
    const target: HubTarget = { url, via: "mdns", name: txt.name ?? svc.name ?? null, hubId: txt.hub_id ?? null };
    const key = `${host}:${svc.port}`;
    this.found.delete(key);
    this.found.set(key, target);
    this.keyByService.set(svc.name, key);
    log("hub.discovered", { url, via: "mdns", name: target.name, hub_id: txt.hub_id ?? null });
    this.emit("up", target);
  }

  private onDown(svc: Service) {
    const host = pickHost(svc);
    const key = host && svc.port ? `${host}:${svc.port}` : this.keyByService.get(svc.name);
    if (key && this.found.delete(key)) log("hub.lost", { key, name: svc.name });
    this.keyByService.delete(svc.name);
  }

  /**
   * The best current target, waiting up to 5s after startup for mDNS before using the manual URL.
   * With `pinnedId`, a discovered hub advertising that hub_id wins over newer advertisers.
   */
  async resolve(pinnedId: string | null = null): Promise<HubTarget | null> {
    const manual: HubTarget | null = this.manualUrl ? { url: this.manualUrl, via: "manual", name: null, hubId: null } : null;
    if (this.mode === "manual") return manual;
    const latest = this.latest(pinnedId);
    if (latest) return latest;
    const remaining = MDNS_WAIT_MS - (Date.now() - this.startedAt);
    if (remaining > 0) {
      const t = await new Promise<HubTarget | null>((resolve) => {
        const timer = setTimeout(() => {
          this.off("up", onUp);
          resolve(null);
        }, remaining);
        const onUp = (target: HubTarget) => {
          clearTimeout(timer);
          resolve(target);
        };
        this.once("up", onUp);
      });
      if (t) return t;
    }
    return manual;
  }

  /** Discovered hubs whose TXT hub_id equals `pin`, newest first. (Still to be verified by /api/health.) */
  matching(pin: string): HubTarget[] {
    return [...this.found.values()].filter((t) => t.hubId === pin).reverse();
  }

  private latest(pinnedId: string | null): HubTarget | null {
    let last: HubTarget | null = null;
    let pinned: HubTarget | null = null;
    for (const t of this.found.values()) {
      last = t;
      if (pinnedId && t.hubId === pinnedId) pinned = t;
    }
    return pinned ?? last;
  }
}

const isPrivate = (a: number[]) =>
  a[0] === 10 || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && a[1] === 168);

/**
 * Hosts to scan for the hub: every host of the /24 around each private IPv4 address in `ifaces`
 * (shaped like os.networkInterfaces()). Internal, IPv6, link-local and public addresses are skipped;
 * a wider private subnet (a /16 or /8) is still capped at the /24 around the address. Pure.
 */
export function scanHosts(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const prefixes = new Set<string>();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      const fam = a.family as unknown; // "IPv4", or 4 on some Node versions
      if (a.internal || (fam !== "IPv4" && fam !== 4)) continue;
      const parts = a.address.split(".").map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) continue;
      if (isPrivate(parts)) prefixes.add(parts.slice(0, 3).join("."));
    }
  }
  const hosts: string[] = [];
  for (const prefix of prefixes) for (let i = 1; i <= 254; i++) hosts.push(`${prefix}.${i}`);
  return hosts;
}

function pickHost(svc: Service): string | null {
  const addrs = svc.addresses ?? [];
  const v4 = addrs.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  if (v4) return v4;
  if (svc.host) return svc.host.replace(/\.$/, "");
  return addrs[0] ?? null;
}
