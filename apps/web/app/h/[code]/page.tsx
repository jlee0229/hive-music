"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { TrackLibraryEntry } from "@hive/protocol";
import { reconnectDelayMs, type CalibrationProgress } from "@hive/sync-client";
import { useHiveClient } from "@/lib/hive/useHiveClient";
import { apiUrl, engineKind } from "@/lib/hive/client";
import { fileToMonoWav, postTrack, titleFromFilename } from "@/lib/hive/upload-track";
import { clearHostKey, getHostKey, setHostKey } from "@/lib/hive/storage";
import { classifyHostClaim } from "@/lib/hive/host-claim";
import { planStart, showTuningScreen, tuningNote } from "@/lib/hive/start-flow";
import { HOST_TOAST_MS, hostErrorText } from "@/lib/hive/host-errors";
import { safeAreaPadding } from "@/lib/hive/safe-area";
import { ReconnectBanner } from "@/components/ReconnectBanner";
import { ProtocolMismatchBanner } from "@/components/ProtocolMismatchBanner";
import { TransportBar } from "@/components/TransportBar";
import { HiveMap, partsApply } from "@/components/HiveMap";
import { ModeChips } from "@/components/ModeChips";
import { StrobeControls } from "@/components/StrobeControls";
import { VibeBox } from "@/components/VibeBox";
import { SceneStrip } from "@/components/SceneStrip";
import { HostCalibrate } from "@/components/HostCalibrate";
import { Legend } from "@/components/Legend";
import { PlayerSheet } from "@/components/PlayerSheet";
import { PlayersDrawer } from "@/components/PlayersDrawer";
import { SongsDrawer } from "@/components/SongsDrawer";
import { Creators } from "@/components/Creators";

/** Why this phone cannot host this code right now; each renders a screen with a way out (lib/hive/host-claim.ts). */
type HostProblem = "ended" | "elsewhere" | "unreachable";

/**
 * Bootstraps (or recovers) the hostKey, then mounts HostRoom keyed on that hostKey. A room can be
 * re-created server-side with a fresh key (a Fly restart, or the idle-room timeout) out from under
 * an already-open host tab; HostRoom calls onDemoted the moment it notices, and remounting by key
 * gives it a genuinely fresh HiveClient rather than trying to mutate an already-connected one.
 */
export default function HostPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const roomCode = code.toUpperCase();

  // The stored key is read after mount, not in the initial state: the server render cannot see
  // localStorage, so a key in the first client render made every reload a hydration mismatch
  // (React threw the server HTML away and logged an error).
  const [hostKeyState, setHostKeyState] = useState<string | null>(null);
  const [storageRead, setStorageRead] = useState(false);
  useEffect(() => {
    const stored = getHostKey(roomCode);
    if (stored) setHostKeyState(stored);
    setStorageRead(true);
  }, [roomCode]);
  const [problem, setProblem] = useState<HostProblem | null>(null);
  const [recoveryClientId, setRecoveryClientId] = useState<string | null>(null);
  const recoveryAttemptedRef = useRef(false);

  const claimHostKey = useCallback(async () => {
    let status: number | null = null;
    let body: unknown = null;
    try {
      const res = await fetch(`${apiUrl()}/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: roomCode }),
      });
      status = res.status;
      body = await res.json().catch(() => null);
    } catch {
      /* network error: status stays null */
    }
    const claim = classifyHostClaim(status, body);
    if (claim.kind === "ok") {
      setHostKey(claim.code, claim.hostKey);
      setHostKeyState(claim.hostKey);
    } else {
      setProblem(claim.kind);
    }
  }, [roomCode]);

  useEffect(() => {
    if (!storageRead || hostKeyState || problem) return;
    let cancelled = false;
    (async () => {
      if (!cancelled) await claimHostKey();
    })();
    return () => {
      cancelled = true;
    };
  }, [storageRead, hostKeyState, problem, claimHostKey]);

  const handleDemoted = useCallback(() => {
    // At most one automatic recovery per page load: a second demotion right after a re-claimed
    // key means re-asking isn't the fix (someone else holds this hive), so loop no further.
    if (recoveryAttemptedRef.current) {
      setProblem("elsewhere");
      return;
    }
    recoveryAttemptedRef.current = true;
    // A fresh clientId for the retry: the room already has a record under the old one, now
    // demoted to kind: player, and both the mock and the real server carry an existing record's
    // kind/plays forward untouched on reconnect (they only decide kind for a brand-new id) -- so
    // reusing it would keep landing as a player even once this hostKey is the correct one.
    setRecoveryClientId(crypto.randomUUID());
    // Clearing this alone is enough: the bootstrap effect below re-fetches whenever hostKeyState
    // is falsy, so calling claimHostKey() here too would just race a duplicate POST.
    setHostKeyState(null);
  }, []);

  // The server answered NO_ROOM to our JOIN: it restarted (rooms live in memory) or the hive idled
  // out. Nothing on this page can work any more, and the stored key is for a room that is gone.
  const handleGone = useCallback(() => {
    clearHostKey(roomCode);
    setProblem("ended");
  }, [roomCode]);

  if (problem) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="font-display text-2xl font-bold">
          {problem === "ended" ? "This hive has ended" : problem === "elsewhere" ? "This hive is hosted on another phone" : "Can’t reach the hive"}
        </h1>
        {problem === "unreachable" ? (
          <button
            onClick={() => setProblem(null)}
            className="flex h-13 items-center justify-center rounded-2xl px-6 font-semibold"
            style={{ height: 52, background: "var(--primary-fill)", color: "var(--primary-text)" }}
          >
            Try again
          </button>
        ) : null}
        {problem === "elsewhere" ? (
          <Link
            href={`/j/${roomCode}`}
            className="flex h-13 items-center justify-center rounded-2xl px-6 font-semibold"
            style={{ height: 52, background: "var(--primary-fill)", color: "var(--primary-text)" }}
          >
            Join it instead
          </Link>
        ) : null}
        <Link
          href="/"
          className="flex h-13 items-center justify-center rounded-2xl border px-6 font-semibold"
          style={{ height: 52, background: "var(--surface)", borderColor: "var(--border)" }}
        >
          {problem === "ended" ? "Host a new hive" : "Back home"}
        </Link>
      </main>
    );
  }

  if (!hostKeyState) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
        <span className="font-display text-2xl font-bold">Starting the hive…</span>
      </main>
    );
  }

  return (
    <HostRoom
      key={hostKeyState}
      roomCode={roomCode}
      hostKey={hostKeyState}
      clientId={recoveryClientId ?? undefined}
      onDemoted={handleDemoted}
      onGone={handleGone}
    />
  );
}

function HostRoom({
  roomCode,
  hostKey,
  clientId,
  onDemoted,
  onGone,
}: {
  roomCode: string;
  hostKey: string;
  clientId?: string;
  onDemoted: () => void;
  onGone: () => void;
}) {
  const [speakerOn, setSpeakerOn] = useState(false);
  const speakerOnInitialised = useRef(false);
  const [tracks, setTracks] = useState<TrackLibraryEntry[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [startAnywayReady, setStartAnywayReady] = useState(false);
  const [sheetClientId, setSheetClientId] = useState<string | null>(null);
  const [showPlayers, setShowPlayers] = useState(false);
  const [showSongs, setShowSongs] = useState(false);
  const [calibrateDismissed, setCalibrateDismissed] = useState(false);
  const [screenLinkCopied, setScreenLinkCopied] = useState(false);
  const [uploadPhase, setUploadPhase] = useState<"analyzing" | "uploading" | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [tracksVersion, setTracksVersion] = useState(0);
  const [hostToast, setHostToast] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  /** The microphone refused (denied, or no input device): tuning cannot work from this phone until that changes. */
  const [micBlocked, setMicBlocked] = useState(false);
  /** This page asked for the current/last tuning moment (as opposed to finding one in the room after a reload). */
  const [tuningStartedHere, setTuningStartedHere] = useState(false);
  /**
   * Armed by "Start the hive" when an automatic tuning moment should run first: play the moment
   * that tuning lands (done, failed, or cancelled — the show starts either way). Refs, not state:
   * the transitions are observed from room snapshots and must not re-render or re-arm on their own.
   */
  const autoStartRef = useRef(false);
  const autoStartSawTuningRef = useRef(false);
  const autoStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { client, room, me, connection, audio, health, healthServerTime, protocolMismatch } = useHiveClient({
    roomCode,
    kind: "host",
    plays: speakerOn,
    hostKey,
    clientId,
    name: "Host",
    autoConnect: true,
  });

  useEffect(() => {
    return client.on("error", (code, message) => {
      if (code === "NOT_HOST") onDemoted();
      else if (code === "NO_ROOM") onGone();
      else setHostToast(hostErrorText(code, message));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  // An error is news for a few seconds, not a banner for the rest of the night: it used to stay
  // until the page was reloaded, long after whatever caused it was over.
  useEffect(() => {
    if (!hostToast) return;
    const t = setTimeout(() => setHostToast(null), HOST_TOAST_MS);
    return () => clearTimeout(t);
  }, [hostToast]);

  // A demotion remounts HostRoom under a fresh key (see HostPage); this client's socket is
  // otherwise never closed, so the old, now-demoted connection would sit in the room as a zombie
  // player forever without this.
  useEffect(() => {
    return () => client.disconnect();
  }, [client]);

  // A stale-keyed reconnect can also land as a plain player instead of an explicit NOT_HOST error
  // (a brand new room has no host yet, so nothing rejects the JOIN -- it's just accepted as kind: player).
  useEffect(() => {
    if (me && me.kind !== "host") onDemoted();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.kind]);

  // The retained record's plays survives a reload/reconnect; the toggle should reflect it, not
  // silently reset to off and desync from what the server already has.
  useEffect(() => {
    if (!speakerOnInitialised.current && me) {
      speakerOnInitialised.current = true;
      setSpeakerOn(me.plays);
    }
  }, [me]);

  // The engine re-JOINs after a dropped socket with the options it was created with (plays: false),
  // and the server takes a host's `plays` from the JOIN — so every reconnect silently switched this
  // phone's speaker off while the checkbox stayed ticked. Whenever the room and the toggle disagree
  // on an open socket, what the host last asked for (toggleSpeaker) wins.
  const wantedPlays = useRef<boolean | null>(null);
  const serverPlays = me?.plays;
  useEffect(() => {
    if (wantedPlays.current === null || serverPlays === undefined || connection !== "open") return;
    if (serverPlays !== wantedPlays.current) client.host.setPlays(wantedPlays.current);
  }, [serverPlays, connection, client]);

  // The library is what ends the "Setting up your hive…" splash (the first track is auto-picked
  // from it) and what fills the Songs drawer, so one failed request must not be the end of it:
  // retry with the socket's own backoff until an answer arrives.
  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const load = () => {
      fetch(`${apiUrl()}/tracks`)
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
        .then((d: { tracks: TrackLibraryEntry[] }) => {
          if (!cancelled) setTracks(d.tracks);
        })
        .catch(() => {
          if (!cancelled) retry = setTimeout(load, reconnectDelayMs(attempt++));
        });
    };
    load();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [tracksVersion]);

  // Auto-pick the first library track once the room exists and has none — and actually push it
  // to the server (host.setTrack), not just the local radio state: the mock scenarios always
  // pre-seed a track, but a fresh real room starts with track: null, so "Start" would otherwise
  // send TRANSPORT into a room with nothing loaded (ERROR NO_TRACK) until the user happened to
  // click a radio button that was already visually checked.
  // Sent only while the socket is open (a message sent while it is down is dropped, not queued),
  // and sent again if the room still has no track after a reconnect.
  const autoPickSentAt = useRef<number | null>(null);
  useEffect(() => {
    if (!room) return;
    if (room.track) {
      setSelectedTrackId(room.track.id);
      return;
    }
    const first = tracks[0];
    if (!first || connection !== "open") return;
    const now = performance.now();
    if (autoPickSentAt.current !== null && now - autoPickSentAt.current < 3000) return;
    autoPickSentAt.current = now;
    setSelectedTrackId(first.id);
    client.host.setTrack(first.id);
  }, [room, tracks, connection, client]);

  useEffect(() => {
    setStartAnywayReady(false);
    if (!room?.track) return;
    const t = setTimeout(() => setStartAnywayReady(true), 10_000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.track?.id]);

  function toggleSpeaker(on: boolean) {
    wantedPlays.current = on;
    setSpeakerOn(on);
    if (on) client.audio.unlock().catch(() => {});
    client.host.setPlays(on);
  }

  function selectTrack(id: string) {
    setSelectedTrackId(id);
    client.host.setTrack(id);
  }

  /**
   * Upload from a file the phone can play: decoded + downmixed to the WAV spec in the browser
   * (fileToMonoWav), analyzed and stored by POST /tracks, then the list refetches so the new track
   * appears — added to the playlist, but never auto-selected: the default track stays the default.
   */
  async function onUploadFile(file: File) {
    setUploadError(null);
    setUploadPhase("analyzing");
    try {
      const wav = await fileToMonoWav(file);
      setUploadProgress(0);
      setUploadPhase("uploading");
      await postTrack(apiUrl(), hostKey, titleFromFilename(file.name), wav, setUploadProgress);
      setTracksVersion((v) => v + 1);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "upload failed");
    } finally {
      setUploadPhase(null);
      setUploadProgress(null);
    }
  }

  // PLAY is scheduled LEAD_MS ahead and the snapshot that says "playing" can trail it by a full
  // rate-limit window, so for about half a second the stage still showed "Start the hive" — after
  // the tuning moment it flashed back as if nothing had happened, and a second tap restarted the
  // song. `starting` covers that gap: set when PLAY is sent, cleared when the transport moves (or
  // after 3 s, in case the message was lost).
  const [starting, setStarting] = useState(false);
  const sendPlay = useCallback(() => {
    setStarting(true);
    client.host.play(0);
  }, [client]);
  const transportState = room?.transport.state;
  useEffect(() => {
    if (!starting) return;
    if (transportState && transportState !== "stopped") {
      setStarting(false);
      return;
    }
    const t = setTimeout(() => setStarting(false), 3000);
    return () => clearTimeout(t);
  }, [starting, transportState]);

  const finishAutoStart = useCallback(() => {
    if (!autoStartRef.current) return;
    autoStartRef.current = false;
    autoStartSawTuningRef.current = false;
    if (autoStartTimerRef.current) {
      clearTimeout(autoStartTimerRef.current);
      autoStartTimerRef.current = null;
    }
    setCalibrateDismissed(true);
    sendPlay();
  }, [sendPlay]);

  // Watches the tuning moment that startHive armed. countdown/running means it genuinely started;
  // any exit from there (done, failed, or idle after a cancel) starts the music. `done`/`failed`
  // also count without a witnessed run, for the race where the server finishes between snapshots.
  const calibrationState = room?.calibration.state ?? "idle";
  useEffect(() => {
    if (!autoStartRef.current) return;
    if (calibrationState === "countdown" || calibrationState === "running") {
      autoStartSawTuningRef.current = true;
      return;
    }
    if (autoStartSawTuningRef.current || calibrationState === "done" || calibrationState === "failed") finishAutoStart();
  }, [calibrationState, finishAutoStart]);

  useEffect(() => {
    return () => {
      if (autoStartTimerRef.current) clearTimeout(autoStartTimerRef.current);
    };
  }, []);

  function startTuning() {
    setCalibrateDismissed(false);
    setTuningStartedHere(true);
    setMicError(null);
    setMicBlocked(false);
    // The stub engine (mock/e2e testing) has no microphone by design -- it never calls
    // runAsReference() and the mock server measures its own synthetic players on a timer
    // regardless, so the countdown/rows UI works the same either way. Only the real engine
    // needs this call at all.
    if (engineKind() === "real") {
      // Both calls must fire from this same tap: getUserMedia only grants from a user gesture, and
      // runAsReference() must have the mic open BEFORE the server's CALIBRATION_PLAN arrives (it
      // opens the mic first, then awaits the plan) -- so it's started here, not awaited, and
      // startCalibration() (which is what actually causes the server to send that plan) follows.
      client.calibration
        .runAsReference({ onProgress: (p: CalibrationProgress) => (p.phase === "failed" ? setMicError((e) => e ?? "couldn't finish") : undefined) })
        .catch((err: unknown) => {
          const name = err instanceof Error ? err.name : "";
          if (name === "CalibrationCancelledError") return; // the user pressed Cancel; not an error
          const message = err instanceof Error ? err.message : "could not start listening";
          setMicError(message);
          // No microphone (permission denied, no input device): every phone would click to a room
          // nobody is listening to until the server's failure timeout. Cancel the run — whether it
          // was Start's automatic one or a tap on "Tune the hive" — and remember, so the next Start
          // does not flash the tuning screen on every phone again just to fail the same way.
          if (/^microphone denied/.test(message)) {
            setMicBlocked(true);
            client.host.cancelCalibration();
          }
          // An automatic tuning that cannot run must not hold the music back.
          if (autoStartRef.current) finishAutoStart();
        });
    }
    client.host.startCalibration().catch(() => {});
  }

  /**
   * "Start the hive": when tuning can actually help — real engine (the stub has no mic), at least
   * one ready speaker still on table/guessed compensation, calibration idle — run the tuning moment
   * automatically and play the instant it lands. No separate tap. Everything else starts as before.
   * The decision itself is planStart (lib/hive/start-flow.ts, unit-tested).
   */
  function startHive() {
    if (!selectedTrackId) return;
    const plan = planStart({ engine: engineKind(), room, startInFlight: autoStartRef.current, micBlocked });
    if (plan.kind === "ignore") return; // a second tap while the first start's tuning is still running
    if (plan.kind === "play") {
      sendPlay();
      return;
    }
    autoStartRef.current = true;
    autoStartSawTuningRef.current = false;
    // Failsafe: a tuning that never starts or never ends (socket hiccup mid-run) must not strand
    // the party on the countdown screen; worst case the show starts on table compensation.
    autoStartTimerRef.current = setTimeout(finishAutoStart, plan.failsafeMs);
    startTuning();
  }

  const router = useRouter();
  /**
   * Back to the landing page, ending this hosting session: pause first so the phones aren't left
   * looping a host-less show (the socket itself is closed by the unmount cleanup above).
   */
  function exitHive() {
    if (room?.transport.state === "playing") client.host.pause();
    router.push("/");
  }

  async function copyJoinLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/j/${roomCode}`);
      setScreenLinkCopied(true);
      setTimeout(() => setScreenLinkCopied(false), 2000);
    } catch {
      // clipboard API can be blocked (permissions, non-HTTPS); nothing else to do from here
    }
  }

  const playerCount = room ? Object.values(room.clients).filter((c) => c.kind === "player" && c.connected).length : 0;
  const connectedPlayers = room ? Object.values(room.clients).filter((c) => c.kind === "player" && c.connected) : [];
  const allReady = !!room?.track && connectedPlayers.every((c) => c.audioReadyTrackId === room.track!.id);
  const canStart = !!room?.track && (allReady || startAnywayReady || connectedPlayers.length === 0);
  // One host screen: the stage is the whole UI (no lobby detour). Song picking/changing lives in
  // the Songs drawer, joining in the Join QR code page, and Start appears whenever the transport
  // is stopped. `room.track` is auto-picked seconds after the room exists (effect above).
  const showStage = !!room?.track;
  const showCalibrate = showTuningScreen({ calibrationState, startedHere: tuningStartedHere, dismissed: calibrateDismissed });
  const tuneNote = tuningNote({ calibrationState, micBlocked });

  if (showCalibrate && room) {
    return (
      <main className="mx-auto min-h-dvh max-w-md">
        <HostCalibrate room={room} clock={client.clock} host={client.host} onClose={() => setCalibrateDismissed(true)} micError={micError} />
      </main>
    );
  }

  if (showStage && room) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-3.5" style={{ padding: safeAreaPadding(52, 20, 24) }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={exitHive}
              aria-label="Exit the hive"
              className="flex h-11 w-11 items-center justify-center rounded-full border text-[15px] font-semibold"
              style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--muted)" }}
            >
              ←
            </button>
            <span className="font-mono rounded-full border px-3 py-1.5 text-[13px] tracking-widest" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
              {roomCode}
            </span>
          </div>
          <span className="text-[13px]" style={{ color: "var(--muted)" }}>
            {playerCount} players
          </span>
          <span className="font-mono rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-widest" style={{ background: "var(--primary-fill)", color: "var(--primary-text)" }}>
            HOST
          </span>
        </div>

        <ReconnectBanner connection={connection} />
        <ProtocolMismatchBanner show={protocolMismatch} />
        {hostToast ? (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-medium"
            style={{ background: "var(--ringer-bg)", borderColor: "var(--ringer-border)", color: "var(--ringer-fg)" }}
          >
            <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--ringer-fg)" }} />
            {hostToast}
          </div>
        ) : null}

        <div className="flex items-center justify-between rounded-2xl border px-3.5 py-3" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <Link href={`/qr/${roomCode}`} target="_blank" className="-my-3 flex h-11 items-center text-lg font-bold underline">
            Join QR code
          </Link>
          <button onClick={copyJoinLink} className="-my-3 -mr-2 h-11 px-2 text-[13px] font-semibold" style={{ color: "var(--muted)" }}>
            {screenLinkCopied ? "Copied!" : "Copy link"}
          </button>
        </div>

        {room.transport.state === "stopped" ? (
          <div className="flex flex-col gap-2.5">
            <span className="line-clamp-2 text-center text-[15px] [overflow-wrap:anywhere]" style={{ color: "var(--muted)" }}>
              Up next: <span className="font-semibold" style={{ color: "var(--text)" }}>{room.track!.title}</span>
            </span>
            <button
              onClick={startHive}
              disabled={!selectedTrackId || !canStart || starting}
              className="flex h-14 items-center justify-center rounded-2xl text-lg font-semibold disabled:opacity-60"
              style={{ background: "var(--primary-fill)", color: "var(--primary-text)" }}
            >
              {starting
                ? "Starting…"
                : !selectedTrackId
                  ? "Pick a track"
                  : allReady || connectedPlayers.length === 0
                    ? "Start the hive"
                    : startAnywayReady
                      ? "Start anyway"
                      : "Waiting for phones to load…"}
            </button>
            {audio.state === "locked" && speakerOn ? (
              <p className="text-center text-xs" style={{ color: "var(--faint)" }}>
                Tap the speaker toggle again if this phone doesn&apos;t make sound once the show starts.
              </p>
            ) : null}
          </div>
        ) : (
          <TransportBar room={room} clock={client.clock} host={client.host} />
        )}

        <ModeChips current={room.mode.kind} host={client.host} />
        {room.mode.kind === "STROBE" ? <StrobeControls room={room} host={client.host} /> : null}

        <VibeBox host={client.host} />
        <SceneStrip room={room} clock={client.clock} />

        {/* Says something only when tuning did not happen; silence means nothing is wrong. */}
        {tuneNote ? (
          <div className="rounded-2xl border p-3 text-sm" style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--muted)" }}>
            {tuneNote}
          </div>
        ) : null}

        <div className="flex justify-center">
          <HiveMap room={room} health={health} healthServerTime={healthServerTime} clock={client.clock} host={client.host} onOpenSheet={setSheetClientId} />
        </div>

        <Legend partsApply={partsApply(room)} ringHealth={Object.values(room.clients).some((c) => c.connected && c.assignment && c.assignment.role !== "unison")} />

        {/* Lives on the stage, not the lobby: a per-party choice, not a per-song one. */}
        <label className="flex cursor-pointer items-center gap-3 rounded-2xl border px-3.5 py-3" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <input
            type="checkbox"
            checked={speakerOn}
            onChange={(e) => toggleSpeaker(e.target.checked)}
            className="h-6 w-6 shrink-0"
            style={{ accentColor: "var(--primary-fill)" }}
          />
          <span className="text-[15px] font-semibold">This phone plays music too</span>
        </label>

        <div className="flex gap-2.5">
          <button
            onClick={startTuning}
            className="flex h-13 grow items-center justify-center rounded-2xl border text-[15px] font-semibold"
            style={{ height: 52, background: "var(--surface)", borderColor: "var(--border)" }}
          >
            Tune the hive
          </button>
          <button
            onClick={() => {
              setShowSongs(true);
              setTracksVersion((v) => v + 1); // songs added from another phone since this page loaded
            }}
            className="flex h-13 grow items-center justify-center rounded-2xl border text-[15px] font-semibold"
            style={{ height: 52, background: "var(--surface)", borderColor: "var(--border)" }}
          >
            Songs
          </button>
          <button
            onClick={() => setShowPlayers(true)}
            className="flex h-13 grow items-center justify-center rounded-2xl border text-[15px] font-semibold"
            style={{ height: 52, background: "var(--surface)", borderColor: "var(--border)" }}
          >
            Players
          </button>
        </div>

        {sheetClientId && room.clients[sheetClientId] ? (
          <PlayerSheet client={room.clients[sheetClientId]!} host={client.host} showParts={partsApply(room)} onClose={() => setSheetClientId(null)} />
        ) : null}
        {showPlayers ? (
          <PlayersDrawer
            room={room}
            health={health}
            healthServerTime={healthServerTime}
            onSelect={(id) => {
              setShowPlayers(false);
              setSheetClientId(id);
            }}
            onClose={() => setShowPlayers(false)}
          />
        ) : null}
        {showSongs ? (
          <SongsDrawer
            tracks={tracks}
            currentTrackId={room.track?.id ?? null}
            playing={room.transport.state !== "stopped"}
            uploadPhase={uploadPhase}
            uploadProgress={uploadProgress}
            uploadError={uploadError}
            onSelect={(id) => {
              setShowSongs(false);
              // SET_TRACK stops the transport server-side and the stage shows Start for the new song —
              // so never send it for the song that is already loaded: tapping the highlighted row
              // (to go back, or to check what is on) used to stop the music for the whole room.
              if (id !== room.track?.id) selectTrack(id);
            }}
            onUpload={(f) => void onUploadFile(f)}
            onClose={() => setShowSongs(false)}
          />
        ) : null}

        <Creators />
      </main>
    );
  }

  // The moment between the room existing and the first track being auto-picked (well under a
  // second): a splash, never a separate lobby screen.
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="font-display text-[60px] leading-none font-extrabold tracking-[0.14em]">{roomCode}</span>
      <span className="text-[15px]" style={{ color: "var(--muted)" }}>
        Setting up your hive…
      </span>
      {/* If the server cannot be reached this is where the host waits, so say so here too. */}
      <ReconnectBanner connection={connection} />
      <ProtocolMismatchBanner show={protocolMismatch} />
    </main>
  );
}
