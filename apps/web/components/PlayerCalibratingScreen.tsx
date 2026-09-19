"use client";

import type { ClientRecord, RoomState } from "@hive/protocol";

/** "Hold still, quiet please" plus per-phone progress dots. Built out in gate F7. */
export function PlayerCalibratingScreen({ room, me, name }: { room: RoomState; me: ClientRecord | null; name: string }) {
  const total = room.calibration.order.length;
  const done = Object.keys(room.calibration.results).length;
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <span
        className="font-mono rounded-full border px-3 py-1.5 text-[13px] tracking-widest"
        style={{ borderColor: "var(--ringer-border)", color: "var(--ringer-fg)" }}
      >
        TUNING
      </span>
      <h1 className="font-display text-4xl leading-tight font-extrabold">
        Hold still.
        <br />
        Quiet, please.
      </h1>
      <p style={{ color: "var(--muted)" }}>
        The host&apos;s phone is listening, {name || "you"}. Each phone plays one short click.
      </p>
      <p className="text-sm" style={{ color: "var(--faint)" }}>
        {done} / {total || "?"} phones measured · {me ? "your click is scheduled" : ""}
      </p>
    </main>
  );
}
