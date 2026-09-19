/**
 * The HiveMusic room server. `createServer()` is the seam the tests use: it takes config overrides,
 * binds a port, and returns handles for the registry and a clean shutdown.
 *
 * Three periodic jobs run process-wide rather than per room, so a room costs no timers of its own
 * beyond its coalescer: HEALTH to hosts at HEALTH_HZ, PING to everyone every PING_INTERVAL_MS, and
 * a reaper that drops stale client records and idle rooms.
 */
import { HEALTH_HZ, PING_INTERVAL_MS, PROTOCOL_VERSION } from "@hive/protocol";
import { loadConfig, type ServerConfig, type ServerConfigOverrides } from "./config";
import { TrackLibrary } from "./library";
import { handleRest } from "./rest";
import { RoomRegistry } from "./rooms";
import { onClose, onMessage, onOpen, type WsData, type WsDeps } from "./ws";

export interface HiveServer {
  port: number;
  config: ServerConfig;
  rooms: RoomRegistry;
  library: TrackLibrary;
  /** Resolves once the track library has been scanned. */
  ready: Promise<void>;
  stop(): void;
}

export function createServer(overrides: ServerConfigOverrides = {}): HiveServer {
  const config = loadConfig(overrides);
  const library = new TrackLibrary(config.fixturesDir);
  const log = config.quiet ? () => {} : (...a: unknown[]) => console.log("[hive]", ...a);

  let server: Bun.Server<WsData> | null = null;
  const rooms = new RoomRegistry(
    (code) => (payload) => {
      server?.publish(code, payload);
    },
    { fixedCode: config.roomFixedCode, fixedHostKey: config.hostKey },
  );
  const wsDeps: WsDeps = { rooms, library, log };

  server = Bun.serve<WsData>({
    port: config.port,
    // Longer than PING_INTERVAL_MS so an idle-but-alive phone is never dropped between heartbeats.
    idleTimeout: 60,
    fetch: (req, srv) => {
      if (new URL(req.url).pathname === "/ws") {
        return srv.upgrade(req, { data: { clientId: null, roomCode: null } })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }
      return handleRest(req, { config, library, rooms });
    },
    websocket: {
      open: (ws) => onOpen(ws),
      message: (ws, raw) => onMessage(ws, raw, wsDeps),
      close: (ws) => onClose(ws, wsDeps),
    },
  });

  const healthTimer = setInterval(() => {
    for (const room of rooms.all()) room.publishHealth();
  }, 1000 / HEALTH_HZ);
  const pingTimer = setInterval(() => {
    for (const room of rooms.all()) room.publishPing();
  }, PING_INTERVAL_MS);
  const reaper = setInterval(() => rooms.reap(), 30_000);

  const ready = (async () => {
    const tracks = await library.load();
    if (config.roomFixedCode) rooms.create(config.roomFixedCode);
    log(
      `listening on http://localhost:${server!.port} ws://localhost:${server!.port}/ws`,
      `(protocol v${PROTOCOL_VERSION}, cors ${config.corsOrigin})`,
      `· tracks: ${tracks.map((t) => t.id).join(", ")}`,
      config.roomFixedCode ? `· fixed room ${config.roomFixedCode}` : "",
    );
  })();

  return {
    port: server.port ?? config.port,
    config,
    rooms,
    library,
    ready,
    stop() {
      clearInterval(healthTimer);
      clearInterval(pingTimer);
      clearInterval(reaper);
      rooms.disposeAll();
      server?.stop(true);
    },
  };
}
