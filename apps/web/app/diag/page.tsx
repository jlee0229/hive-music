"use client";

import { useEffect, useState } from "react";
import { PROTOCOL_VERSION } from "@hive/protocol";
import { detectDevice } from "@hive/sync-client";
import { useHiveClient } from "@/lib/hive/useHiveClient";
import { formatMs } from "@/lib/hive/derive";
import { buildDiagReport } from "@/lib/hive/diagReport";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b py-2 text-sm" style={{ borderColor: "var(--border)" }}>
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

/** The server's JOIN schema: 3–8 characters. */
const isPossibleCode = (code: string) => code.length >= 3 && code.length <= 8;

export default function DiagPage() {
  // No default: the old one was the fixed demo code, which no longer exists anywhere.
  const [roomCode, setRoomCode] = useState("");
  const [joined, setJoined] = useState(false);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-6">
      <h1 className="font-display text-2xl font-bold">/diag</h1>
      <p className="text-sm" style={{ color: "var(--muted)" }}>
        The 30-second phone checklist. Connects like a player would; shows the live sync numbers.
      </p>

      {!joined ? (
        <label className="flex flex-col gap-1 rounded-2xl border p-4 text-xs" style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--muted)" }}>
          Room code
          <input
            value={roomCode}
            onChange={(e) => setRoomCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
            placeholder="CODE"
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            className="font-mono h-12 rounded-xl border px-3 text-lg tracking-widest uppercase outline-none focus-visible:border-[color:var(--text)]"
            style={{ background: "var(--stage)", borderColor: "var(--border)", color: "var(--text)" }}
          />
        </label>
      ) : null}

      {/*
        Keyed on the code: useHiveClient builds its client once, from the code it was first rendered
        with, and does not rebuild it when the code changes. With the session inline this page
        connected to its *default* code whatever was typed into the box — so once room codes became
        random, /diag could not reach any real hive. A fresh session per code fixes that from here;
        the input stays outside so typing does not remount it.
      */}
      <DiagSession key={roomCode} roomCode={roomCode} joined={joined} onJoined={() => setJoined(true)} />
    </main>
  );
}

function DiagSession({ roomCode, joined, onJoined }: { roomCode: string; joined: boolean; onJoined: () => void }) {
  const [wakeLockState, setWakeLockState] = useState("unknown");
  const [audioSessionType, setAudioSessionType] = useState("unavailable");
  const [copied, setCopied] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { client, room, connection, status, audio } = useHiveClient({
    roomCode,
    kind: "player",
    plays: true,
    name: "diag",
  });

  useEffect(() => {
    const nav = navigator as Navigator & { audioSession?: { type: string }; wakeLock?: unknown };
    setAudioSessionType(nav.audioSession?.type ?? "unavailable");
    setWakeLockState(nav.wakeLock ? "supported (not requested by /diag)" : "unsupported");
  }, []);

  useEffect(() => {
    return client.on("error", (code, message) => {
      if (code === "NO_ROOM") setError(`No hive is running at code ${roomCode}.`);
      else if (code === "BAD_MESSAGE") setError(`The server refused the join: ${message}`);
    });
  }, [client, roomCode]);

  const device = detectDevice();

  async function connectNow() {
    setError(null);
    setConnecting(true);
    // unlock() starts inside the tap but does not gate the connection (see the player page).
    void client.audio.unlock().catch(() => {});
    // connect() only settles on WELCOME or a refusal; against an unreachable server it retries
    // forever. For a diagnostics page that is itself the finding, so show the numbers after 5 s.
    const outcome = await Promise.race([
      client.connect().then(
        () => "joined" as const,
        () => "refused" as const, // NO_ROOM / BAD_MESSAGE: reported by the error handler above
      ),
      new Promise<"slow">((resolve) => setTimeout(() => resolve("slow"), 5000)),
    ]);
    setConnecting(false);
    if (outcome !== "refused") onJoined();
  }

  async function copyReport() {
    const report = buildDiagReport(client, device, wakeLockState, audioSessionType);
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API can be blocked (permissions, non-HTTPS); nothing else to do from here
    }
  }

  if (!joined) {
    return (
      <>
        <button
          onClick={connectNow}
          disabled={connecting || !isPossibleCode(roomCode)}
          className="flex h-14 items-center justify-center rounded-2xl text-lg font-semibold disabled:opacity-60"
          style={{ background: "var(--primary-fill)", color: "var(--primary-text)" }}
        >
          {connecting ? "Connecting…" : "Tap to connect"}
        </button>
        {error ? (
          <p role="alert" className="text-center text-sm" style={{ color: "var(--health-bad)" }}>
            {error}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-1 rounded-2xl border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
      <Row label="clientId" value={client.clientId} />
      <Row label="protocolVersion" value={String(PROTOCOL_VERSION)} />
      <Row label="connection" value={connection} />
      <Row label="rttMs" value={formatMs(status.rttMs)} />
      <Row label="clockOffsetMs" value={formatMs(status.clockOffsetMs)} />
      <Row label="syncErrMs" value={formatMs(status.syncErrMs)} />
      <Row label="outputLatencyMs" value={formatMs(status.outputLatencyMs)} />
      <Row label="compensationMs" value={formatMs(status.compensationMs)} />
      <Row label="audio.state" value={audio.state} />
      <Row label="audio.loadProgress" value={`${Math.round(audio.loadProgress * 100)}%`} />
      <Row label="browserFamily" value={device.browserFamily} />
      <Row label="platform" value={device.platform} />
      <Row label="wakeLock" value={wakeLockState} />
      <Row label="navigator.audioSession?.type" value={audioSessionType} />
      <Row label="room.code" value={room?.code ?? "—"} />
      <Row label="room.track" value={room?.track?.title ?? "—"} />

      <button
        onClick={copyReport}
        className="mt-3 flex h-12 items-center justify-center rounded-2xl text-[15px] font-semibold"
        style={{ background: "var(--primary-fill)", color: "var(--primary-text)" }}
      >
        {copied ? "Copied!" : "Copy report"}
      </button>
    </div>
  );
}
