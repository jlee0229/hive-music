"use client";

import { useEffect, useState } from "react";
import { CALIBRATION_COUNTDOWN_MS, CALIBRATION_CLICK_INTERVAL_MS, type ClientRecord, type RoomState } from "@hive/protocol";
import type { HiveClient } from "@hive/sync-client";
import { safeAreaPadding } from "@/lib/hive/safe-area";

/**
 * "Hold still. Quiet, please.": a countdown ring, then one progress bar and "Phone N of M".
 *
 * One screen, no scrolling. Progress used to be a dot per phone in a single row, which is 18 px a
 * phone: 22 phones filled a 393 px screen and 40 gave the whole page 169 px of sideways scroll. A
 * bar is the same width at 4 phones and at 64.
 *
 * Reads only `room.calibration` (the order, and which ids have a result) and this phone's own
 * record — never another client's.
 */
export function PlayerCalibratingScreen({ client, room, me }: { client: HiveClient; room: RoomState; me: ClientRecord | null; name: string }) {
  const { order, results, state, startServerTime } = room.calibration;
  const total = order.length;
  const doneCount = order.filter((id) => results[id]).length;
  const mine = me ? !!results[me.id] : false;

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
  const countdown = state === "countdown";

  return (
    <main
      className="relative mx-auto flex h-dvh max-w-md flex-col gap-4 overflow-hidden"
      style={{ padding: safeAreaPadding(16, 20, 16), overscrollBehavior: "none", touchAction: "manipulation" }}
    >
      <div className="flex shrink-0 items-center justify-between gap-3">
        <span className="min-w-0 truncate text-base font-semibold">{me?.name ?? "You"}</span>
        <span className="eyebrow shrink-0 rounded-full border px-3 py-1.5" style={{ borderColor: "var(--ringer-border)", color: "var(--ringer-fg)" }}>
          Tuning
        </span>
      </div>

      {/* The ring is sized from the height that is left, so a sideways phone keeps all of it. */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center text-center" style={{ gap: "min(20px, 3dvh)" }}>
        <span className="font-display shrink-0 text-[2rem] leading-tight font-extrabold">
          Hold still. <br className="[@media(max-height:480px)]:hidden" />
          Quiet, please.
        </span>
        <div className="relative flex aspect-square shrink-0 items-center justify-center" style={{ height: "clamp(96px, 26dvh, 168px)" }}>
          <svg viewBox="0 0 160 160" fill="none" className="absolute inset-0 h-full w-full" aria-hidden="true">
            <circle cx="80" cy="80" r="72" stroke="var(--raised)" strokeWidth="8" />
            <circle
              cx="80"
              cy="80"
              r="72"
              stroke="var(--ringer-fg)"
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={`${countdown ? (secondsLeft / (CALIBRATION_COUNTDOWN_MS / 1000)) * 452 : 452} 452`}
              transform="rotate(-90 80 80)"
            />
          </svg>
          <div className="flex flex-col items-center">
            <span className="font-display leading-none font-extrabold" style={{ fontSize: "clamp(28px, 8dvh, 48px)" }}>
              {countdown ? secondsLeft : mine ? "✓" : "…"}
            </span>
            <span className="eyebrow [@media(max-height:480px)]:hidden" style={{ color: "var(--muted)" }}>
              {countdown ? "Get ready" : "Your click"}
            </span>
          </div>
        </div>
        <p className="shrink-0 text-sm [@media(max-height:480px)]:hidden" style={{ color: "var(--muted)" }}>
          Your screen flashes white for a moment. That&apos;s your click.
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-center gap-2">
        <div
          role="progressbar"
          aria-label="Phones tuned"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={doneCount}
          className="h-2 w-full overflow-hidden rounded-full"
          style={{ background: "var(--border)" }}
        >
          <div className="h-2 rounded-full" style={{ width: `${total > 0 ? (doneCount / total) * 100 : 0}%`, background: "var(--ringer-fg)" }} />
        </div>
        <span className="text-sm" style={{ color: "var(--faint)" }}>
          {total > 0 ? `Phone ${Math.min(doneCount + 1, total)} of ${total}` : "Waiting for the hive"}
          {state === "running" && total > 0 ? ` · about ${secondsRemainingEstimate}s left` : ""}
        </span>
      </div>
    </main>
  );
}
