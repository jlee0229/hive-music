"use client";

import { useEffect, useState } from "react";
import { CALIBRATION_COUNTDOWN_MS, type RoomState } from "@hive/protocol";
import type { HiveClock, HiveHostControls } from "@hive/sync-client";
import { safeAreaPadding } from "@/lib/hive/safe-area";

type RowStatus = "waiting" | "listening" | "clear";

/** "Tuning moment": countdown, per-player rows (waiting / listening / clear), Apply/Cancel. */
export function HostCalibrate({
  room,
  clock,
  host,
  onClose,
  micError,
  cancelLabel = "Cancel",
}: {
  room: RoomState;
  clock: HiveClock;
  host: HiveHostControls;
  onClose: () => void;
  /** Set when runAsReference() rejected (mic denied, etc.) -- the server-side run still runs its course and reports "failed". */
  micError?: string | null;
  /** What the bottom button says. During Start's automatic tuning it starts the music untuned, so the page passes "Skip tuning". */
  cancelLabel?: string;
}) {
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

  function handleCancel() {
    if (state === "countdown" || state === "running") host.cancelCalibration();
    onClose();
  }

  const doneCount = order.filter((id) => results[id]).length;
  const rows: Array<{ id: string; name: string; status: RowStatus }> = order.map((id, i) => {
    const client = room.clients[id];
    const status: RowStatus = results[id] ? "clear" : state === "running" && i === doneCount ? "listening" : "waiting";
    return { id, name: client?.name ?? id, status };
  });

  return (
    <div className="fixed inset-0 z-40 mx-auto flex max-w-md flex-col gap-4" style={{ background: "var(--stage)", padding: safeAreaPadding(16, 20, 16) }}>
      <div className="flex items-center justify-between">
        <span className="font-display text-xl font-bold">Tuning moment</span>
        <span className="eyebrow rounded-full border px-3 py-1.5" style={{ borderColor: "var(--ringer-border)", color: "var(--ringer-fg)" }}>
          {state === "countdown" ? "Starting" : state === "running" ? "Listening" : state === "failed" ? "Failed" : "Done"}
        </span>
      </div>

      {micError ? (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-semibold"
          style={{ background: "var(--ringer-bg)", borderColor: "var(--ringer-border)", color: "var(--ringer-fg)" }}
        >
          <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--ringer-fg)" }} />
          Microphone: {micError}
        </div>
      ) : null}

      <div className="flex shrink-0 items-center gap-4 rounded-2xl border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
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
          <span className="font-display text-[2rem] leading-none font-extrabold">{state === "countdown" ? secondsLeft : doneCount}</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="font-display text-xl font-bold leading-tight">
            {state === "failed" ? "Couldn't finish." : "Quiet, please."}
          </span>
          <span className="text-sm leading-snug" style={{ color: "var(--muted)" }}>
            {state === "failed" ? "Try again in a quieter moment, or closer to the group." : "Each phone plays one click. This phone listens."}
          </span>
        </div>
      </div>

      {/* The one part of this screen that grows with the party: it scrolls, so the buttons below
          stay on screen (at 30 phones they used to be pushed far below a screen that cannot scroll). */}
      <div className="flex min-h-0 shrink flex-col gap-2 overflow-y-auto overscroll-contain">
        {rows.map((row) => (
          <div
            key={row.id}
            className="flex min-h-11 shrink-0 items-center gap-3 rounded-xl border px-4 py-2"
            style={{
              background: "var(--surface)",
              borderColor: row.status === "listening" ? "var(--ringer-fg)" : "var(--border)",
              color: row.status === "waiting" ? "var(--faint)" : "var(--text)",
            }}
          >
            <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: "var(--muted)", opacity: row.status === "waiting" ? 0.5 : 1 }} />
            <span className="min-w-0 grow truncate text-base font-semibold">{row.name}</span>
            {row.status === "clear" ? (
              // "clear" is the news. How many milliseconds late the phone was is the engine's business.
              <span className="text-xs" style={{ color: "var(--health-good)" }}>
                clear ✓
              </span>
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

      <div className="grow" />

      <div className="flex shrink-0 flex-col gap-2">
        {state === "done" || state === "failed" ? (
          <button
            onClick={onClose}
            className="flex h-14 items-center justify-center rounded-2xl text-xl font-semibold"
            style={{ background: "var(--primary-fill)", color: "var(--primary-text)" }}
          >
            {state === "failed" ? "Back to the stage" : "Done"}
          </button>
        ) : null}
        <button
          onClick={handleCancel}
          className="flex h-14 items-center justify-center rounded-2xl text-base font-semibold"
          style={{ color: "var(--muted)" }}
        >
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
