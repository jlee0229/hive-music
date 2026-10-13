"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ROLE_COLORS, HEALTH_COLORS } from "@hive/protocol";
import { detectDevice } from "@hive/sync-client";
import { useHiveClient } from "@/lib/hive/useHiveClient";
import { apiUrl } from "@/lib/hive/client";
import { safeAreaPadding } from "@/lib/hive/safe-area";
import { getHostKey, getPlayerName, setPlayerName } from "@/lib/hive/storage";
import { selfHealthLevel, stems as stemsOf } from "@/lib/hive/derive";
import { RingerBanner } from "@/components/RingerBanner";
import { ReconnectBanner } from "@/components/ReconnectBanner";
import { ProtocolMismatchBanner } from "@/components/ProtocolMismatchBanner";
import { PlayerPlayingScreen } from "@/components/PlayerPlayingScreen";
import { PlayerCalibratingScreen } from "@/components/PlayerCalibratingScreen";
import { AdSlot } from "@/components/AdSlot";
import { Creators } from "@/components/Creators";

type View = "join" | "resume" | "ready" | "playing" | "calibrating" | "removed";

/** How long a tap waits for audio.unlock() before carrying on without it. */
const UNLOCK_GRACE_MS = 3000;

/** Resolves when `p` settles either way, or after `ms` — whichever is first. Never rejects. */
function settledWithin(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    p.then(done, done);
  });
}

/**
 * The path segment as a room code: URL-decoded, upper-cased, with everything a code cannot contain
 * removed — so a pasted "bz q7" or "BZ-Q7" still lands in the right hive.
 */
function normalizeCode(raw: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* a stray % in the URL: use it as it came */
  }
  return decoded.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** The server's JOIN schema (3–8 characters); anything else can never be a hive. */
const isPossibleCode = (code: string) => code.length >= 3 && code.length <= 8;

const hiveNotFound = (code: string) => ({
  heading: "Hive not found",
  detail: code ? `No hive is running at code ${code}. Check the code with the host.` : "This link has no hive code in it. Ask the host for the code.",
});

/**
 * The engine keeps one client id per room per browser (hive:clientId:<code>), and the host page
 * uses it too. So the join link opened in the *host's* browser — to see what guests see, or to add
 * that device as a speaker — JOINed as the host's own record: the host was renamed to the guest
 * name, lost its HEALTH feed to this tab, and was marked disconnected when the tab closed. A
 * browser that holds this room's host key therefore joins under a second, separately kept id.
 * Everyone else gets undefined, i.e. the engine's ordinary id.
 */
function guestIdInHostBrowser(roomCode: string): string | undefined {
  if (!getHostKey(roomCode)) return undefined;
  const key = `hive:guestId:${roomCode}`;
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(key, id);
    return id;
  } catch {
    return undefined;
  }
}

/** The protocol's limit on a name, in UTF-16 units (ClientMessageSchema JOIN.name). */
const NAME_MAX = 32;

/**
 * Cuts a name to the limit on a whole character. A plain slice(0, 32) can land in the middle of
 * an emoji and leave half of one — a lone surrogate that every other phone then renders as "�".
 */
function clampName(value: string): string {
  let out = "";
  for (const ch of value) {
    if (out.length + ch.length > NAME_MAX) break;
    out += ch;
  }
  return out;
}

/** How often, and for how long, a "not found" screen looks again in case the hive has just been started. */
const RECHECK_MS = 4000;
const RECHECK_LIMIT = 30;

export default function PlayerPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const roomCode = normalizeCode(code);
  const possibleCode = isPossibleCode(roomCode);

  const [name, setName] = useState(() => getPlayerName());
  const [joinRequested, setJoinRequested] = useState(false);
  const [joining, setJoining] = useState(false);
  // A code of the wrong shape is refused by the server's schema, not answered with NO_ROOM — the
  // join then hung on "Syncing…" for good. Say so up front instead.
  const [removed, setRemoved] = useState<{ heading: string; detail: string } | null>(() => (possibleCode ? null : hiveNotFound(roomCode)));
  // Asked before the tap: a guest with a wrong code or an old QR used to type a name and tap
  // "join" before learning there was nothing to join. null = not known (yet, or the lookup failed).
  const [exists, setExists] = useState<boolean | null>(null);
  const [resuming, setResuming] = useState(false);
  // Has this page ever seen a connected host? A room is only "waiting for the host to come back"
  // if there was one to begin with.
  const [hostSeen, setHostSeen] = useState(false);
  const device = detectDevice();
  const [guestId] = useState(() => guestIdInHostBrowser(roomCode));

  const { client, room, me, connection, status, audio, connect, protocolMismatch } = useHiveClient({
    roomCode,
    kind: "player",
    plays: true,
    clientId: guestId,
    // Trimmed, and nothing at all if that leaves nothing: a name of spaces was sent as-is and
    // showed up on the host's map as a blank label; undefined lets the server say "Phone 7".
    name: name.trim() || undefined,
  });

  useEffect(() => {
    // Either way this phone is out of the room, and the screen says so — so the sound has to stop
    // too. The engine keeps playing whatever it had scheduled (nothing tells it the room is gone),
    // which left a kicked phone blasting the song under a "Removed" screen with no mute button.
    // disconnect() closes the AudioContext and the socket, and ends the reconnect loop.
    const leave = (heading: string, detail: string) => {
      setRemoved({ heading, detail });
      client.disconnect();
    };
    return client.on("error", (code) => {
      if (code === "KICKED") leave("Removed from hive", "The host removed this phone.");
      if (code === "NO_ROOM") {
        const gone = hiveNotFound(roomCode);
        leave(gone.heading, gone.detail);
      }
      // The server refused the JOIN itself (before any room state): nothing will ever arrive.
      if (code === "BAD_MESSAGE" && !client.room) leave("Couldn't join", "Something went wrong joining this hive. Go back and try again.");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => {
    if (!possibleCode || joinRequested) return;
    let cancelled = false;
    let checks = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = async () => {
      let found: boolean | null = null;
      try {
        const res = await fetch(`${apiUrl()}/rooms/${roomCode}`);
        found = res.ok ? true : res.status === 404 ? false : null;
      } catch {
        found = null; // offline or the server is down: the join itself will say so
      }
      if (cancelled) return;
      setExists(found);
      // Not there *yet* is possible (the host is a moment behind the guest), so keep looking for a
      // while; the screen returns to the join form by itself when the hive appears.
      if (found === false && ++checks < RECHECK_LIMIT) timer = setTimeout(check, RECHECK_MS);
    };
    void check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [roomCode, possibleCode, joinRequested]);

  // Set synchronously (before any await) so a tap on the button and the bubbled tap on the
  // full-screen container behind it — the "unlock target is the whole screen" requirement —
  // never both run handleJoin for the same gesture.
  const startedRef = useRef(false);

  async function handleJoin() {
    if (startedRef.current) return;
    startedRef.current = true;
    setJoining(true);
    setPlayerName(name.trim());
    setJoinRequested(true);
    // unlock() has to *start* inside this tap, but it must not gate the connection: when
    // AudioContext.resume() never settles (WebKit with an interrupted audio session) or rejects,
    // awaiting it meant connect() was never reached — the phone sat on a dead screen and the host
    // never saw it. Give it a moment, then join regardless; a phone whose sound is still locked
    // lands on "Tap to resume", where a fresh tap retries the unlock.
    await settledWithin(client.audio.unlock(), UNLOCK_GRACE_MS);
    try {
      await connect();
    } catch {
      // ERROR events / the reconnect banner surface anything that goes wrong.
      startedRef.current = false; // let a retry tap work
    } finally {
      setJoining(false);
    }
  }

  // iOS suspends/interrupts the AudioContext on a lock screen, an incoming call, or Siri --
  // audio.state goes back to "locked" mid-session. Resuming needs only unlock() (it re-resumes the
  // existing context and re-requests the wake lock); calling connect() again would open a second
  // socket for the same client on top of the one that never actually dropped.
  const resumingRef = useRef(false);
  async function handleResume() {
    if (resumingRef.current) return;
    resumingRef.current = true;
    setResuming(true);
    // Bounded for the same reason as the join: a resume() that never settles would otherwise
    // leave "Resuming…" up forever with every later tap ignored. Timing out hands the guest the
    // tap target back, and each tap is a new gesture for the platform to honour.
    await settledWithin(client.audio.unlock(), UNLOCK_GRACE_MS);
    resumingRef.current = false;
    setResuming(false);
  }

  const [flash, setFlash] = useState(false);
  useEffect(() => {
    // Registered here (not inside the Calibrating screen) so a click that arrives before the
    // coalesced ROOM_STATE switches us into "calibrating" still flashes.
    //
    // The event fires on SCHEDULED_ACTION receipt, which lands ~3s + k*400ms before the click
    // actually plays -- flashing immediately would show it far too early. Time it to the click
    // itself via the shared clock instead.
    let showTimer: ReturnType<typeof setTimeout> | null = null;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const off = client.on("calibrationClick", (clickAtServerTime) => {
      if (showTimer) clearTimeout(showTimer);
      if (hideTimer) clearTimeout(hideTimer);
      const delayMs = Math.max(0, clickAtServerTime - client.clock.serverNow());
      showTimer = setTimeout(() => {
        setFlash(true);
        hideTimer = setTimeout(() => setFlash(false), 300);
      }, delayMs);
    });
    return () => {
      off();
      if (showTimer) clearTimeout(showTimer);
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, [client]);

  // Not reactive on its own, but this component re-renders on every clock probe (1 Hz) and room
  // snapshot, which is as fast as a guest needs the prompt. null with the stub engine.
  const ctxState = client.audio.ctxState;
  const contextStalled = ctxState === "suspended" || ctxState === "interrupted";

  const gone = removed ?? (exists === false && !joinRequested ? hiveNotFound(roomCode) : null);

  // The host's phone locking, their tab closing or their battery dying all look the same from
  // here: no connected host. The wait line used to keep saying "waiting for the host to start"
  // (or "Paused") for as long as the guest cared to look at it.
  const hostHere = !!room && room.hostClientIds.some((id) => room.clients[id]?.connected);
  useEffect(() => {
    if (hostHere) setHostSeen(true);
  }, [hostHere]);
  const hostAway = hostSeen && !hostHere;
  const waitLine = hostAway ? "Waiting for the host to come back" : room?.transport.state === "paused" ? "Paused — waiting for the host" : "Waiting for the host to start";

  let view: View = "join";
  if (gone) view = "removed";
  // audio.state is still "locked" between the join tap and the moment unlock() resolves; that is
  // the join in progress ("Joining…"), not an interruption — showing "Tap to resume" there flashed
  // the interruption screen at every guest on every join.
  //
  // The context's own state is consulted as well as the engine's: while stems download the engine
  // reports "loading" even if the context never started, which would park a phone on the playing
  // screen in silence with no prompt.
  else if (joinRequested && (audio.state === "locked" || contextStalled)) view = joining ? "join" : "resume";
  else if (joinRequested) {
    if (room?.calibration.state === "countdown" || room?.calibration.state === "running") view = "calibrating";
    else if (room?.transport.state === "playing") view = "playing";
    else view = "ready";
  }

  const flashOverlay = flash ? (
    <div data-testid="calibration-flash" className="pointer-events-none fixed inset-0 z-50" style={{ background: "#FFFFFF" }} aria-hidden="true" />
  ) : null;

  let body: React.ReactNode;
  if (view === "removed") {
    body = (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-5 text-center">
        <div role="alert" className="flex flex-col items-center gap-4">
          <h1 className="font-display text-[2rem] leading-tight font-bold">{gone!.heading}</h1>
          <p style={{ color: "var(--muted)" }}>{gone!.detail}</p>
        </div>
        <Link href="/" className="mt-4 flex h-14 items-center justify-center rounded-2xl px-8 text-base font-semibold" style={{ background: "var(--primary-fill)", color: "var(--primary-text)" }}>
          Back home
        </Link>
      </main>
    );
  }

  if (view === "resume") {
    body = (
      <main
        className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-5 text-center"
        style={{ overscrollBehavior: "none", touchAction: "manipulation" }}
        onClick={handleResume}
      >
        {/* The whole screen is the tap target, but a keyboard or a screen reader needs a control
            to land on; the tap bubbles to <main>, and handleResume ignores the second call. */}
        <div role="alert" className="flex flex-col items-center gap-4">
          <h1 className="font-display text-[2rem] leading-tight font-bold">
            {/* 56 px tall: the words alone were a 36 px target for the one thing this screen is for. */}
            <button onClick={handleResume} className="min-h-14 px-4">
              {resuming ? "Resuming…" : "Tap to resume"}
            </button>
          </h1>
          <p style={{ color: "var(--muted)" }}>A call or the lock screen paused the sound.</p>
        </div>
      </main>
    );
  }

  if (view === "playing") {
    body = (
      <PlayerPlayingScreen
        client={client}
        room={room!}
        me={me}
        status={status}
        connection={connection}
        muted={audio.muted}
        audioState={audio.state}
        loadProgress={audio.loadProgress}
        roomCode={roomCode}
        name={name}
      />
    );
  }

  if (view === "calibrating") {
    body = <PlayerCalibratingScreen client={client} room={room!} me={me} name={name} />;
  }

  if (view === "ready") {
    const trackStems = stemsOf(room);
    const partsDone = Math.round(audio.loadProgress * trackStems.length);
    const level = selfHealthLevel(status, audio.state, client.clock.serverNow());
    const ringColor = HEALTH_COLORS[level];
    const roleColor = me?.assignment ? ROLE_COLORS[me.assignment.role] : "#94A3B8";
    // Bass as text on a dark card: the swatch colour is 4.1:1 there, the lighter violet 6.4:1.
    const roleText = me?.assignment?.role === "bass" ? "var(--role-bass-text)" : roleColor;

    body = (
      // h-dvh + overflow-hidden silently clips anything that doesn't fit. So: the footer (what the
      // guest is waiting for, the sponsor slot, the creators line) is pinned and never shrinks,
      // the top takes what is left and clips inside itself, and on short screens the optional
      // pieces drop out whole (the helper line, the ring) or sit side by side (the two cards).
      <main
        className="mx-auto flex h-dvh max-w-md flex-col overflow-hidden"
        style={{
          gap: "min(12px, 1.6dvh)",
          padding: [
            "calc(16px + env(safe-area-inset-top, 0px))",
            "calc(20px + env(safe-area-inset-right, 0px))",
            "calc(16px + env(safe-area-inset-bottom, 0px))",
            "calc(20px + env(safe-area-inset-left, 0px))",
          ].join(" "),
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden" style={{ gap: "min(12px, 1.6dvh)" }}>
          <div className="flex shrink-0 items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2 text-base font-semibold">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: roleColor }} />
              <span className="truncate">{name.trim() || "You"}</span>
            </span>
            <span className="font-mono shrink-0 rounded-full border px-3 py-1.5 text-sm tracking-widest" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
              {roomCode}
            </span>
          </div>

          <ReconnectBanner connection={connection} />
          <ProtocolMismatchBanner show={protocolMismatch} />

          <div className="flex shrink-0 flex-col items-center gap-2 pt-1 [@media(max-height:480px)]:pt-0">
            <svg
              className="[@media(max-height:480px)]:hidden"
              style={{ width: "clamp(56px, 12dvh, 96px)", height: "clamp(56px, 12dvh, 96px)" }}
              viewBox="0 0 120 120"
              fill="none"
              aria-hidden="true"
            >
              <circle cx="60" cy="60" r="54" stroke="var(--raised)" strokeWidth="6" />
              <circle
                cx="60"
                cy="60"
                r="54"
                stroke={ringColor}
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray="339 339"
                transform="rotate(-90 60 60)"
              />
              {level === "good" || level === "warn" ? (
                <path d="M40 62l13 13 27-30" stroke={ringColor} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
              ) : null}
            </svg>
            <span className="font-display text-[2rem] leading-tight font-bold tracking-tight">{status.syncErrMs == null ? "Syncing…" : "Synced"}</span>
          </div>

          <div className="flex shrink-0 flex-col [@media(max-height:480px)]:flex-row" style={{ gap: "min(12px, 1.6dvh)" }}>
            {/* Nothing to download until the host has picked a song. */}
            {trackStems.length ? (
              <div className="flex min-w-0 flex-1 flex-col justify-center gap-2 rounded-2xl border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
                <div className="flex flex-wrap justify-between gap-x-2 text-sm">
                  {/* The same words as the playing screen's "Loading the song…"; and once it is loaded, say so. */}
                  <span className="font-semibold">{audio.loadProgress >= 1 ? "Song ready" : "Loading the song"}</span>
                  <span className="font-mono shrink-0" style={{ color: "var(--muted)" }}>
                    {Math.min(partsDone, trackStems.length)} / {trackStems.length} parts
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full" style={{ background: "var(--raised)" }}>
                  <div className="h-2 rounded-full" style={{ width: `${Math.round(audio.loadProgress * 100)}%`, background: "var(--primary-fill)" }} />
                </div>
              </div>
            ) : null}

            {me?.assignment ? (
              <div className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
                <span className="h-11 w-11 shrink-0 rounded-xl" style={{ background: roleColor }} />
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="eyebrow" style={{ color: "var(--muted)" }}>
                    YOU&apos;LL PLAY
                  </span>
                  <span className="font-display text-xl font-bold" style={{ color: roleText }}>
                    {me.assignment.label}
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-center gap-2">
          <span className="flex items-center gap-2 text-base" style={{ color: "var(--muted)" }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--muted)" }} />
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--faint)" }} />
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--border)" }} />
            {waitLine}
          </span>
          <span className="text-center text-sm" style={{ color: "var(--faint)" }}>
            Keep your screen on. Don&apos;t lock your phone.
          </span>
        </div>

        <div className="shrink-0">
          <AdSlot />
        </div>
        <div className="shrink-0">
          <Creators />
        </div>
      </main>
    );
  }

  if (view === "join") {
    body = (
      // One screen, no scrolling, on every phone: the code, a name box, and the button. The
      // three-step explainer and the line under the button used to stand between a guest and
      // "Tap to join" — on a 320x568 iPhone the button was 150 px below the fold.
      <main className="mx-auto flex h-dvh max-w-md flex-col gap-4" style={{ padding: safeAreaPadding(16, 20, 16) }} onClick={handleJoin}>
        <div className="flex shrink-0 items-center justify-between gap-3">
          <span className="font-display text-xl font-bold">Joining a hive</span>
          <span className="font-mono shrink-0 rounded-full border px-3 py-1.5 text-sm tracking-widest" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
            {roomCode}
          </span>
        </div>

        <ProtocolMismatchBanner show={protocolMismatch} />

        <input
          value={name}
          onChange={(e) => {
            const v = clampName(e.target.value);
            setName(v);
            setPlayerName(v);
          }}
          // The whole screen joins on a tap; the name box is the one place a tap means "type here".
          onClick={(e) => e.stopPropagation()}
          // The keyboard's own "go" key joins: nobody should have to dismiss the keyboard to find
          // the button underneath it.
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.currentTarget.blur();
              void handleJoin();
            }
          }}
          aria-label="Your name"
          placeholder="Your name"
          autoComplete="nickname"
          autoCapitalize="words"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          className="h-14 w-full shrink-0 rounded-2xl border px-4 text-xl outline-none focus-visible:border-[color:var(--text)]"
          style={{ background: "var(--surface)", borderColor: "var(--border-strong)", color: "var(--text)" }}
        />

        {device.browserFamily === "ios-safari" ? <RingerBanner /> : null}

        <div className="min-h-0 grow" />

        <button
          onClick={handleJoin}
          disabled={joining}
          className="flex h-16 shrink-0 items-center justify-center rounded-2xl text-xl font-semibold disabled:opacity-60"
          style={{ background: "var(--primary-fill)", color: "var(--primary-text)" }}
        >
          {joining ? "Joining…" : "Tap to join"}
        </button>
      </main>
    );
  }

  // One polite live region for the whole page, kept mounted across screens so that each change of
  // state is spoken: without it a screen-reader user hears nothing between tapping "join" and the
  // music starting, and nothing at all when the host pauses or removes them.
  //
  // The wording deliberately differs from what is printed on each screen, so the hidden copy never
  // doubles a visible string. The two screens that interrupt (resume, removed) are role="alert"
  // themselves and need nothing here.
  let announcement = "";
  if (view === "calibrating") announcement = "Tuning. Stay still and quiet for a moment.";
  else if (view === "playing") {
    const part = me?.assignment?.label ?? "unison";
    if (audio.state !== "ready") announcement = "The music is playing. This phone is still getting the song.";
    else if (audio.muted) announcement = "This phone is muted.";
    else announcement = `Now playing. Your part is ${part}.`;
  } else if (view === "ready") {
    if (hostAway) announcement = "The host has gone for now.";
    else announcement = room?.transport.state === "paused" ? "The host paused the music." : "You're in. The host hasn't started the music yet.";
  }

  return (
    <>
      {body}
      {flashOverlay}
      <p className="sr-only" role="status" aria-live="polite" data-testid="announcer">
        {announcement}
      </p>
    </>
  );
}
