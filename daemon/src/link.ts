import type { EventEmitter } from "node:events";
import type { HubConnState, ScreenUpdate } from "../../contracts/index.ts";
import type { HubTarget } from "./discovery.ts";
import type { InputChannel } from "./input.ts";

/**
 * What the daemon's HTTP API needs from its hub connection. Two implementations:
 * HubLink (hublink.ts), the LAN WebSocket to hub/, and CloudLink (cloudlink.ts), REST + Supabase
 * Realtime to the website (contracts/cloud-api.md). Both emit "inbox" (InboxItem) and "state".
 */
export interface DaemonHubLink extends EventEmitter {
  readonly state: HubConnState;
  readonly target: HubTarget | null;
  readonly hubName: string | null;
  readonly hubId: string | null;
  readonly searching: boolean;
  readonly connected: boolean;
  start(): void;
  stop(): void;
  /** Send due outbox items. `all` ignores next_attempt_at. */
  pump(all: boolean): void;
  forwardUpsert(agent: string): void;
  forwardRemove(agent: string): void;
  putScreen(screen: ScreenUpdate): void;
  getScreen(agent: string): { screen: ScreenUpdate; at: string } | null;
  deleteScreen(agent: string): void;
  /**
   * Cloud only: let the website's signed input frames reach the bridge (input.md "Cloud input").
   * The LAN link has no such method, so nothing from a LAN hub can reach the panes.
   */
  attachInput?(input: InputChannel): void;
  /** Hub REST call with this link's credentials. Throws HubOffline when not connected. */
  rest(method: string, pathAndQuery: string, body?: unknown): Promise<{ status: number; body: unknown }>;
}
