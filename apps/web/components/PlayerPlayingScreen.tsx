"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AudioState, ClientRecord, Pattern, Role, RoomState } from "@hive/protocol";
import { ROLE_COLORS } from "@hive/protocol";
import type { ConnectionState, HiveClient, SyncStatus } from "@hive/sync-client";
import { beatPhase, formatTrackTime, inkForRole, patternGain } from "@/lib/hive/derive";
import { ReconnectBanner } from "@/components/ReconnectBanner";
import { AdSlot } from "@/components/AdSlot";
import { Creators } from "@/components/Creators";

const DARK = "#0B0F14";
const LIGHT_INK = "#F8FAFC";
/**
 * Bass is the one role dark enough to need light ink, and on its map colour (#8B5CF6) that ink is
 * only 4.05:1 — under AA for the code, the song line and "YOU ARE". A whole screen of bass is
 * filled with a deeper violet instead (5.45:1). The map dot keeps the lighter one, which reads
 * better on a dark surface. Mirrors --role-bass-screen in globals.css.
 */
const SCREEN_FILL: Partial<Record<Role, string>> = { bass: "#7C3AED" };
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
  const roleColor = assignment ? (SCREEN_FILL[assignment.role] ?? ROLE_COLORS[assignment.role]) : ROLE_COLORS.unison;
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
  useLayoutEffect(() => {
    let raf = 0;
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
    // Before the first paint, not a frame after it: this loop owns the ink colour, and when the
    // part changes React repaints the fill at once but leaves whatever ink the old part's loop wrote
    // last — a frame of the previous part's ink on the new colour.
    tick();
    return () => cancelAnimationFrame(raf);
  }, [client, room.track?.bpm, pattern, depth, roleColor, ink, reducedMotion]);

  const label = assignment?.label ?? "Unison";
  // Light ink on the one dark fill (bass) is only ~4:1, so its small print is not faded further.
  const soft = ink === DARK ? 0.8 : 1;
  const duration = room.track?.durationSec;
  const shownSec = duration ? Math.min(trackSec, Math.floor(duration)) : trackSec;

  let statusLine: React.ReactNode;
  if (audioState !== "ready") {
    // Joined mid-song, or the playlist moved on: the room is playing and this phone is still
    // fetching the song. Without this line it sat on a full-colour "playing" screen in silence.
    statusLine = <span>Loading the song…{audioState === "loading" && loadProgress > 0 ? ` ${Math.round(loadProgress * 100)}%` : ""}</span>;
  } else if (muted) {
    statusLine = <span>Muted</span>;
  } else {
    statusLine = (
      <>
        <span className="min-w-0 truncate">{room.track?.title ?? "—"}</span>
        <span className="shrink-0">&nbsp;· {formatTrackTime(shownSec)}</span>
      </>
    );
  }

  return (
    <main
      ref={mainRef}
      className="relative flex h-dvh flex-col gap-2 overflow-hidden"
      style={{
        background: roleColor,
        color: ink,
        // The page shell every guest screen uses (16 / 20 / 16); the safe-area insets are always
        // added on top.
        padding: [
          "calc(16px + env(safe-area-inset-top, 0px))",
          "calc(20px + env(safe-area-inset-right, 0px))",
          "calc(16px + env(safe-area-inset-bottom, 0px))",
          "calc(20px + env(safe-area-inset-left, 0px))",
        ].join(" "),
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

      <div className="relative flex shrink-0 items-center justify-between">
        <span className="font-mono text-sm tracking-widest" style={{ opacity: soft }}>
          HIVE · {roomCode}
        </span>
      </div>

      {/* The middle takes whatever height is left. The rings are centred on it — that is, on the
          role — by layout: they used to sit at the centre of the *screen*, which is 70 px below
          the word on a tall phone because the panel underneath takes the bottom third. They are
          not clipped here (they run on under the panel and off the edges; <main> clips them). */}
      <div className="relative min-h-0 flex-1">
        <svg
          ref={ringsRef}
          className="pointer-events-none absolute"
          style={{ left: "calc(50% - 300px)", top: "calc(50% - 300px)", transformOrigin: "center", transition: "transform 60ms linear" }}
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
        {/* The text clips inside this box, so the controls below are never pushed off a no-scroll
            screen. Lines of equal height above and below the role keep the role itself on the centre. */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 overflow-hidden text-center">
          <span className="eyebrow flex h-6 shrink-0 items-center" style={{ opacity: soft }}>
            YOU ARE
          </span>
          <span
            className="font-display shrink-0 leading-none font-extrabold tracking-tight whitespace-nowrap uppercase"
            // One line, sized to the label: this face runs ~0.63em per capital on average and
            // ~0.72em for a word of wide ones ("DRUMS"), so 0.76em a character always fits and
            // "SOPRANO" / "STROBE 3" are no longer cropped on a 320 px phone. A 76 px word needs no
            // help from the OS text-size setting, which would only push it back off the screen.
            style={{
              fontSize: `min(76px, 20dvh, calc((100vw - 40px) / ${(Math.max(label.length, 4) * 0.76).toFixed(2)}))`,
              WebkitTextSizeAdjust: "100%",
              textSizeAdjust: "100%",
            }}
          >
            {label}
          </span>
          <span className="flex h-6 max-w-full shrink-0 items-center justify-center text-base" style={{ opacity: soft }}>
            {statusLine}
          </span>
        </div>
      </div>

      {/* No nudge slider here anymore: timing is automatic (live latency + the tuning moment), and
          a visible correction control read as "this app needs fixing". The host still has a
          per-player nudge in the player sheet for emergencies.
          One panel, three things in order of use: the control, the sponsor, the byline. 24 px
          corners with 12 px of padding, so the 12 px corners inside it are concentric. */}
      <div className="relative flex shrink-0 flex-col gap-3 rounded-3xl p-3" style={{ background: "var(--scrim)", color: "var(--text)" }}>
        <ReconnectBanner connection={connection} />
        <button
          onClick={() => client.audio.setMuted(!muted)}
          aria-pressed={muted}
          className="flex h-14 shrink-0 items-center justify-center gap-2 rounded-xl border text-base font-semibold [@media(max-height:480px)]:h-11"
          // A filled, outlined, full-width button with a speaker on it. It was a bare outline at
          // 1.1–2.4:1 against the panel, which read as a caption rather than a control.
          style={{
            borderColor: muted ? "#F1F5F9" : "rgba(241,245,249,0.5)",
            background: muted ? "#F1F5F9" : "rgba(241,245,249,0.1)",
            color: muted ? "#0B0F14" : "#F1F5F9",
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M11 5 6 9H3v6h3l5 4z" />
            {muted ? <path d="m16 9 5 6m0-6-5 6" /> : <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />}
          </svg>
          {muted ? "Unmute my phone" : "Mute my phone"}
        </button>
        {/* Landscape phones have no room for the footer; drop it whole rather than crop it. */}
        <div className="flex flex-col gap-2 [@media(max-height:480px)]:hidden">
          <AdSlot dark />
          <Creators dark />
        </div>
      </div>
    </main>
  );
}
