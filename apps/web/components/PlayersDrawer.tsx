"use client";

import { HEALTH_COLORS, ROLE_COLORS, healthLevel, type HealthSnapshot, type RoomState } from "@hive/protocol";
import { deviceLabel, formatMs, sortedByHealth } from "@/lib/hive/derive";
import { safeAreaPadding } from "@/lib/hive/safe-area";

export function PlayersDrawer({
  room,
  health,
  healthServerTime,
  onSelect,
  onClose,
}: {
  room: RoomState;
  health: Record<string, HealthSnapshot>;
  healthServerTime: number | null;
  onSelect: (clientId: string) => void;
  onClose: () => void;
}) {
  const players = sortedByHealth(room, health, healthServerTime ?? 0).filter((c) => c.kind === "player");
  // The headline is the phones that are here, the same number the stage shows. A phone that has
  // dropped stays in the list for a while (it may come back, and the host may want to remove it),
  // dimmed — it used to be counted, so the drawer said 12 where the stage said 11.
  const here = players.filter((c) => c.connected).length;

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "var(--stage)" }}>
      <div className="mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col gap-4" style={{ padding: safeAreaPadding(16, 20, 16) }}>
        <div className="flex h-11 shrink-0 items-center">
          <span className="font-display text-xl font-bold">{here} players</span>
        </div>
        <div className="flex min-h-0 grow flex-col gap-2 overflow-y-auto overscroll-contain">
          {players.map((p) => {
            const level = healthLevel(health[p.id] ?? null, healthServerTime ?? 0);
            return (
              <button
                key={p.id}
                onClick={() => onSelect(p.id)}
                className="flex shrink-0 items-center gap-3 rounded-2xl border px-4 py-3 text-left"
                style={{ background: "var(--surface)", borderColor: "var(--border)", opacity: p.connected ? 1 : 0.55 }}
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ background: p.assignment ? ROLE_COLORS[p.assignment.role] : ROLE_COLORS.unison, boxShadow: `0 0 0 2px var(--surface), 0 0 0 4px ${HEALTH_COLORS[level]}` }}
                />
                {/* The part label can be two parts long now ("vocals + other"): it wraps inside its own
                    column instead of squeezing the number next to it onto two lines. */}
                <span className="flex min-w-0 grow flex-col">
                  <span className="truncate text-base font-semibold">{p.name}</span>
                  <span className="text-xs" style={{ color: "var(--muted)" }}>
                    {deviceLabel(p.device)} · {p.connected ? (p.assignment?.label ?? "—") : "away"}
                  </span>
                </span>
                <span className="font-mono shrink-0 whitespace-nowrap text-xs" style={{ color: "var(--muted)" }}>
                  {formatMs(p.assignment?.compensationMs)}
                </span>
              </button>
            );
          })}
        </div>
        <button
          onClick={onClose}
          className="flex h-14 shrink-0 items-center justify-center rounded-2xl border text-base font-semibold"
          style={{ background: "var(--surface)", borderColor: "var(--border-strong)" }}
        >
          Back to the stage
        </button>
      </div>
    </div>
  );
}
