/**
 * The party harness: a REAL @hive/server process, the REAL web app (production build) and the REAL
 * Web Audio engine, with one browser context per simulated phone. See playwright.party.config.ts
 * for how to run it and the env it needs.
 *
 * Nothing here imports application code at runtime (types only): the harness watches the party the
 * way a person with a packet sniffer and a sound-level meter would — WebSocket frames, the audio
 * graph's output, the screen.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import type { ClientRecord, RoomState } from "@hive/protocol";
import { instrumentPage } from "./instrument";

export const SERVER_PORT = Number(process.env.HIVE_SERVER_PORT ?? 8910);
export const WEB_PORT = Number(process.env.PW_WEB_PORT ?? 3210);
export const API = `http://localhost:${SERVER_PORT}`;
export const REPO_ROOT = resolve(__dirname, "../../../..");
export const OUT_DIR = process.env.PARTY_OUT_DIR ?? resolve(__dirname, "../../test-results/party");
mkdirSync(OUT_DIR, { recursive: true });

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const wallNow = () => performance.timeOrigin + performance.now();

// ---------------------------------------------------------------------------------------------
// The server process
// ---------------------------------------------------------------------------------------------

export interface ServerHandle {
  pid: number;
  fixturesDir: string;
  log(): string;
  health(): Promise<Record<string, number | boolean> | null>;
  stats(): Promise<{ rssMb: number; privateMb: number | null; cpuMs: number } | null>;
  /** Hard kill (what a crash or a redeploy's SIGKILL looks like on Windows). */
  kill(): Promise<void>;
}

export interface SeedTrack {
  id: string;
  title: string;
  seconds: number;
  bpm?: number;
  toneHz?: number;
}

/** A private fixtures dir holding only the synthetic pair (plus `seed`), so nothing touches the repo's library. */
export function makeFixturesDir(seed: SeedTrack[] = [], opts: { synthetic?: boolean | string[] } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "hive-party-"));
  mkdirSync(join(dir, "tracks"), { recursive: true });
  for (const id of opts.synthetic === false ? [] : Array.isArray(opts.synthetic) ? opts.synthetic : ["synthetic-60s", "synthetic-30s-lite"]) {
    const src = join(REPO_ROOT, "fixtures", "tracks", id);
    if (!existsSync(join(src, "drums.wav"))) throw new Error(`missing ${src}/*.wav — run \`bun run fixtures\` first`);
    cpSync(src, join(dir, "tracks", id), { recursive: true });
  }
  // One-stem shared tracks, as an upload from before owned uploads would look on disk.
  seed.forEach((t, i) => {
    const d = join(dir, "tracks", t.id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "mix.wav"), makeWav(t.seconds, { bpm: t.bpm, toneHz: t.toneHz }));
    writeFileSync(join(d, "meta.json"), JSON.stringify({ id: t.id, title: t.title, durationSec: t.seconds, stems: ["mix"], order: i }, null, 2));
  });
  return dir;
}

export async function startServer(fixturesDir: string = makeFixturesDir(), extraEnv: Record<string, string> = {}): Promise<ServerHandle> {
  const bun = process.env.BUN_BIN ?? "bun";
  let log = "";
  const child: ChildProcess = spawn(bun, ["src/index.ts"], {
    cwd: join(REPO_ROOT, "apps", "server"),
    env: { ...process.env, PORT: String(SERVER_PORT), FIXTURES_DIR: fixturesDir, NEXT_PUBLIC_WEB_URL: `http://localhost:${WEB_PORT}`, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => (log += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (log += d.toString()));
  const health = async () => {
    try {
      const res = await fetch(`${API}/health`);
      return res.ok ? ((await res.json()) as Record<string, number | boolean>) : null;
    } catch {
      return null;
    }
  };
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    up = (await health()) !== null;
    if (!up) await sleep(100);
  }
  if (!up) {
    child.kill();
    throw new Error(`server did not come up on :${SERVER_PORT}\n${log}`);
  }
  const pid = child.pid!;
  return {
    pid,
    fixturesDir,
    log: () => log,
    health,
    stats: () => procStats(pid),
    kill: () =>
      new Promise<void>((res) => {
        if (child.exitCode !== null) return res();
        child.once("exit", () => res());
        child.kill();
        setTimeout(res, 3000);
      }),
  };
}

function procStats(pid: number): Promise<{ rssMb: number; privateMb: number | null; cpuMs: number } | null> {
  return new Promise((res) => {
    if (process.platform !== "win32") {
      execFile("ps", ["-o", "rss=,cputime=", "-p", String(pid)], (err, out) => {
        const m = out?.trim().match(/^(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
        if (err || !m) return res(null);
        const cpuSec = Number(m[2] ?? 0) * 86400 + Number(m[3] ?? 0) * 3600 + Number(m[4]) * 60 + Number(m[5]);
        res({ rssMb: Math.round(Number(m[1]) / 1024), privateMb: null, cpuMs: cpuSec * 1000 });
      });
      return;
    }
    const cmd = `$p = Get-Process -Id ${pid} -ErrorAction Stop; "$($p.WorkingSet64) $($p.PrivateMemorySize64) $([math]::Round($p.TotalProcessorTime.TotalMilliseconds))"`;
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], (err, out) => {
      const m = out?.trim().match(/^(\d+) (\d+) (\d+)$/);
      if (err || !m) return res(null);
      res({ rssMb: Math.round(Number(m[1]) / 1048576), privateMb: Math.round(Number(m[2]) / 1048576), cpuMs: Number(m[3]) });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// One simulated phone
// ---------------------------------------------------------------------------------------------

export interface PageIssue {
  device: string;
  at: number;
  kind: "console.error" | "pageerror" | "requestfailed" | "http" | "server-error-frame";
  text: string;
}

interface CtxSnap {
  state: string;
  currentTime: number;
  wallAtRead: number;
  sampleRate: number;
  outputLatencyMs: number;
  baseLatencyMs: number;
  out: { contextTime: number; wall: number } | null;
  live: Array<{ id: number; buf: number; pos: number; posOut: number | null; when: number; offset: number; dur: number; rate: number }>;
  pending: number;
  rms: number;
  peakHz: number;
}
interface PageSnap {
  wall: number;
  ctxs: CtxSnap[];
  rms: number;
  rmsMax1s: number;
  stallMs20s: number;
  seen: Record<string, number>;
  contextsCreated: number;
  startCalls: number;
  visibility: string;
  text: string;
  heapMb: number | null;
}

export interface DeviceSample {
  name: string;
  /** The socket as the harness sees it. */
  wsOpen: boolean;
  connected: boolean | null;
  screen: string;
  ctxState: string | null;
  rms: number;
  rmsMax1s: number;
  sounding: boolean;
  /** Track position this phone is emitting, s (newest live branch), or null when nothing is scheduled to sound. */
  posSec: number | null;
  /** What the server transport says the position is at the same instant, s (negative = the start is still ahead). */
  expectedSec: number | null;
  /** posSec − expectedSec, ms. Positive = ahead. Includes the phone's deliberate lead (compensation, output latency) and delay (WAVE). */
  errMs: number | null;
  /** The lead the engine means to apply: compensation − delay (+ outputLatency when the server has no number for this phone). */
  intendedLeadMs: number | null;
  /** errMs − intendedLeadMs: what is left is this phone's real sync error. */
  residualMs: number | null;
  liveBranches: number;
  /** Id of the AudioBuffer the newest live branch plays (changes when CHOIR swaps in a pitched render). */
  bufferId: number | null;
  /** Longest gap in the page's 50 ms sampler over the last 20 s: main-thread stall, ms. */
  stallMs: number | null;
  startCalls: number;
  /** Strongest spectral component above 150 Hz in what this phone is emitting, Hz (bin width ~23 Hz). */
  peakHz: number | null;
  rate: number | null;
  role: string | null;
  label: string | null;
  audioStateReported: string | null;
  syncErrReported: number | null;
  trackId: string | null;
  transport: string | null;
  mode: string | null;
  text: string;
  seen: Record<string, number>;
  heapMb: number | null;
}

export const SOUND_RMS = 0.003;
/** The same flags playwright.party.config.ts launches the first browser with. */
export const LAUNCH_ARGS = ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];
const DEVICES_PER_BROWSER = 40;

export class Device {
  readonly issues: PageIssue[] = [];
  room: RoomState | null = null;
  welcome: { clientId: string; isHost: boolean } | null = null;
  lastStatus: { rttMs: number | null; syncErrMs: number | null; outputLatencyMs: number | null; audioState: string } | null = null;
  readonly serverErrors: Array<{ at: number; code: string; message: string }> = [];
  readonly wsLog: Array<{ at: number; event: "open" | "close" | "welcome" }> = [];
  readonly sent: Array<{ at: number; type: string; detail?: string }> = [];
  readonly stateBytes: number[] = [];
  /** Every stem download this phone made: when it was asked for and when the last byte arrived (node wall clock). */
  readonly audioFetches: Array<{ track: string; stem: string; at: number; doneAt: number | null }> = [];
  openSockets = 0;
  private clockOffset: { offsetMs: number; at: number } | null = null;

  constructor(
    readonly name: string,
    readonly kind: "host" | "guest",
    readonly context: BrowserContext,
    public page: Page,
  ) {
    this.attach(page);
  }

  attach(page: Page) {
    const push = (kind: PageIssue["kind"], text: string) => this.issues.push({ device: this.name, at: wallNow(), kind, text: text.slice(0, 400) });
    page.on("console", (m) => {
      if (m.type() === "error") push("console.error", `${m.text()} @ ${m.location().url}`);
    });
    page.on("pageerror", (e) => push("pageerror", `${e.name}: ${e.message}`));
    page.on("requestfailed", (r) => push("requestfailed", `${r.method()} ${r.url()} — ${r.failure()?.errorText ?? "?"}`));
    page.on("request", (r) => {
      const m = r.url().match(/\/audio\/([^/]+)\/([^/.]+)\.wav/);
      if (!m) return;
      const entry = { track: m[1]!, stem: m[2]!, at: wallNow(), doneAt: null as number | null };
      this.audioFetches.push(entry);
      void r.response().then((res) => res?.finished()).then(() => (entry.doneAt = wallNow()), () => {});
    });
    page.on("response", (r) => {
      if (r.status() >= 400) push("http", `${r.status()} ${r.request().method()} ${r.url()}`);
    });
    page.on("websocket", (ws) => {
      if (!ws.url().includes("/ws")) return;
      this.openSockets++;
      this.wsLog.push({ at: wallNow(), event: "open" });
      ws.on("close", () => {
        this.openSockets--;
        this.wsLog.push({ at: wallNow(), event: "close" });
      });
      ws.on("framereceived", (f) => {
        if (typeof f.payload !== "string") return;
        let msg: { type?: string; room?: RoomState; clientId?: string; isHost?: boolean; code?: string; message?: string };
        try {
          msg = JSON.parse(f.payload);
        } catch {
          return;
        }
        if (msg.type === "ROOM_STATE" && msg.room) {
          this.room = msg.room;
          this.stateBytes.push(f.payload.length);
          if (this.stateBytes.length > 2000) this.stateBytes.splice(0, 1000);
        } else if (msg.type === "WELCOME") {
          this.welcome = { clientId: msg.clientId!, isHost: !!msg.isHost };
          this.wsLog.push({ at: wallNow(), event: "welcome" });
        } else if (msg.type === "ERROR") {
          this.serverErrors.push({ at: wallNow(), code: msg.code ?? "?", message: msg.message ?? "" });
          push("server-error-frame", `${msg.code}: ${msg.message}`);
        }
      });
      ws.on("framesent", (f) => {
        if (typeof f.payload !== "string") return;
        try {
          const msg = JSON.parse(f.payload) as { type: string; action?: string; mode?: string; trackId?: string } & Device["lastStatus"];
          if (msg.type === "CLIENT_STATUS") this.lastStatus = { rttMs: msg.rttMs, syncErrMs: msg.syncErrMs, outputLatencyMs: msg.outputLatencyMs, audioState: msg.audioState };
          else if (msg.type !== "NTP_REQUEST" && msg.type !== "PONG" && msg.type !== "SET_POSITION")
            this.sent.push({ at: wallNow(), type: msg.type, detail: msg.action ?? msg.mode ?? msg.trackId });
        } catch {
          /* not JSON: not ours */
        }
      });
    });
  }

  get clientId(): string | null {
    return this.welcome?.clientId ?? null;
  }
  get me(): ClientRecord | null {
    const id = this.clientId;
    return id && this.room ? (this.room.clients[id] ?? null) : null;
  }

  async snap(): Promise<PageSnap | null> {
    try {
      return (await this.page.evaluate(() => (window as unknown as { __party?: { snap(): unknown } }).__party?.snap() ?? null)) as PageSnap | null;
    } catch {
      return null; // navigating, crashed or closed
    }
  }

  /** Page wall clock → server clock, ms (measured over localhost, refreshed every 20 s). */
  async serverOffsetMs(): Promise<number | null> {
    if (this.clockOffset && wallNow() - this.clockOffset.at < 20_000) return this.clockOffset.offsetMs;
    try {
      const r = (await this.page.evaluate(
        (api) => (window as unknown as { __party?: { clockProbe(a: string): Promise<{ offsetMs: number; rttMs: number } | null> } }).__party?.clockProbe(api) ?? null,
        API,
      )) as { offsetMs: number; rttMs: number } | null;
      if (r) this.clockOffset = { offsetMs: r.offsetMs, at: wallNow() };
      return r?.offsetMs ?? this.clockOffset?.offsetMs ?? null;
    } catch {
      return this.clockOffset?.offsetMs ?? null;
    }
  }

  async sample(): Promise<DeviceSample> {
    const offset = await this.serverOffsetMs();
    const s = await this.snap();
    const me = this.me;
    const a = me?.assignment ?? null;
    const transport = this.room?.transport ?? null;
    // The engine keeps one context; the newest one is the one that matters after a rebuild.
    const ctx = s?.ctxs.at(-1) ?? null;
    const branch = ctx?.live.length ? ctx.live.reduce((x, y) => (y.id > x.id ? y : x)) : null;
    let expectedSec: number | null = null;
    let errMs: number | null = null;
    if (ctx && transport?.state === "playing" && offset !== null) {
      expectedSec = (ctx.wallAtRead + offset - transport.serverTimeAtTrackZero) / 1000;
      // Before the start instant whatever is sounding is the previous song's tail, not this timeline.
      if (branch && expectedSec >= 0) errMs = (branch.pos - expectedSec) * 1000;
    }
    let intendedLeadMs: number | null = null;
    if (a && me && ctx) {
      const useOutputLatency = me.tableLatencyMs == null && me.calibratedOffsetMs == null;
      intendedLeadMs = a.compensationMs - a.delayMs + (useOutputLatency ? ctx.outputLatencyMs : 0);
    }
    const text = s?.text ?? "";
    return {
      name: this.name,
      wsOpen: this.openSockets > 0,
      connected: me?.connected ?? null,
      screen: screenOf(text, this.kind),
      ctxState: ctx?.state ?? null,
      rms: s?.rms ?? 0,
      rmsMax1s: s?.rmsMax1s ?? 0,
      sounding: (s?.rmsMax1s ?? 0) > SOUND_RMS,
      posSec: branch?.pos ?? null,
      expectedSec,
      errMs,
      intendedLeadMs,
      residualMs: errMs !== null && intendedLeadMs !== null ? errMs - intendedLeadMs : null,
      liveBranches: ctx?.live.length ?? 0,
      bufferId: branch?.buf ?? null,
      stallMs: s?.stallMs20s ?? null,
      startCalls: s?.startCalls ?? 0,
      peakHz: ctx?.peakHz ?? null,
      rate: branch?.rate ?? null,
      role: a?.role ?? null,
      label: a?.label ?? null,
      audioStateReported: this.lastStatus?.audioState ?? null,
      syncErrReported: this.lastStatus?.syncErrMs ?? null,
      trackId: this.room?.track?.id ?? null,
      transport: transport?.state ?? null,
      mode: this.room?.mode.kind ?? null,
      text,
      seen: s?.seen ?? {},
      heapMb: s?.heapMb ?? null,
    };
  }

  async ringSince(wall: number): Promise<Array<[number, number]>> {
    try {
      return (await this.page.evaluate((t) => (window as unknown as { __party?: { ringSince(t: number): Array<[number, number]> } }).__party?.ringSince(t) ?? [], wall)) as Array<[number, number]>;
    } catch {
      return [];
    }
  }

  /** Page wall clock of "now", so harness timestamps and ring timestamps share a frame. */
  async pageWall(): Promise<number> {
    return this.page.evaluate(() => performance.timeOrigin + performance.now());
  }

  async screenshot(file: string) {
    try {
      await this.page.screenshot({ path: join(OUT_DIR, file), fullPage: true });
    } catch {
      /* a closed page has nothing to show */
    }
  }

  async close() {
    await this.context.close().catch(() => {});
  }
}

/** Which screen a phone is on, from what it says (role/text, never classes). */
export function screenOf(text: string, kind: "host" | "guest"): string {
  if (!text) return "blank";
  if (kind === "host") {
    if (/Tuning moment/.test(text)) return "host:tuning";
    if (/This hive has ended/.test(text)) return "host:ended";
    if (/hosted on another device/.test(text)) return "host:elsewhere";
    if (/Can.t reach the hive/.test(text)) return "host:unreachable";
    if (/Setting up your hive|Starting the hive…/.test(text)) return "host:splash";
    if (/Up next:/.test(text)) return "host:stage-stopped";
    if (/HOST/.test(text) && /players/.test(text)) return "host:stage-playing";
    if (/Host a hive/.test(text)) return "landing";
    return "host:?";
  }
  if (/Tap to resume|Resuming…/.test(text)) return "guest:resume";
  if (/Removed from hive/.test(text)) return "guest:removed";
  if (/Hive not found/.test(text)) return "guest:not-found";
  if (/Couldn.t join/.test(text)) return "guest:refused";
  if (/Phone \d+ of \d+|Waiting for the hive/.test(text)) return "guest:tuning";
  if (/YOU ARE/.test(text)) return "guest:playing";
  if (/Tap to join|Joining…/.test(text)) return "guest:join";
  if (/Synced|Syncing…/.test(text)) return "guest:ready";
  if (/Host a hive/.test(text)) return "landing";
  return "guest:?";
}

// ---------------------------------------------------------------------------------------------
// The party
// ---------------------------------------------------------------------------------------------

const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const PHONE = { viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

export interface SpreadStats {
  n: number;
  sounding: number;
  residualSpreadMs: number | null;
  residualMaxAbsMs: number | null;
  rawSpreadMs: number | null;
  positionSpreadMs: number | null;
}

export class Party {
  host!: Device;
  code = "";
  readonly guests: Device[] = [];
  readonly closed: Device[] = [];
  readonly notes: string[] = [];
  readonly metrics: Record<string, unknown> = {};

  constructor(
    readonly browser: Browser,
    readonly web: string,
    readonly scenario: string,
  ) {}

  get devices(): Device[] {
    return [this.host, ...this.guests].filter(Boolean);
  }

  note(line: string) {
    this.notes.push(line);
    appendFileSync(join(OUT_DIR, "party.log"), `[${new Date().toISOString()}] ${this.scenario}: ${line}\n`);
  }

  /**
   * Chromium allows about 50 audio output streams per browser process: the 51st AudioContext fails
   * with "The AudioContext encountered an error from the audio device or the WebAudio renderer" and
   * never sounds. A real party is one process per phone, so past 40 devices the harness opens
   * another browser rather than measure the browser's cap.
   */
  private readonly extraBrowsers: Browser[] = [];
  private created = 0;
  private async browserFor(index: number): Promise<Browser> {
    const slot = Math.floor(index / DEVICES_PER_BROWSER);
    if (slot === 0) return this.browser;
    while (this.extraBrowsers.length < slot) {
      const executablePath = process.env.PW_CHROMIUM_PATH;
      this.extraBrowsers.push(await this.browser.browserType().launch({ args: LAUNCH_ARGS, ...(executablePath ? { executablePath } : {}) }));
    }
    return this.extraBrowsers[slot - 1]!;
  }

  async newDevice(name: string, kind: "host" | "guest", opts: { ios?: boolean } = {}): Promise<Device> {
    const browser = await this.browserFor(this.created++);
    const context = await browser.newContext({
      ...PHONE,
      userAgent: opts.ios ? IPHONE_UA : ANDROID_UA,
      permissions: ["microphone"],
      baseURL: this.web,
    });
    await context.addInitScript(instrumentPage);
    const page = await context.newPage();
    return new Device(name, kind, context, page);
  }

  /** Landing → "Host a hive" → the stage. The way a host really arrives. */
  async hostFromLanding(): Promise<string> {
    this.host = await this.newDevice("host", "host");
    const page = this.host.page;
    await page.goto("/");
    await page.getByRole("button", { name: "Host a hive" }).click();
    await page.waitForURL(/\/h\/[A-Z0-9]{4}$/, { timeout: 20_000 });
    this.code = page.url().split("/h/")[1]!;
    await page.getByRole("button", { name: /Start the hive/ }).waitFor({ timeout: 30_000 });
    this.note(`hosted ${this.code}`);
    return this.code;
  }

  async addGuest(name: string, opts: { ios?: boolean; join?: boolean } = {}): Promise<Device> {
    const d = await this.newDevice(name, "guest", opts);
    this.guests.push(d);
    await d.page.goto(`/j/${this.code}`);
    await d.page.getByPlaceholder("Your name").fill(name);
    if (opts.join !== false) await d.page.getByRole("button", { name: "Tap to join" }).click();
    return d;
  }

  async addGuests(n: number, prefix = "Guest", opts: { iosEvery?: number; batch?: number } = {}): Promise<Device[]> {
    const out: Device[] = [];
    const batch = opts.batch ?? 5;
    const base = this.guests.length;
    for (let i = 0; i < n; i += batch) {
      const group = await Promise.all(
        Array.from({ length: Math.min(batch, n - i) }, (_, k) => {
          const idx = base + i + k + 1;
          return this.addGuest(`${prefix} ${idx}`, { ios: opts.iosEvery ? idx % opts.iosEvery === 0 : false });
        }),
      );
      out.push(...group);
    }
    return out;
  }

  async removeGuest(d: Device) {
    const i = this.guests.indexOf(d);
    if (i >= 0) this.guests.splice(i, 1);
    this.closed.push(d);
    await d.close();
  }

  /** Waits until the host's Start button says every phone has the song. */
  async waitAllReady(timeoutMs = 60_000): Promise<number> {
    const t0 = performance.now();
    // By its labels, not its classes: a design pass gave other buttons the same height class.
    const btn = this.host.page.getByRole("button", { name: /^(Starting…|Pick a song|Start the hive|Start anyway|Waiting for phones to load…)$/ });
    while (performance.now() - t0 < timeoutMs) {
      const label = await btn.innerText().catch(() => "");
      const players = Object.values(this.host.room?.clients ?? {}).filter((c) => c.kind === "player" && c.connected).length;
      if (/Start the hive/.test(label) && players >= this.guests.length) return performance.now() - t0;
      await sleep(200);
    }
    throw new Error(`phones never became ready: button says "${await btn.innerText().catch(() => "?")}"`);
  }

  async pressStart() {
    await this.host.page.getByRole("button", { name: /Start the hive|Start anyway/ }).click();
  }

  /** Start → (automatic tuning) → music. Returns ms from the tap to each guest's first sound. */
  async startMusic(timeoutMs = 60_000): Promise<Record<string, number | null>> {
    const t0 = performance.now();
    await this.pressStart();
    while (performance.now() - t0 < timeoutMs && this.host.room?.transport.state !== "playing") await sleep(100);
    if (this.host.room?.transport.state !== "playing") throw new Error("the room never started playing after Start");
    return this.timeToSound(this.guests, t0, timeoutMs);
  }

  /** Host + n guests, every phone ready, music started. */
  async begin(n: number, opts: { iosEvery?: number; song?: string } = {}): Promise<Record<string, number | null>> {
    await this.hostFromLanding();
    await this.addGuests(n, "Guest", { iosEvery: opts.iosEvery });
    if (opts.song) await this.pickSong(opts.song);
    await this.waitAllReady();
    return this.startMusic();
  }

  /** Songs drawer → tap a row. The stage then shows "Up next: <title>" (the transport stops). */
  async pickSong(title: string) {
    const page = this.host.page;
    await page.getByRole("button", { name: "Songs", exact: true }).click();
    await page.getByRole("button").filter({ hasText: title }).first().click();
    await page.getByText(`Up next:`).waitFor({ timeout: 10_000 });
  }

  async pickSongIfNeeded(title: string) {
    for (let i = 0; i < 50 && !this.host.room?.track; i++) await sleep(100);
    if (this.host.room?.track?.title !== title) await this.pickSong(title);
  }

  /** Server clock "now" as the host page sees it. */
  async serverNow(): Promise<number> {
    return (await this.host.pageWall()) + ((await this.host.serverOffsetMs()) ?? 0);
  }

  async setMode(mode: "Unison" | "Orchestra" | "Stereo" | "Wave" | "Strobe" | "Choir") {
    await this.host.page.getByRole("button", { name: mode, exact: true }).click();
    const want = mode.toUpperCase();
    for (let i = 0; i < 50 && this.host.room?.mode.kind !== want; i++) await sleep(100);
  }

  async sampleAll(devices: Device[] = this.devices): Promise<DeviceSample[]> {
    return Promise.all(devices.map((d) => d.sample()));
  }

  spread(samples: DeviceSample[]): SpreadStats {
    const speakers = samples.filter((s) => s.residualMs !== null);
    const res = speakers.map((s) => s.residualMs!);
    const raw = speakers.map((s) => s.errMs!);
    const range = (xs: number[]) => (xs.length ? Math.max(...xs) - Math.min(...xs) : null);
    return {
      n: samples.length,
      sounding: samples.filter((s) => s.sounding).length,
      residualSpreadMs: round(range(res)),
      residualMaxAbsMs: round(res.length ? Math.max(...res.map(Math.abs)) : null),
      rawSpreadMs: round(range(raw)),
      positionSpreadMs: round(range(raw)),
    };
  }

  /** Polls until `count` of the given devices are making sound; returns ms from `sinceWall` per device (null = never). */
  async timeToSound(devices: Device[], sincePerf: number, timeoutMs: number): Promise<Record<string, number | null>> {
    const out: Record<string, number | null> = Object.fromEntries(devices.map((d) => [d.name, null]));
    while (performance.now() - sincePerf < timeoutMs && Object.values(out).some((v) => v === null)) {
      await Promise.all(
        devices.map(async (d) => {
          if (out[d.name] !== null) return;
          const s = await d.snap();
          if (s && s.rms > SOUND_RMS) out[d.name] = Math.round(performance.now() - sincePerf);
        }),
      );
      await sleep(50);
    }
    return out;
  }

  /**
   * Watches the party for `durationMs`, sampling every `everyMs`. Returns the per-tick spread and
   * every tick in which a phone that should be sounding was not.
   */
  async watch(durationMs: number, everyMs = 2000, devices: () => Device[] = () => this.guests) {
    const ticks: Array<{ atSec: number; spread: SpreadStats; silent: string[]; samples: DeviceSample[] }> = [];
    const t0 = performance.now();
    while (performance.now() - t0 < durationMs) {
      const samples = await this.sampleAll(devices());
      ticks.push({
        atSec: round((performance.now() - t0) / 1000)!,
        spread: this.spread(samples),
        silent: samples.filter((s) => !s.sounding).map((s) => s.name),
        samples,
      });
      const left = everyMs - ((performance.now() - t0) % everyMs);
      await sleep(Math.min(left, Math.max(0, durationMs - (performance.now() - t0))));
    }
    return ticks;
  }

  /**
   * Dead air across a set of phones: merges every phone's 20 Hz RMS ring into 100 ms buckets and
   * returns the stretches in which no phone at all was above the sound threshold.
   */
  async deadAir(devices: Device[], fromWall: number, toWall: number, bucketMs = 100): Promise<{ gaps: Array<{ atSec: number; ms: number }>; longestMs: number; coveredPct: number; perDeviceSoundingPct: Record<string, number> }> {
    const rings = await Promise.all(devices.map((d) => d.ringSince(fromWall)));
    const n = Math.max(1, Math.floor((toWall - fromWall) / bucketMs));
    const loud = new Array<boolean>(n).fill(false);
    const have = new Array<boolean>(n).fill(false);
    const perDeviceSoundingPct: Record<string, number> = {};
    rings.forEach((ring, k) => {
      let on = 0;
      let total = 0;
      for (const [t, rms] of ring) {
        if (t > toWall) break;
        const i = Math.floor((t - fromWall) / bucketMs);
        if (i < 0 || i >= n) continue;
        have[i] = true;
        total++;
        if (rms > SOUND_RMS) {
          loud[i] = true;
          on++;
        }
      }
      perDeviceSoundingPct[devices[k]!.name] = total ? Math.round((100 * on) / total) : 0;
    });
    const gaps: Array<{ atSec: number; ms: number }> = [];
    let run = 0;
    for (let i = 0; i <= n; i++) {
      if (i < n && have[i] && !loud[i]) run++;
      else {
        if (run > 0) gaps.push({ atSec: round(((i - run) * bucketMs) / 1000)!, ms: run * bucketMs });
        run = 0;
      }
    }
    const covered = loud.filter(Boolean).length;
    return { gaps, longestMs: gaps.reduce((m, g) => Math.max(m, g.ms), 0), coveredPct: Math.round((100 * covered) / n), perDeviceSoundingPct };
  }

  /** Everything any context logged, as (text, count, devices) — the report's raw material. */
  issues(): Array<{ kind: string; text: string; count: number; devices: string[] }> {
    const by = new Map<string, { kind: string; text: string; count: number; devices: Set<string> }>();
    for (const d of [...this.devices, ...this.closed]) {
      for (const i of d.issues) {
        // Collapse ids/ports so one bug is one line.
        const text = i.text.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<uuid>").replace(/\/rooms\/[A-Z0-9]{4}/g, "/rooms/<code>");
        const key = `${i.kind}|${text}`;
        const e = by.get(key) ?? { kind: i.kind, text, count: 0, devices: new Set<string>() };
        e.count++;
        e.devices.add(d.name);
        by.set(key, e);
      }
    }
    return [...by.values()].map((e) => ({ kind: e.kind, text: e.text, count: e.count, devices: [...e.devices].slice(0, 8) }));
  }

  /**
   * issues() minus what is known to be harmless in any scenario:
   *  - Next's <Link> prefetch of /qr/CODE (an RSC request) aborted when the stage re-renders;
   *  - the upload's duration probe dropping its blob: URL (apps/web/lib/hive/upload-track.ts).
   */
  unexpectedIssues(alsoBenign?: RegExp) {
    return this.issues().filter((i) => !/\?_rsc=.*ERR_ABORTED|GET blob:.*ERR_ABORTED/.test(i.text) && !(alsoBenign && alsoBenign.test(i.text)));
  }

  async screenshots(tag: string) {
    await this.host?.screenshot(`${this.scenario}-${tag}-host.png`);
    await this.guests[0]?.screenshot(`${this.scenario}-${tag}-guest.png`);
  }

  /** Writes the scenario's numbers, notes and every collected issue to <OUT_DIR>/<scenario>.json. */
  report(extra: Record<string, unknown> = {}) {
    const body = { scenario: this.scenario, code: this.code, at: new Date().toISOString(), metrics: { ...this.metrics, ...extra }, notes: this.notes, issues: this.issues() };
    writeFileSync(join(OUT_DIR, `${this.scenario}.json`), JSON.stringify(body, null, 2));
    return body;
  }

  async close() {
    await Promise.all([...this.devices].map((d) => d.close()));
    await Promise.all(this.extraBrowsers.map((b) => b.close().catch(() => {})));
  }
}

export function round(x: number | null, digits = 1): number | null {
  if (x === null || !Number.isFinite(x)) return null;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** A compact line per device for logs. */
export function line(s: DeviceSample): string {
  return `${s.name.padEnd(10)} ${s.screen.padEnd(20)} ctx=${s.ctxState ?? "-"} rms=${s.rmsMax1s.toFixed(3)} pos=${s.posSec?.toFixed(3) ?? "-"} err=${round(s.errMs) ?? "-"} lead=${round(s.intendedLeadMs) ?? "-"} resid=${round(s.residualMs) ?? "-"} role=${s.label ?? "-"} br=${s.liveBranches}`;
}

/** 16-bit mono WAV: a kick on every beat over a tone — something the tempo detector can chew on. */
export function makeWav(seconds: number, opts: { bpm?: number; toneHz?: number; rate?: number } = {}): Buffer {
  const rate = opts.rate ?? 44100;
  const beat = 60 / (opts.bpm ?? 120);
  const tone = opts.toneHz ?? 440;
  const n = Math.floor(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const b = t % beat;
    const kick = b < 0.05 ? Math.sin(2 * Math.PI * 60 * b) * (1 - b / 0.05) : 0;
    buf.writeInt16LE(Math.round(32767 * (0.7 * kick + 0.25 * Math.sin(2 * Math.PI * tone * t))), 44 + i * 2);
  }
  return buf;
}
