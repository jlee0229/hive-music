"use client";

import { ROLE_COLORS, healthLevel, type HealthSnapshot, type RoomState } from "@hive/protocol";
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

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "var(--stage)" }}>
      <div className="mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col gap-4" style={{ padding: safeAreaPadding(52, 20, 28) }}>
        <div className="flex shrink-0 items-center justify-between">
          <span className="font-display text-xl font-bold">{players.length} players</span>
          <span className="text-[13px]" style={{ color: "var(--muted)" }}>sorted by sync health</span>
        </div>
        <div className="flex min-h-0 grow flex-col gap-2 overflow-y-auto">
          {players.map((p) => {
            const level = healthLevel(health[p.id] ?? null, healthServerTime ?? 0);
            return (
              <button
                key={p.id}
                onClick={() => onSelect(p.id)}
                className="flex items-center gap-2.5 rounded-2xl border px-3.5 py-3 text-left"
                style={{ background: "var(--surface)", borderColor: "var(--border)" }}
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ background: p.assignment ? ROLE_COLORS[p.assignment.role] : ROLE_COLORS.unison, boxShadow: `0 0 0 2px var(--surface), 0 0 0 4px ${{ good: "#22C55E", warn: "#EAB308", bad: "#EF4444", unknown: "#64748B" }[level]}` }}
                />
                <span className="flex grow flex-col">
                  <span className="text-[15px] font-semibold">{p.name}</span>
                  <span className="text-xs" style={{ color: "var(--muted)" }}>
                    {deviceLabel(p.device)} · {p.assignment?.label ?? "—"}
                  </span>
                </span>
                <span className="font-mono text-xs" style={{ color: "var(--muted)" }}>
                  {formatMs(p.assignment?.compensationMs)}
                </span>
              </button>
            );
          })}
        </div>
        <button
          onClick={onClose}
          className="flex h-13 shrink-0 items-center justify-center rounded-2xl border font-semibold"
          style={{ height: 52, background: "var(--surface)", borderColor: "var(--border)" }}
        >
          Back to the stage
        </button>
      </div>
    </div>
  );
}
