"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { reconnectDelayMs, type CalibrationProgress } from "@hive/sync-client";
import { useHiveClient } from "@/lib/hive/useHiveClient";
import { apiUrl, engineKind } from "@/lib/hive/client";
import { fileToMonoWav, postTrack, titleFromFilename } from "@/lib/hive/upload-track";
import { clearHostKey, getHostKey, getLibraryKey, setHostKey } from "@/lib/hive/storage";
import { fetchLibrary, removeErrorText, removeTrack, type LibraryTrack } from "@/lib/hive/library";
import { classifyHostClaim } from "@/lib/hive/host-claim";
import { planStart, showTuningScreen, tuningCancelLabel, tuningNote } from "@/lib/hive/start-flow";
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
 * Decides whether this browser is the host of `code`, then mounts HostRoom.
 *
 * The host key is the only thing that makes a browser the host (server audit SG-01/SG-02): it is
 * handed out once, by "Host a hive", and after that the server only ever echoes it to a caller who
 * already presents it. So:
 *  - a key is stored: mount and let the socket JOIN with it. No request first — the JOIN itself
 *    re-creates a room that was lost to a server restart, under the same code and key.
 *  - no key is stored: `POST /rooms {code}` is only a question. 403 = a live hive that this browser
 *    does not host; 400 = no such hive. (A 2xx carrying a key only happens in fixed-code demo mode.)
 *  - the server says "not host" to a page that holds a key (NOT_HOST on a command): ask once more
 *    with `{code, hostKey}`. 2xx = the key is good, re-join under a fresh client id; anything else
 *    is one of the screens above. The key is never thrown away to "re-claim" one: that request is
 *    exactly what the server now refuses.
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
  /** True while a demoted page is asking the server about its key; HostRoom is unmounted meanwhile. */
  const [checking, setChecking] = useState(false);
  const [recoveryClientId, setRecoveryClientId] = useState<string | null>(null);
  const recoveryAttemptedRef = useRef(false);

  /** POST /rooms {code, hostKey?} and what the answer means (lib/hive/host-claim.ts). */
  const askServer = useCallback(
    async (hostKey: string | null) => {
      let status: number | null = null;
      let body: unknown = null;
      try {
        const res = await fetch(`${apiUrl()}/rooms`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(hostKey ? { code: roomCode, hostKey } : { code: roomCode }),
        });
        status = res.status;
        body = await res.json().catch(() => null);
      } catch {
        /* network error: status stays null */
      }
      return classifyHostClaim(status, body);
    },
    [roomCode],
  );

  // No key stored: ask whether this hive can be hosted from here at all.
  useEffect(() => {
    if (!storageRead || hostKeyState || problem) return;
    let cancelled = false;
    void askServer(null).then((claim) => {
      if (cancelled) return;
      if (claim.kind === "ok") {
        setHostKey(claim.code, claim.hostKey);
        setHostKeyState(claim.hostKey);
      } else {
        setProblem(claim.kind);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [storageRead, hostKeyState, problem, askServer]);

  // A command was answered NOT_HOST although this page holds a key. Ask the server about that key —
  // keeping it — and re-join under a fresh client id if it is good. Once per page load: a second
  // refusal right after a confirmed key means asking again is not the fix.
  const handleDemoted = useCallback(() => {
    const key = getHostKey(roomCode);
    if (recoveryAttemptedRef.current || !key) {
      setProblem("elsewhere");
      return;
    }
    recoveryAttemptedRef.current = true;
    setChecking(true);
    void askServer(key).then((claim) => {
      if (claim.kind === "ok") {
        // A fresh client id: whatever the room holds under the old one is not a host seat.
        setRecoveryClientId(crypto.randomUUID());
        setHostKeyState(claim.hostKey);
      } else {
        setProblem(claim.kind);
      }
      setChecking(false);
    });
  }, [roomCode, askServer]);

  // The room's list of hosts does not include this page: its key is not this room's key (someone
  // else's hive under the same code, or a key from an earlier life of it).
  const handleNotHost = useCallback(() => setProblem("elsewhere"), []);

  // The server answered NO_ROOM to a JOIN that carried the key: the hive is gone and the key could
  // not bring it back (it is older than the server will honour, or from before a secret change).
  const handleGone = useCallback(() => {
    clearHostKey(roomCode);
    setProblem("ended");
  }, [roomCode]);

  if (problem) {
    const primary = "flex h-14 items-center justify-center rounded-2xl px-8 text-base font-semibold";
    const primaryStyle = { background: "var(--primary-fill)", color: "var(--primary-text)" };
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-5 text-center">
        <h1 className="font-display text-[2rem] leading-tight font-bold">
          {problem === "ended" ? "This hive has ended" : problem === "elsewhere" ? "This hive is hosted on another device" : "Can’t reach the hive"}
        </h1>
        {problem === "unreachable" ? (
          <button onClick={() => setProblem(null)} className={primary} style={primaryStyle}>
            Try again
          </button>
        ) : null}
        {problem === "elsewhere" ? (
          <Link href={`/j/${roomCode}`} className={primary} style={primaryStyle}>
            Join as a guest
          </Link>
        ) : null}
        <Link
          href="/"
          className="flex h-14 items-center justify-center rounded-2xl border px-8 text-base font-semibold"
          style={{ background: "var(--surface)", borderColor: "var(--border-strong)" }}
        >
          {problem === "unreachable" ? "Back home" : "Start a new hive"}
        </Link>
      </main>
    );
  }

  if (!hostKeyState || checking) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-5 text-center">
        <span className="font-display text-xl font-bold">Starting the hive…</span>
      </main>
    );
  }

  return (
    <HostRoom
      // Remounted — a genuinely fresh HiveClient — when the key or the client id changes.
      key={`${hostKeyState}:${recoveryClientId ?? ""}`}
      roomCode={roomCode}
      hostKey={hostKeyState}
      clientId={recoveryClientId ?? undefined}
      onDemoted={handleDemoted}
      onNotHost={handleNotHost}
      onGone={handleGone}
    />
  );
}

function HostRoom({
  roomCode,
  hostKey,
  clientId,
  onDemoted,
  onNotHost,
  onGone,
}: {
  roomCode: string;
  hostKey: string;
  clientId?: string;
  /** A host command was refused (ERROR NOT_HOST). */
  onDemoted: () => void;
  /** The room says this client is not one of its hosts. */
  onNotHost: () => void;
  /** The room does not exist (ERROR NO_ROOM). */
  onGone: () => void;
}) {
  const [speakerOn, setSpeakerOn] = useState(false);
  const speakerOnInitialised = useRef(false);
  const [tracks, setTracks] = useState<LibraryTrack[]>([]);
  // This browser's library key: whose uploads are whose. Read once per mount, client-side only
  // (HostRoom never renders on the server), and handed to the engine for the host's JOIN.
  const [libraryKey] = useState(() => getLibraryKey());
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
  /** The same fact as autoStartRef, as state: only for what the tuning screen's button says. */
  const [autoStarting, setAutoStarting] = useState(false);
  const autoStartSawTuningRef = useRef(false);
  const autoStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { client, room, me, connection, audio, health, healthServerTime, protocolMismatch, isHost } = useHiveClient({
    roomCode,
    kind: "host",
    plays: speakerOn,
    hostKey,
    clientId,
    libraryKey,
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

  // The drawers and the phone sheet are made of controls too. When the socket drops they fold
  // away, so the host is looking at the banner and the greyed stage rather than tapping a list that
  // cannot answer.
  useEffect(() => {
    if (connection !== "reconnecting" && connection !== "closed") return;
    setShowSongs(false);
    setShowPlayers(false);
    setSheetClientId(null);
  }, [connection]);

  // A demotion remounts HostRoom under a fresh key (see HostPage); this client's socket is
  // otherwise never closed, so the old, now-demoted connection would sit in the room as a zombie
  // player forever without this.
  useEffect(() => {
    return () => client.disconnect();
  }, [client]);

  // "Am I the host?" is the server's answer, never this record's `kind`: a JOIN whose key is not
  // the room's is admitted as a plain guest (a speaker!), and a keyless JOIN under a host's client
  // id is a read-only observer whose `me` — and whose id in `hostClientIds` — is the real host's.
  // WELCOME.isHost is the one fact that tells those apart, so it wins whenever the engine has it;
  // the room's host list is only the fallback before the first WELCOME is known. The moment the
  // answer is "no", say so and leave — HostPage unmounts this component, which closes the socket
  // (below), so the tab does not linger as a phantom speaker.
  const amHost = isHost ?? (room ? room.hostClientIds.includes(client.clientId) : null);
  useEffect(() => {
    if (amHost === false && connection === "open") onNotHost();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amHost, connection]);

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
      // As this hive's host (the key travels as a Bearer header): the shared songs plus this
      // browser's own uploads, the latter marked `mine`.
      fetchLibrary(apiUrl(), hostKey)
        .then((list) => {
          if (!cancelled) setTracks(list);
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
  }, [tracksVersion, hostKey]);

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

  /** Remove one of this browser's own uploads (the drawer has already asked "Remove?"). */
  async function removeSong(id: string) {
    setUploadError(null);
    const result = await removeTrack(apiUrl(), hostKey, id);
    setUploadError(removeErrorText(result));
    setTracksVersion((v) => v + 1); // whatever happened, show the list as the server has it now
  }

  const finishAutoStart = useCallback(() => {
    if (!autoStartRef.current) return;
    autoStartRef.current = false;
    setAutoStarting(false);
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
    setAutoStarting(true);
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

  // A drawer or a phone's sheet covers the stage, and the stage behind it must not move: the lists
  // scroll inside themselves (overscroll-contain), and while one is open the page does not scroll.
  const overlayOpen = showSongs || showPlayers || sheetClientId !== null;
  useEffect(() => {
    if (!overlayOpen) return;
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = before;
    };
  }, [overlayOpen]);

  const playerCount = room ? Object.values(room.clients).filter((c) => c.kind === "player" && c.connected).length : 0;
  const connectedPlayers = room ? Object.values(room.clients).filter((c) => c.kind === "player" && c.connected) : [];
  const allReady = !!room?.track && connectedPlayers.every((c) => c.audioReadyTrackId === room.track!.id);
  const canStart = !!room?.track && (allReady || startAnywayReady || connectedPlayers.length === 0);
  // One host screen: the stage is the whole UI (no lobby detour). Song picking/changing lives in
  // the Songs drawer, joining in the Join QR code page, and Start appears whenever the transport
  // is stopped. `room.track` is auto-picked seconds after the room exists (effect above).
  const showStage = !!room?.track;
  // Not connected right now (a drop the engine is retrying, or a socket closed for good).
  const offline = connection !== "open";
  const showCalibrate = showTuningScreen({ calibrationState, startedHere: tuningStartedHere, dismissed: calibrateDismissed });
  const tuneNote = tuningNote({ calibrationState, micBlocked });

  if (showCalibrate && room) {
    return (
      <main className="mx-auto min-h-dvh max-w-md">
        <HostCalibrate
          room={room}
          clock={client.clock}
          host={client.host}
          onClose={() => setCalibrateDismissed(true)}
          micError={micError}
          cancelLabel={tuningCancelLabel({ autoStart: autoStarting })}
        />
      </main>
    );
  }

  if (showStage && room) {
    const action = "flex h-14 min-w-0 grow items-center justify-center rounded-2xl border px-2 text-sm font-semibold min-[360px]:text-base";
    const actionStyle = { background: "var(--surface)", borderColor: "var(--border-strong)" };
    return (
      // One page shell (16 / 20 / 16), one order: what a host reaches for — the QR link, play /
      // pause, the mode, the song — is the first screen of a 320x568 phone; the map and the
      // once-a-party toggle follow. Songs / Players / Tune used to be the last row of a page 1.3
      // to 2.2 screens tall.
      <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-3" style={{ padding: safeAreaPadding(16, 20, 16) }}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              onClick={exitHive}
              aria-label="Exit the hive"
              className="flex h-11 w-11 items-center justify-center rounded-full border text-base font-semibold"
              style={{ background: "var(--surface)", borderColor: "var(--border-strong)", color: "var(--muted)" }}
            >
              ←
            </button>
            <span className="font-mono rounded-full border px-3 py-1.5 text-sm tracking-widest" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
              {roomCode}
            </span>
          </div>
          <span className="text-sm" style={{ color: "var(--muted)" }}>
            {playerCount} players
          </span>
          <span className="font-mono rounded-full px-2.5 py-1 text-xs font-semibold tracking-widest" style={{ background: "var(--primary-fill)", color: "var(--primary-text)" }}>
            HOST
          </span>
        </div>

        <ReconnectBanner connection={connection} />
        <ProtocolMismatchBanner show={protocolMismatch} />
        {hostToast ? (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-semibold"
            style={{ background: "var(--ringer-bg)", borderColor: "var(--ringer-border)", color: "var(--ringer-fg)" }}
          >
            <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--ringer-fg)" }} />
            {hostToast}
          </div>
        ) : null}

        <div className="flex h-14 shrink-0 items-center justify-between rounded-2xl border px-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <Link href={`/qr/${roomCode}`} target="_blank" className="flex h-11 items-center text-xl font-semibold underline underline-offset-4">
            Join QR code
          </Link>
          <button onClick={copyJoinLink} className="-mr-2 h-11 px-2 text-sm font-semibold" style={{ color: "var(--muted)" }}>
            {screenLinkCopied ? "Copied!" : "Copy link"}
          </button>
        </div>

        {/* Everything below sends a command over the socket, and a command sent while the socket is
            down is dropped, not queued — a tap during a Wi-Fi blip used to do nothing, silently. So
            while it is down the controls are visibly off (the banner above says why); nothing stale
            is replayed when it comes back. */}
        <fieldset
          disabled={offline}
          data-testid="host-controls"
          className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0"
          style={offline ? { opacity: 0.45, pointerEvents: "none" } : undefined}
        >
        {room.transport.state === "stopped" ? (
          <div className="flex flex-col gap-2">
            <span className="line-clamp-2 text-center text-base [overflow-wrap:anywhere]" style={{ color: "var(--muted)" }}>
              Up next: <span className="font-semibold" style={{ color: "var(--text)" }}>{room.track!.title}</span>
            </span>
            <button
              onClick={startHive}
              disabled={!selectedTrackId || !canStart || starting}
              className="flex h-14 items-center justify-center rounded-2xl text-xl font-semibold disabled:opacity-60"
              style={{ background: "var(--primary-fill)", color: "var(--primary-text)" }}
            >
              {starting
                ? "Starting…"
                : !selectedTrackId
                  ? "Pick a song"
                  : allReady || connectedPlayers.length === 0
                    ? "Start the hive"
                    : startAnywayReady
                      ? "Start anyway"
                      : "Waiting for phones to load…"}
            </button>
            {audio.state === "locked" && speakerOn ? (
              <p className="text-center text-xs" style={{ color: "var(--faint)" }}>
                No sound from this phone after you start? Switch “This phone plays music too” off and on.
              </p>
            ) : null}
          </div>
        ) : (
          <TransportBar room={room} clock={client.clock} host={client.host} />
        )}

        <ModeChips current={room.mode.kind} host={client.host} />
        {room.mode.kind === "STROBE" ? <StrobeControls room={room} host={client.host} /> : null}

        <div className="flex gap-2">
          <button
            onClick={() => {
              setShowSongs(true);
              setTracksVersion((v) => v + 1); // songs added from another phone since this page loaded
            }}
            className={action}
            style={actionStyle}
          >
            Songs
          </button>
          <button onClick={() => setShowPlayers(true)} className={action} style={actionStyle}>
            Players
          </button>
          <button onClick={startTuning} className={action} style={actionStyle}>
            Tune the hive
          </button>
        </div>

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

        <Legend mode={room.mode.kind} />

        {/* Lives on the stage, not the lobby: a per-party choice, not a per-song one. */}
        <label className="flex h-14 cursor-pointer items-center gap-3 rounded-2xl border px-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <input
            type="checkbox"
            checked={speakerOn}
            onChange={(e) => toggleSpeaker(e.target.checked)}
            className="h-6 w-6 shrink-0"
            style={{ accentColor: "var(--primary-fill)" }}
          />
          <span className="text-base font-semibold">This phone plays music too</span>
        </label>
        </fieldset>

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
            onRemove={(id) => void removeSong(id)}
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
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-5 text-center">
      <span className="font-display leading-none font-extrabold tracking-[0.14em]" style={{ fontSize: "clamp(2.5rem, 15vw, 3.75rem)" }}>
        {roomCode}
      </span>
      <span className="text-base" style={{ color: "var(--muted)" }}>
        Setting up your hive…
      </span>
      {/* If the server cannot be reached this is where the host waits, so say so here too. */}
      <ReconnectBanner connection={connection} />
      <ProtocolMismatchBanner show={protocolMismatch} />
    </main>
  );
}
