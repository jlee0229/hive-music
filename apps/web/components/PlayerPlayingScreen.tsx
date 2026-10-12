"use client";

import { useEffect, useRef, useState } from "react";
import type { AudioState, ClientRecord, Pattern, RoomState } from "@hive/protocol";
import { ROLE_COLORS } from "@hive/protocol";
import type { ConnectionState, HiveClient, SyncStatus } from "@hive/sync-client";
import { beatPhase, formatTrackTime, inkForRole, patternGain } from "@/lib/hive/derive";
import { safeAreaPadding } from "@/lib/hive/safe-area";
import { ReconnectBanner } from "@/components/ReconnectBanner";
import { AdSlot } from "@/components/AdSlot";
import { Creators } from "@/components/Creators";

const DARK = "#0B0F14";
const LIGHT_INK = "#F8FAFC";
/** How far a STROBE/WAVE "off" phase dims the role colour (opacity of the dark overlay). */
const FULL_DIM_DEPTH = 0.85;
/**
 * WCAG 2.3.1 (three flashes or below threshold): content must not flash more than three times in
 * any one second unless the flash is below the general flash threshold — a swing of less than 10 %
 * of full relative luminance. This screen is the whole phone, held at arm's length, and STROBE at
 * sixteenth notes blinks it 4–7 times a second per phone; so above three flashes a second the
 * blink is capped to a swing that is under the threshold (a shimmer rather than a strobe).
 */
const MAX_FLASHES_PER_SEC = 3;
const SAFE_LUMINANCE_SWING = 0.09;

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG relative luminance of `fill` under a `DARK` overlay of the given opacity (sRGB compositing). */
export function dimmedLuminance(fill: string, overlayOpacity: number): number {
  const f = rgb(fill);
  const d = rgb(DARK);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const ch = (i: number) => lin(f[i]! * (1 - overlayOpacity) + d[i]! * overlayOpacity);
  return 0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2);
}

/** Full flashes (lit → dim → lit) per second this pattern puts on one phone's screen. */
export function flashesPerSecond(pattern: Pattern | null | undefined): number {
  return pattern ? 1000 / pattern.periodMs : 0;
}

/**
 * Overlay opacity at the darkest point of the pattern: the full dim when it is slow enough to be
 * safe, the deepest dim that stays under the flash threshold when it is not, and none at all when
 * the guest asked their phone for reduced motion.
 */
export function dimDepth(pattern: Pattern | null | undefined, fill: string, reducedMotion: boolean): number {
  if (!pattern || reducedMotion) return 0;
  if (flashesPerSecond(pattern) <= MAX_FLASHES_PER_SEC) return FULL_DIM_DEPTH;
  const lit = dimmedLuminance(fill, 0);
  let lo = 0;
  let hi = FULL_DIM_DEPTH;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (lit - dimmedLuminance(fill, mid) < SAFE_LUMINANCE_SWING) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Below this background luminance light ink has the better contrast ratio; above it, dark ink. */
const LIGHT_INK_BELOW = 0.18;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return reduced;
}

/** Full-screen role color, beat pulse (bpm + evaluatePattern), mute. */
export function PlayerPlayingScreen({
  client,
  room,
  me,
  connection,
  muted,
  roomCode,
  audioState = "ready",
  loadProgress = 1,
}: {
  client: HiveClient;
  room: RoomState;
  me: ClientRecord | null;
  /** Still accepted so callers don't churn, but the ms readout is gone: simplified player screen. */
  status?: SyncStatus;
  connection: ConnectionState;
  muted: boolean;
  roomCode: string;
  name: string;
  /** The engine's audio state; anything but "ready" means this phone is not making sound yet. */
  audioState?: AudioState;
  loadProgress?: number;
}) {
  const assignment = me?.assignment ?? null;
  const roleColor = assignment ? ROLE_COLORS[assignment.role] : ROLE_COLORS.unison;
  const ink = assignment ? inkForRole(assignment.role) : DARK;
  const pattern = assignment?.pattern ?? null;
  const reducedMotion = usePrefersReducedMotion();
  const depth = dimDepth(pattern, roleColor, reducedMotion);

  const [trackSec, setTrackSec] = useState(0);
  const mainRef = useRef<HTMLElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const ringsRef = useRef<SVGSVGElement>(null);

  // The beat pulse and the dim run at display rate, so they are written straight to the DOM: a
  // setState here re-rendered the whole screen 60 times a second on a phone that also has to keep
  // an audio thread fed. React state only carries the clock, which changes once a second.
  useEffect(() => {
    let raf: number;
    let lastSec = -1;
    const bpm = room.track?.bpm;
    const tick = () => {
      const t = client.clock.trackTimeSec();
      const gain = patternGain(pattern, t);
      const dim = (1 - gain) * depth;
      if (overlayRef.current) overlayRef.current.style.opacity = String(dim);
      // Dark ink on a dimmed role colour is ~1.3:1 — the label vanished for the whole "off" phase.
      if (mainRef.current) mainRef.current.style.color = dim > 0 && dimmedLuminance(roleColor, dim) < LIGHT_INK_BELOW ? LIGHT_INK : ink;
      if (ringsRef.current) {
        // a short decaying pulse right on the downbeat, scaled by the pattern's current gain
        const pulse = reducedMotion ? 0 : Math.max(0, 1 - beatPhase(t, bpm) * 3) * gain;
        ringsRef.current.style.transform = `scale(${1 + pulse * 0.06})`;
      }
      const sec = Math.floor(t);
      if (sec !== lastSec) {
        lastSec = sec;
        setTrackSec(sec);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [client, room.track?.bpm, pattern, depth, roleColor, ink, reducedMotion]);

  const label = assignment?.label ?? "Unison";
  // Light ink on the one dark fill (bass) is only ~4:1, so its small print is not faded further.
  const soft = ink === DARK ? 0.8 : 1;

  let statusLine: React.ReactNode;
  if (audioState !== "ready") {
    // Joined mid-song, or the playlist moved on: the room is playing and this phone is still
    // fetching the song. Without this line it sat on a full-colour "playing" screen in silence.
    statusLine = <span>Loading the song…{audioState === "loading" && loadProgress > 0 ? ` ${Math.round(loadProgress * 100)}%` : ""}</span>;
  } else if (muted) {
    statusLine = <span>Muted</span>;
  } else {
    statusLine = (
      <span>
        {room.track?.title ?? "—"} · {formatTrackTime(trackSec)}
      </span>
    );
  }

  return (
    <main
      ref={mainRef}
      className="relative flex h-dvh flex-col justify-between overflow-hidden"
      style={{
        background: roleColor,
        color: ink,
        padding: safeAreaPadding(52, 24, 28),
        overscrollBehavior: "none",
        touchAction: "manipulation",
      }}
    >
      {pattern ? (
        <div
          ref={overlayRef}
          data-testid="pattern-dim"
          data-depth={depth.toFixed(3)}
          className="pointer-events-none absolute inset-0"
          aria-hidden="true"
          style={{ background: DARK, opacity: 0 }}
        />
      ) : null}
      <svg
        ref={ringsRef}
        className="pointer-events-none absolute"
        style={{ left: -105, top: 122, transformOrigin: "center", transition: "transform 60ms linear" }}
        width="600"
        height="600"
        viewBox="0 0 600 600"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="300" cy="300" r="120" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2" />
        <circle cx="300" cy="300" r="200" stroke="currentColor" strokeOpacity="0.14" strokeWidth="2" />
        <circle cx="300" cy="300" r="280" stroke="currentColor" strokeOpacity="0.07" strokeWidth="2" />
      </svg>

      <div className="relative flex items-center justify-between">
        <span className="font-mono text-[13px] tracking-widest" style={{ opacity: soft }}>
          HIVE · {roomCode}
        </span>
      </div>

      <div className="relative flex flex-col items-center gap-2.5">
        <span className="text-[13px] tracking-[0.22em]" style={{ opacity: soft }}>
          YOU ARE
        </span>
        <span className="font-display text-[76px] leading-none font-extrabold tracking-tight uppercase">{label}</span>
        <span className="text-[15px]" style={{ opacity: soft }}>
          {statusLine}
        </span>
      </div>

      {/* No nudge slider here anymore: timing is automatic (live latency + the tuning moment), and
          a visible correction control read as "this app needs fixing". The host still has a
          per-player nudge in the player sheet for emergencies. */}
      <div className="relative flex flex-col gap-3 rounded-[20px] p-4" style={{ background: "rgba(11,15,20,0.6)", color: "#F1F5F9" }}>
        <ReconnectBanner connection={connection} />
        <button
          onClick={() => client.audio.setMuted(!muted)}
          aria-pressed={muted}
          className="flex h-12 items-center justify-center rounded-xl border font-semibold"
          style={{ borderColor: "var(--border)", background: muted ? "#F1F5F9" : "transparent", color: muted ? "#0B0F14" : "#F1F5F9" }}
        >
          {muted ? "Unmute my phone" : "Mute my phone"}
        </button>
        <AdSlot dark />
        <Creators dark />
      </div>
    </main>
  );
}
