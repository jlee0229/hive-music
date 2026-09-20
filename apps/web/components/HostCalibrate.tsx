"use client";

import { useEffect, useState } from "react";
import { CALIBRATION_COUNTDOWN_MS, type RoomState } from "@hive/protocol";
import type { HiveClock } from "@hive/sync-client";
import { formatMs } from "@/lib/hive/derive";
import { safeAreaPadding } from "@/lib/hive/safe-area";

type RowStatus = "waiting" | "listening" | "clear";

/** "Tuning moment": countdown, per-player rows (waiting / listening / clear), Apply/Cancel. */
export function HostCalibrate({ room, clock, onClose }: { room: RoomState; clock: HiveClock; onClose: () => void }) {
  const { state, order, results, startServerTime } = room.calibration;
  const [secondsLeft, setSecondsLeft] = useState(Math.ceil(CALIBRATION_COUNTDOWN_MS / 1000));

  useEffect(() => {
    const t = setInterval(() => {
      if (state === "countdown" && startServerTime != null) {
        setSecondsLeft(Math.max(0, Math.ceil((startServerTime - clock.serverNow()) / 1000)));
      }
    }, 200);
    return () => clearInterval(t);
  }, [clock, state, startServerTime]);

  const doneCount = order.filter((id) => results[id]).length;
  const rows: Array<{ id: string; name: string; status: RowStatus }> = order.map((id, i) => {
    const client = room.clients[id];
    const status: RowStatus = results[id] ? "clear" : state === "running" && i === doneCount ? "listening" : "waiting";
    return { id, name: client?.name ?? id, status };
  });

  return (
    <div className="fixed inset-0 z-40 mx-auto flex max-w-md flex-col gap-4.5" style={{ background: "var(--stage)", padding: safeAreaPadding(52, 24, 28) }}>
      <div className="flex items-center justify-between">
        <span className="font-display text-xl font-bold">Tuning moment</span>
        <span
          className="font-mono rounded-full border px-3 py-1.5 text-xs tracking-widest"
          style={{ borderColor: "var(--ringer-border)", color: "var(--ringer-fg)" }}
        >
          {state === "countdown" ? "STARTING" : state === "running" ? "LISTENING" : state === "failed" ? "FAILED" : "DONE"}
        </span>
      </div>

      <div className="flex items-center gap-4 rounded-[20px] border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
        <div className="relative flex h-[84px] w-[84px] shrink-0 items-center justify-center">
          <svg width="84" height="84" viewBox="0 0 84 84" fill="none" className="absolute left-0 top-0" aria-hidden="true">
            <circle cx="42" cy="42" r="37" stroke="var(--raised)" strokeWidth="6" />
            <circle
              cx="42"
              cy="42"
              r="37"
              stroke="var(--ringer-fg)"
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`${state === "countdown" ? (secondsLeft / (CALIBRATION_COUNTDOWN_MS / 1000)) * 232 : 232} 232`}
              transform="rotate(-90 42 42)"
            />
          </svg>
          <span className="font-display text-3xl font-extrabold">{state === "countdown" ? secondsLeft : doneCount}</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="font-display text-[22px] font-bold leading-tight">
            {state === "failed" ? "Couldn't finish." : "Quiet, please."}
          </span>
          <span className="text-[13px] leading-snug" style={{ color: "var(--muted)" }}>
            {state === "failed"
              ? "Try again in a quieter moment, or closer to the group."
              : "Each phone plays one click. This phone listens and measures how late each one is."}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {rows.map((row) => (
          <div
            key={row.id}
            className="flex items-center gap-3 rounded-[14px] border px-3.5 py-3"
            style={{
              background: "var(--surface)",
              borderColor: row.status === "listening" ? "var(--ringer-fg)" : "var(--border)",
              color: row.status === "waiting" ? "var(--faint)" : "var(--text)",
            }}
          >
            <span className="h-3 w-3 rounded-full" style={{ background: "var(--muted)", opacity: row.status === "waiting" ? 0.5 : 1 }} />
            <span className="grow text-[15px] font-medium">{row.name}</span>
            {row.status === "clear" ? (
              <>
                <span className="font-mono text-[13px]" style={{ color: "var(--muted)" }}>
                  {formatMs(results[row.id]!.residualMs)}
                </span>
                <span className="text-xs" style={{ color: "var(--health-good)" }}>
                  clear ✓
                </span>
              </>
            ) : row.status === "listening" ? (
              <span className="text-xs" style={{ color: "var(--ringer-fg)" }}>
                listening…
              </span>
            ) : (
              <span className="text-xs">waiting</span>
            )}
          </div>
        ))}
      </div>

      <span className="text-xs leading-snug" style={{ color: "var(--faint)" }}>
        Faint clicks are fine. A noisy room or a phone far from this one lowers confidence; you can re-run tuning any time.
      </span>

      <div className="grow" />

      <div className="flex flex-col gap-2.5">
        {state === "done" || state === "failed" ? (
          <button
            onClick={onClose}
            className="flex h-14 items-center justify-center rounded-2xl text-lg font-semibold"
            style={{ background: "var(--primary-fill)", color: "var(--primary-text)" }}
          >
            {state === "failed" ? "Back to the stage" : "Apply offsets"}
          </button>
        ) : null}
        <button
          onClick={onClose}
          className="flex h-12 items-center justify-center rounded-2xl text-[15px] font-semibold"
          style={{ color: "var(--muted)" }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
