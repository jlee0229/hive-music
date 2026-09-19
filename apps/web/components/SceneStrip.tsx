"use client";

import { useEffect, useState } from "react";
import { activeSceneIndex, type RoomState } from "@hive/protocol";
import type { HiveClock } from "@hive/sync-client";
import { formatTrackTime } from "@/lib/hive/derive";

function modeLabel(kind: string): string {
  return kind.charAt(0) + kind.slice(1).toLowerCase();
}

/** Widths proportional to scene durations; activeSceneIndex(room.scenePlan, trackTimeSec) highlights the current one. */
export function SceneStrip({ room, clock }: { room: RoomState; clock: HiveClock }) {
  const [trackTimeSec, setTrackTimeSec] = useState(0);

  useEffect(() => {
    let raf: number;
    const tick = () => {
      setTrackTimeSec(clock.trackTimeSec());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [clock]);

  const plan = room.scenePlan;
  if (!plan) return null;

  const duration = room.track?.durationSec ?? plan.scenes[plan.scenes.length - 1]!.atTrackSec + 10;
  const activeIndex = activeSceneIndex(plan, trackTimeSec);

  return (
    <div className="flex gap-1" data-testid="scene-strip">
      {plan.scenes.map((scene, i) => {
        const end = i + 1 < plan.scenes.length ? plan.scenes[i + 1]!.atTrackSec : duration;
        const width = Math.max(0, end - scene.atTrackSec);
        const active = i === activeIndex;
        return (
          <div
            key={i}
            data-active={active ? "true" : "false"}
            className="flex h-10 flex-col justify-center rounded-[10px] px-2.5"
            style={{
              flexGrow: width || 1,
              flexBasis: 0,
              background: "var(--raised)",
              border: active ? "1px solid var(--primary-fill)" : "1px solid transparent",
              color: "var(--muted)",
            }}
          >
            <span className="text-xs font-semibold" style={{ color: "var(--text)" }}>
              {scene.note}
            </span>
            <span className="text-[11px]">
              {modeLabel(scene.mode).toLowerCase()} · {formatTrackTime(scene.atTrackSec)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
