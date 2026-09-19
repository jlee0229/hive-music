/**
 * Server configuration. Every knob is an env var so `fly secrets set` is the only deploy step.
 * Tests pass overrides to `createServer()` instead of mutating the environment.
 */
export interface ServerConfig {
  port: number;
  /** Value of Access-Control-Allow-Origin on every route (the Vercel origin in production). */
  corsOrigin: string;
  /** Directory holding `tracks/<id>/meta.json` + the WAV stems. */
  fixturesDir: string;
  /** When set, `POST /rooms` always returns this code, so the demo QR survives a restart. */
  roomFixedCode: string | null;
  /** Base of the join link handed back by `POST /rooms`. */
  webUrl: string;
  /** Model id for the Vibe Director (B6). */
  vibeModel: string;
  /** Host key for the fixed demo room; generated per process when unset. */
  hostKey: string | null;
  quiet: boolean;
}

export type ServerConfigOverrides = Partial<ServerConfig>;

const DEFAULT_FIXTURES_DIR = `${import.meta.dir}/../../../fixtures`;

export function loadConfig(overrides: ServerConfigOverrides = {}): ServerConfig {
  return {
    port: Number(process.env.PORT ?? 8080),
    corsOrigin: process.env.CORS_ORIGIN ?? "*",
    fixturesDir: process.env.FIXTURES_DIR ?? DEFAULT_FIXTURES_DIR,
    roomFixedCode: process.env.ROOM_FIXED_CODE ? process.env.ROOM_FIXED_CODE.toUpperCase() : null,
    webUrl: process.env.NEXT_PUBLIC_WEB_URL ?? "http://localhost:3000",
    vibeModel: process.env.VIBE_MODEL ?? "claude-sonnet-5",
    hostKey: process.env.HOST_KEY ?? null,
    quiet: process.env.QUIET === "1",
    ...overrides,
  };
}
