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
}

/**
 * Who is calling. Behind Fly's proxy every connection comes from the proxy, which reports the real
 * peer in Fly-Client-IP (set by the edge, not forwarded from the client); anywhere else it is the
 * socket's own address.
 */
export function callerKey(req: Request, srv: { requestIP(req: Request): { address: string } | null }): string {
  return req.headers.get("fly-client-ip") ?? srv.requestIP(req)?.address ?? "unknown";
}
