// Backend agent: see agents/BACKEND-AGENT.md. Everything else is yours to build.
import { PROTOCOL_VERSION } from "@hive/protocol";

const PORT = Number(process.env.PORT ?? 8080);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "*";

const corsHeaders = {
  "Access-Control-Allow-Origin": CORS_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        serverTime: performance.timeOrigin + performance.now(),
      });
    }

    return json({ error: "not_found", path: url.pathname }, 404);
  },
});

console.log(
  `[hive-server] listening on http://localhost:${server.port} (protocol v${PROTOCOL_VERSION}, cors ${CORS_ORIGIN})`,
);
