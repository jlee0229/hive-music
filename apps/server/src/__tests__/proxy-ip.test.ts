import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { callerKey } from "../rate-limit";

/**
 * Red-team RT-04. Every per-caller budget (POST /rooms, GET /rooms/:code, vibe, uploads, JOIN misses)
 * keyed on the `Fly-Client-IP` request header whenever it was present. Fly's edge overwrites it in
 * production, but anywhere else it is whatever the caller typed: rotating it took 40 of 40 requests
 * past a 30/min cap. The header is now only believed when the operator says so (TRUST_PROXY_IP=1).
 */
describe("RT-04: callerKey", () => {
  const srv = { requestIP: () => ({ address: "203.0.113.7" }) };
  const req = (headers: Record<string, string> = {}) => new Request("http://hive.test/rooms", { method: "POST", headers });

  test("by default the caller is the socket's peer, whatever headers it sends", () => {
    expect(callerKey(req(), srv, false)).toBe("203.0.113.7");
    expect(callerKey(req({ "fly-client-ip": "1.2.3.4" }), srv, false)).toBe("203.0.113.7");
    expect(callerKey(req({ "Fly-Client-IP": "9.9.9.9", "x-forwarded-for": "8.8.8.8" }), srv, false)).toBe("203.0.113.7");
    expect(callerKey(req(), { requestIP: () => null }, false)).toBe("unknown");
  });

  test("with TRUST_PROXY_IP the proxy's header names the caller; without the header it falls back to the peer", () => {
    expect(callerKey(req({ "fly-client-ip": "1.2.3.4" }), srv, true)).toBe("1.2.3.4");
    expect(callerKey(req(), srv, true)).toBe("203.0.113.7");
    expect(callerKey(req({ "fly-client-ip": "   " }), srv, true)).toBe("203.0.113.7");
    expect(callerKey(req({ "fly-client-ip": "x".repeat(500) }), srv, true).length).toBe(64); // a key, not a memory leak
  });
});

function server(port: number, extraEnv: Record<string, string>) {
  let proc: ReturnType<typeof Bun.spawn>;
  const base = `http://localhost:${port}`;
  return {
    async start() {
      const env: Record<string, string | undefined> = { ...process.env, PORT: String(port), ROOM_FIXED_CODE: "", ROOMS_PER_MINUTE: "4", HOST_KEY_SECRET: "proxy-ip-test-secret-0123456789abcdef", ...extraEnv };
      if (!("TRUST_PROXY_IP" in extraEnv)) delete env.TRUST_PROXY_IP;
      proc = Bun.spawn(["bun", `${import.meta.dir}/../index.ts`], { env, stdout: "ignore", stderr: "ignore" });
      for (let i = 0; i < 80; i++) {
        try {
          if ((await fetch(`${base}/health`)).ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("server did not start");
    },
    stop: () => proc.kill(),
    create: async (ip?: string) => (await fetch(`${base}/rooms`, { method: "POST", body: "{}", headers: ip ? { "Fly-Client-IP": ip } : {} })).status,
  };
}

describe("RT-04 over HTTP, default: the header cannot buy a fresh budget", () => {
  const s = server(22080 + Math.floor(Math.random() * 400), {});
  beforeAll(() => s.start());
  afterAll(() => s.stop());

  test("ten room creations from one address, each claiming a different Fly-Client-IP: the 5th onward is refused", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push(await s.create(`198.51.100.${i}`));
    expect(statuses).toEqual([200, 200, 200, 200, 429, 429, 429, 429, 429, 429]);
  });
});

describe("RT-04 over HTTP, TRUST_PROXY_IP=1: the proxy's header separates callers", () => {
  const s = server(22500 + Math.floor(Math.random() * 400), { TRUST_PROXY_IP: "1" });
  beforeAll(() => s.start());
  afterAll(() => s.stop());

  test("two addresses behind the proxy each get their own budget, and each is still held to it", async () => {
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < 6; i++) {
      a.push(await s.create("198.51.100.1"));
      b.push(await s.create("198.51.100.2"));
    }
    expect(a).toEqual([200, 200, 200, 200, 429, 429]);
    expect(b).toEqual([200, 200, 200, 200, 429, 429]);
  });
});
