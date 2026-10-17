import { Bonjour } from "bonjour-service";
import { MDNS_SERVICE_TYPE, PROTOCOL_VERSION } from "../../contracts/index.ts";
import { logInfo } from "./log.ts";

export interface AdvertiserOptions {
  name: string;
  port: number;
  hubId: string;
  retryMs?: number; // wait before re-advertising after an mDNS error (default 30s)
}

/**
 * Advertises the hub over mDNS. mDNS is best-effort: every failure is logged as mdns.error and the
 * advertisement is torn down and retried after retryMs. Nothing here may take the hub down.
 *
 * bonjour-service reports errors two ways, and both throw unless handled: its errorCallback (send
 * failures such as EHOSTUNREACH on 224.0.0.251:5353 rethrow by default) and the multicast-dns
 * socket's "error" event (EACCES/EADDRINUSE on bind).
 */
export class Advertiser {
  bonjour: Bonjour | null = null;
  starts = 0; // number of successful publish() calls, for tests
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private opts: AdvertiserOptions) {}

  start(): void {
    if (this.stopped) return;
    try {
      const b = new Bonjour({}, (err: unknown) => this.onError(err, "callback"));
      this.bonjour = b;
      const mdns = (b as any).server?.mdns;
      mdns?.on("error", (err: unknown) => this.onError(err, "socket"));
      mdns?.on("warning", (err: unknown) => logInfo("mdns.warning", { detail: String((err as Error)?.message ?? err) }));
      const svc = b.publish({
        name: this.opts.name,
        type: MDNS_SERVICE_TYPE,
        port: this.opts.port,
        txt: { v: String(PROTOCOL_VERSION), hub_id: this.opts.hubId, name: this.opts.name },
      });
      (svc as any)?.on?.("error", (err: unknown) => this.onError(err, "service"));
      this.starts++;
      logInfo("mdns.published", { type: `_${MDNS_SERVICE_TYPE}._tcp`, name: this.opts.name, port: this.opts.port });
    } catch (err) {
      this.onError(err, "start");
    }
  }

  private onError(err: unknown, source: string): void {
    const e = err as NodeJS.ErrnoException;
    logInfo("mdns.error", { source, code: e?.code ?? null, detail: String(e?.message ?? err) });
    if (this.stopped || this.retryTimer) return;
    const retryMs = this.opts.retryMs ?? 30_000;
    logInfo("mdns.retry_scheduled", { in_ms: retryMs });
    this.teardown();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.start();
    }, retryMs);
  }

  private teardown(): void {
    const b = this.bonjour;
    this.bonjour = null;
    if (!b) return;
    try {
      b.destroy();
    } catch (err) {
      logInfo("mdns.error", { source: "destroy", detail: String((err as Error)?.message ?? err) });
    }
  }

  /** Withdraw the advertisement (best effort, bounded wait) and stop retrying. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const b = this.bonjour;
    if (!b) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1_000);
      try {
        b.unpublishAll(() => {
          clearTimeout(t);
          resolve();
        });
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
    this.teardown();
  }
}

const MDNS_STACK_RE = /bonjour-service|multicast-dns/;

export function isMdnsError(err: unknown): boolean {
  return MDNS_STACK_RE.test(String((err as Error)?.stack ?? ""));
}

let guardInstalled = false;

/**
 * Last-resort guard: an uncaught error whose stack comes from bonjour-service/multicast-dns is logged
 * and swallowed. Anything else keeps Node's default behavior (print and exit 1).
 */
export function installMdnsCrashGuard(): void {
  if (guardInstalled) return;
  guardInstalled = true;
  process.on("uncaughtException", (err) => {
    if (isMdnsError(err)) {
      logInfo("mdns.error", { source: "uncaught", detail: String(err?.message ?? err) });
      return;
    }
    console.error(err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    if (isMdnsError(reason)) {
      logInfo("mdns.error", { source: "unhandled_rejection", detail: String((reason as Error)?.message ?? reason) });
      return;
    }
    console.error(reason);
    process.exit(1);
  });
}
