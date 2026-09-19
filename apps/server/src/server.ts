/**
 * The HiveMusic room server. `createServer()` is the seam the tests use: it takes config overrides,
 * binds a port, and returns handles for the registry and a clean shutdown.
 */
import { PROTOCOL_VERSION } from "@hive/protocol";
import { loadConfig, type ServerConfig, type ServerConfigOverrides } from "./config";
import { TrackLibrary } from "./library";
import { handleRest } from "./rest";
import { RoomRegistry } from "./rooms";

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

  let server: Bun.Server<undefined> | null = null;
  const rooms = new RoomRegistry(
    (code) => (payload) => {
      server?.publish(code, payload);
    },
    { fixedCode: config.roomFixedCode, fixedHostKey: config.hostKey },
  );

  server = Bun.serve({
    port: config.port,
    idleTimeout: 60,
    fetch: (req) => handleRest(req, { config, library, rooms }),
  });

  const reaper = setInterval(() => rooms.reap(), 30_000);

  const ready = (async () => {
    const tracks = await library.load();
    if (config.roomFixedCode) rooms.create(config.roomFixedCode);
    log(
      `listening on http://localhost:${server!.port} (protocol v${PROTOCOL_VERSION}, cors ${config.corsOrigin})`,
      `· tracks: ${tracks.map((t) => t.id).join(", ")}`,
    );
  })();

  return {
    port: server.port ?? config.port,
    config,
    rooms,
    library,
    ready,
    stop() {
      clearInterval(reaper);
      rooms.disposeAll();
      server?.stop(true);
    },
  };
}
