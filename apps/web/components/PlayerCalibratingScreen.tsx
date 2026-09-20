"use client";

import { useEffect, useState } from "react";
import { CALIBRATION_COUNTDOWN_MS, CALIBRATION_CLICK_INTERVAL_MS, type ClientRecord, type RoomState } from "@hive/protocol";
import type { HiveClient } from "@hive/sync-client";
import { safeAreaPadding } from "@/lib/hive/safe-area";

/** "Hold still, quiet please": countdown ring, N-of-M progress dots, a white flash on calibrationClick. */
export function PlayerCalibratingScreen({ client, room, me }: { client: HiveClient; room: RoomState; me: ClientRecord | null; name: string }) {
  const { order, results, state, startServerTime } = room.calibration;
  const total = order.length;
  const doneCount = order.filter((id) => results[id]).length;
  const myIndex = me ? order.indexOf(me.id) : -1;

  const [secondsLeft, setSecondsLeft] = useState(Math.ceil(CALIBRATION_COUNTDOWN_MS / 1000));

  useEffect(() => {
    const t = setInterval(() => {
      if (state === "countdown" && startServerTime != null) {
        const remaining = Math.max(0, Math.ceil((startServerTime - client.clock.serverNow()) / 1000));
        setSecondsLeft(remaining);
      }
    }, 200);
    return () => clearInterval(t);
  }, [client, state, startServerTime]);

  const secondsRemainingEstimate = Math.max(0, Math.round(((total - doneCount) * CALIBRATION_CLICK_INTERVAL_MS) / 1000));

  return (
    <main
      className="relative mx-auto flex min-h-dvh max-w-md flex-col justify-between p-6"
      style={{ padding: safeAreaPadding(56, 24, 32), overscrollBehavior: "none", touchAction: "manipulation" }}
    >
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[15px] font-semibold">{me?.name ?? "You"}</span>
        <span
          className="font-mono rounded-full border px-3 py-1.5 text-[13px] tracking-widest"
          style={{ borderColor: "var(--ringer-border)", color: "var(--ringer-fg)" }}
        >
          TUNING
        </span>
      </div>

      <div className="flex flex-col items-center gap-4.5 text-center">
        <span className="font-display text-4xl leading-tight font-extrabold">
          Hold still.
          <br />
          Quiet, please.
        </span>
        <p style={{ color: "var(--muted)" }}>
          The host&apos;s phone is listening. Each phone plays one short click so the hive can line everyone up.
        </p>
        <div className="relative flex h-40 w-40 items-center justify-center">
          <svg width="160" height="160" viewBox="0 0 160 160" fill="none" className="absolute left-0 top-0" aria-hidden="true">
            <circle cx="80" cy="80" r="72" stroke="var(--raised)" strokeWidth="8" />
            <circle
              cx="80"
              cy="80"
              r="72"
              stroke="var(--ringer-fg)"
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={`${state === "countdown" ? (secondsLeft / (CALIBRATION_COUNTDOWN_MS / 1000)) * 452 : 452} 452`}
              transform="rotate(-90 80 80)"
            />
          </svg>
          <div className="flex flex-col items-center gap-0.5">
            <span className="font-display text-5xl font-extrabold">{state === "countdown" ? secondsLeft : myIndex >= 0 && results[order[myIndex]!] ? "✓" : "…"}</span>
            <span className="text-xs tracking-widest" style={{ color: "var(--muted)" }}>
              {state === "countdown" ? "GET READY" : "YOUR CLICK"}
            </span>
          </div>
        </div>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Your screen flashes white for a moment. That&apos;s your click.
        </p>
      </div>

      <div className="flex flex-col items-center gap-2.5">
        <div className="flex gap-2">
          {order.map((id, i) => (
            <span
              key={id}
              className="h-2.5 w-2.5 rounded-full"
              style={{ background: results[id] ? "var(--health-good)" : i === doneCount ? "var(--ringer-fg)" : "var(--border)" }}
            />
          ))}
        </div>
        <span className="text-[13px]" style={{ color: "var(--faint)" }}>
          {total > 0 ? `Phone ${Math.min(doneCount + 1, total)} of ${total}` : "Waiting for the hive"}
          {state === "running" && total > 0 ? ` · about ${secondsRemainingEstimate}s left` : ""}
        </span>
      </div>
    </main>
  );
}
