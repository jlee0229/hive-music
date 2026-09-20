"use client";

import { useEffect, useRef, useState } from "react";
import type { RoomState } from "@hive/protocol";
import type { HiveHostControls, HiveClock } from "@hive/sync-client";
import { formatTrackTime } from "@/lib/hive/derive";

function modeLabel(kind: string): string {
  return kind.charAt(0) + kind.slice(1).toLowerCase();
}

/** Pause/play/seek. Reads the shared clock at 60 fps via requestAnimationFrame; never subscribes per frame. */
export function TransportBar({ room, clock, host }: { room: RoomState; clock: HiveClock; host: HiveHostControls }) {
  const [trackTimeSec, setTrackTimeSec] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf: number;
    const tick = () => {
      setTrackTimeSec(clock.trackTimeSec());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [clock]);

  const duration = room.track?.durationSec ?? 0;
  const pct = duration > 0 ? Math.min(1, trackTimeSec / duration) : 0;
  const playing = room.transport.state === "playing";

  function seekTo(clientX: number) {
    const el = barRef.current;
    if (!el || duration <= 0) return;
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    host.seek(frac * duration);
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-[20px] border p-3.5" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
      <div className="flex items-center gap-3">
        <button
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => (playing ? host.pause() : host.play())}
          className="flex h-13 w-13 shrink-0 items-center justify-center rounded-full"
          style={{ height: 52, width: 52, background: "var(--primary-fill)" }}
        >
          {playing ? (
            <svg width="18" height="18" viewBox="0 0 18 18" fill="var(--primary-text)" aria-hidden="true">
              <rect x="3" y="2" width="4" height="14" rx="1" />
              <rect x="11" y="2" width="4" height="14" rx="1" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 18 18" fill="var(--primary-text)" aria-hidden="true">
              <path d="M4 2l12 7-12 7z" />
            </svg>
          )}
        </button>
        <div className="flex grow flex-col gap-0.5">
          <span className="text-[16px] font-semibold">{room.track?.title ?? "No track"}</span>
          <span className="text-[13px]" style={{ color: "var(--muted)" }}>
            {modeLabel(room.mode.kind)} ·{" "}
            <span className="font-mono">
              {formatTrackTime(trackTimeSec)} / {formatTrackTime(duration)}
            </span>
          </span>
        </div>
      </div>
      <div
        ref={barRef}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={trackTimeSec}
        tabIndex={0}
        onClick={(e) => seekTo(e.clientX)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") host.seek(Math.min(duration, trackTimeSec + 5));
          if (e.key === "ArrowLeft") host.seek(Math.max(0, trackTimeSec - 5));
        }}
        className="relative flex h-5 cursor-pointer items-center"
      >
        <div className="h-1.5 w-full rounded-full" style={{ background: "var(--raised)" }} />
        <div
          className="absolute top-1.5 h-1.5 rounded-full"
          style={{ left: 0, width: `${pct * 100}%`, background: "var(--primary-fill)" }}
        />
        <span
          className="absolute h-4 w-4 rounded-full"
          style={{ left: `calc(${pct * 100}% - 8px)`, top: 2, background: "var(--primary-fill)", boxShadow: "0 0 0 4px rgba(241,245,249,0.18)" }}
        />
      </div>
    </div>
  );
}
