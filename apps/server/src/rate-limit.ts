// Fixed-window request budget per caller, for the few REST routes that create state or cost money
// (POST /rooms, POST /rooms/:code/vibe, POST /tracks). Deliberately generous: a whole party shares
// one NAT address, so this is a ceiling on abuse, not a throttle on use.

export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  /** Counts one request for `key`; false when the caller is over budget for the current window. */
  allow(key: string, nowMs: number = performance.now()): boolean {
    // Bounded bookkeeping: once the table is large, forget every caller whose window has ended.
    if (this.windows.size >= 10_000) {
      for (const [k, w] of this.windows) if (nowMs - w.start >= this.windowMs) this.windows.delete(k);
      // Still full of live windows means thousands of distinct callers this minute: nothing to track against.
      if (this.windows.size >= 10_000) this.windows.clear();
    }
    const w = this.windows.get(key);
    if (!w || nowMs - w.start >= this.windowMs) {
      this.windows.set(key, { start: nowMs, count: 1 });
      return true;
    }
    return ++w.count <= this.limit;
  }

  /** True when `key` has already gone over budget in the current window. Counts nothing. */
  blocked(key: string, nowMs: number = performance.now()): boolean {
    const w = this.windows.get(key);
    return !!w && nowMs - w.start < this.windowMs && w.count > this.limit;
  }
}

/**
 * Who is calling: the socket's own remote address — unless the operator says this process sits
 * behind a proxy that overwrites `Fly-Client-IP` (TRUST_PROXY_IP=1; fly.toml sets it). Behind Fly
 * every connection comes from the proxy, so the header is the only way to tell callers apart there;
 * anywhere else it is just a header the caller typed, and trusting it meant every budget in this
 * file could be reset by changing a string (red-team RT-04: 40 of 40 requests past a 30/min cap).
 */
export function callerKey(
  req: Request,
  srv: { requestIP(req: Request): { address: string } | null },
  trustProxy: boolean = process.env.TRUST_PROXY_IP === "1",
): string {
  const peer = srv.requestIP(req)?.address ?? "unknown";
  return trustProxy ? (req.headers.get("fly-client-ip")?.trim().slice(0, 64) || peer) : peer;
}
