import type { InboxItem, Session, SessionKind, SessionStatus } from "../../contracts/index.ts";

/** The few daemon localhost endpoints the bridge needs (contracts/daemon-api.md). */
export class Daemon {
  constructor(readonly baseUrl: string) {}

  private async req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) throw new Error(`daemon ${method} ${path} -> ${res.status} ${json?.error ?? text.slice(0, 120)}`);
    return { status: res.status, json };
  }

  async putSession(agent: string, s: { kind: SessionKind; status: SessionStatus; task: string }): Promise<Session> {
    return (await this.req("PUT", `/v1/sessions/${encodeURIComponent(agent)}`, s)).json;
  }

  async deleteSession(agent: string): Promise<void> {
    await this.req("DELETE", `/v1/sessions/${encodeURIComponent(agent)}`);
  }

  async unhandledInbox(): Promise<InboxItem[]> {
    return (await this.req("GET", "/v1/inbox?unhandled=1&limit=1000")).json.messages;
  }

  /** Stream new inbox arrivals (SSE). Resolves when the stream ends; throws on connect failure. */
  async stream(onItem: (item: InboxItem) => void, signal: AbortSignal, onOpen?: () => void): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/inbox/stream`, { headers: { accept: "text/event-stream" }, signal });
    if (!res.ok || !res.body) throw new Error(`inbox stream -> ${res.status}`);
    onOpen?.();
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let sep: number;
      while ((sep = buf.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep).replace(/^\r?\n\r?\n/, "");
        let event = "message";
        const data: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (event !== "message" || !data.length) continue;
        try {
          onItem(JSON.parse(data.join("\n")) as InboxItem);
        } catch {
          // a malformed frame is skipped; the catch-up on reconnect covers anything missed
        }
      }
    }
  }
}
