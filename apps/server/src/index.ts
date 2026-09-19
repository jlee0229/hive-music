// Entry point: `bun run --cwd apps/server dev`. Everything interesting is in server.ts.
import { createServer } from "./server";

const hive = createServer();
await hive.ready;

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    hive.stop();
    process.exit(0);
  });
}
