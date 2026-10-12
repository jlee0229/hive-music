/**
 * Guest path against the REAL stack: real @hive/server + the real Web Audio engine, in headless
 * Chromium. The rest of the suite runs the stub engine, which has no AudioContext — so anything
 * about sound actually starting, stopping or resuming can only be asserted here.
 *
 * Self-skips unless PW_REAL_ENGINE=1. To run it (ports are whatever you have free):
 *
 *   PORT=8860 bun run --cwd apps/server start
 *   NEXT_PUBLIC_API_URL=http://localhost:8860 NEXT_PUBLIC_WS_URL=ws://localhost:8860/ws \
 *     node ../../node_modules/next/dist/bin/next dev -p 3161        # from apps/web, engine = real
 *   PW_REAL_ENGINE=1 PW_BASE_URL=http://localhost:3161 PW_REAL_API_URL=http://localhost:8860 \
 *     node ../../node_modules/@playwright/test/cli.js test player-real-engine
 *
 * Each simulated phone is its own browser context (identity lives in localStorage). The host is a
 * raw WebSocket, so nothing here depends on the host UI.
 */
import { existsSync } from "node:fs";
import { test, expect, type Browser, type Page } from "@playwright/test";
import { PROTOCOL_VERSION, type ClientMessage, type RoomState, type ServerMessage } from "@hive/protocol";

const ENABLED = process.env.PW_REAL_ENGINE === "1";
const API = process.env.PW_REAL_API_URL ?? "http://localhost:8080";
const CI_CHROMIUM = "/opt/pw-browsers/chromium";
const executablePath = process.env.PW_CHROMIUM_PATH ?? (existsSync(CI_CHROMIUM) ? CI_CHROMIUM : undefined);

// launchOptions replaces the project's wholesale, so the executable path is repeated here.
test.use({
  launchOptions: {
    ...(executablePath ? { executablePath } : {}),
    args: ["--autoplay-policy=no-user-gesture-required"],
  },
});
test.skip(!ENABLED, "real-engine spec: set PW_REAL_ENGINE=1 with a real server + real-engine web (see file header)");
test.describe.configure({ timeout: 60_000 });

/** Runs in the page before any app code: records contexts, source starts and the destination level. */
function instrumentWebAudio() {
  type Hive = { ctxs: AudioContext[]; an: AnalyserNode[]; sawResume: boolean };
  const w = window as unknown as { __hive: Hive; __rms: () => number | null; __hangResume?: boolean };
  const Orig = window.AudioContext;
  const H: Hive = (w.__hive = { ctxs: [], an: [], sawResume: false });
  window.AudioContext = class extends Orig {
    constructor(options?: AudioContextOptions) {
      super(options);
      H.ctxs.push(this);
      H.an.push(Orig.prototype.createAnalyser.call(this));
    }
    resume(): Promise<void> {
      // __hangResume simulates WebKit leaving resume() pending (an interrupted audio session).
      return w.__hangResume ? new Promise<void>(() => {}) : super.resume();
    }
  };
  const origConnect = AudioNode.prototype.connect as (this: AudioNode, ...a: unknown[]) => unknown;
  (AudioNode.prototype as unknown as { connect: unknown }).connect = function (this: AudioNode, ...args: unknown[]) {
    const i = H.ctxs.indexOf(this.context as AudioContext);
    if (i >= 0 && args[0] === this.context.destination) origConnect.call(this, H.an[i]);
    return origConnect.apply(this, args);
  };
  w.__rms = () => {
    const an = H.an.at(-1);
    if (!an) return null;
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    return Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
  };
  // "Tap to resume" on screen for even one frame is what a guest reads as "it broke".
  document.addEventListener("DOMContentLoaded", () => {
    const check = () => {
      if (/Tap to resume|Resuming/.test(document.body.innerText)) H.sawResume = true;
    };
    new MutationObserver(check).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  });
}

const audio = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __hive: { ctxs: AudioContext[]; sawResume: boolean }; __rms: () => number | null };
    return { ctxState: w.__hive.ctxs.at(-1)?.state ?? null, rms: w.__rms() ?? 0, sawResume: w.__hive.sawResume };
  });

async function newPhone(browser: Browser, init?: () => void) {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 } });
  await context.addInitScript(instrumentWebAudio);
  if (init) await context.addInitScript(init);
  return { context, page: await context.newPage() };
}

async function createRoom(): Promise<{ code: string; hostKey: string }> {
  const res = await fetch(`${API}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return (await res.json()) as { code: string; hostKey: string };
}

async function hostSocket(code: string, hostKey: string) {
  const ws = new WebSocket(API.replace(/^http/, "ws") + "/ws");
  const state: { room: RoomState | null } = { room: null };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      const join: ClientMessage = {
        type: "JOIN",
        clientId: `e2e-host-${Math.random().toString(36).slice(2, 10)}`,
        roomCode: code,
        kind: "host",
        plays: false,
        hostKey,
        name: "e2e host",
        device: { userAgent: "playwright", platform: "test", browserFamily: "other" },
        protocolVersion: PROTOCOL_VERSION,
      };
      ws.send(JSON.stringify(join));
    };
    ws.onerror = () => reject(new Error("host socket error"));
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as ServerMessage;
      if (msg.type === "WELCOME") resolve();
      if (msg.type === "ROOM_STATE") state.room = msg.room;
      if (msg.type === "PING") ws.send(JSON.stringify({ type: "PONG" }));
    };
  });
  return { state, send: (m: ClientMessage) => ws.send(JSON.stringify(m)), close: () => ws.close() };
}

async function tapJoin(page: Page, code: string, name: string) {
  await page.goto(`/j/${code}`);
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByRole("button", { name: "Tap to join" }).click();
}

/** A room with a track loaded and the transport playing from `fromSec`. */
async function playingRoom(fromSec = 0) {
  const { code, hostKey } = await createRoom();
  const host = await hostSocket(code, hostKey);
  host.send({ type: "SET_TRACK", trackId: "synthetic-60s" });
  host.send({ type: "TRANSPORT", action: "PLAY", trackTimeSec: fromSec });
  await expect.poll(() => host.state.room?.transport.state).toBe("playing");
  return { code, host };
}

test("a phone the host removes goes silent, not just to a 'Removed' screen", async ({ browser }) => {
  const { code, host } = await playingRoom();
  const { context, page } = await newPhone(browser);

  await tapJoin(page, code, "Heckler");
  await expect(page.getByText("YOU ARE")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await audio(page)).rms, { timeout: 15_000 }).toBeGreaterThan(0.01);

  const clientId = await page.evaluate((c) => localStorage.getItem(`hive:clientId:${c}`), code);
  host.send({ type: "KICK", clientId: clientId! });

  await expect(page.getByRole("heading", { name: "Removed from hive" })).toBeVisible({ timeout: 10_000 });
  // The engine keeps its scheduled sources unless the page tears it down; a closed context is silent.
  await expect.poll(async () => (await audio(page)).ctxState, { timeout: 5_000 }).toBe("closed");

  host.close();
  await context.close();
});
