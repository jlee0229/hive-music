"use client";

import { ROLE_COLORS, STEMS, type ClientRecord, type StemRole } from "@hive/protocol";
import type { HiveHostControls } from "@hive/sync-client";
import { deviceLabel, formatMs } from "@/lib/hive/derive";
import { NudgeSlider } from "@/components/NudgeSlider";

const PILL_ROLES: StemRole[] = [...STEMS];

/** Bottom sheet over Stage: name, health numbers, part pills (pin), nudge, Remove. */
export function PlayerSheet({ client, host, onClose }: { client: ClientRecord; host: HiveHostControls; onClose: () => void }) {
  const roleColor = client.assignment ? ROLE_COLORS[client.assignment.role] : ROLE_COLORS.unison;
  const pinned = client.pinnedRole !== null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-label={`${client.name}'s player sheet`}>
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0"
        style={{ background: "rgba(11,15,20,0.7)" }}
      />
      <div className="relative flex flex-col gap-4 rounded-t-[24px] border-t p-5 pb-8" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
        <span className="mx-auto h-1 w-10 rounded-full" style={{ background: "var(--border)" }} />
        <div className="flex items-center gap-3">
          <span className="h-11 w-11 shrink-0 rounded-full" style={{ background: roleColor }} />
          <div className="flex grow flex-col gap-0.5">
            <span className="font-display text-[22px] font-bold">{client.name}</span>
            <span className="text-[13px]" style={{ color: "var(--muted)" }}>
              {deviceLabel(client.device)}
            </span>
          </div>
          <span className="text-xs font-medium" style={{ color: client.connected ? "var(--health-good)" : "var(--health-bad)" }}>
            {client.connected ? "connected" : "disconnected"}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col gap-0.5 rounded-xl p-2.5" style={{ background: "var(--stage)" }}>
            <span className="text-[11px]" style={{ color: "var(--faint)" }}>compensation</span>
            <span className="font-mono text-[15px]">{formatMs(client.assignment?.compensationMs)}</span>
          </div>
          <div className="flex flex-col gap-0.5 rounded-xl p-2.5" style={{ background: "var(--stage)" }}>
            <span className="text-[11px]" style={{ color: "var(--faint)" }}>nudge</span>
            <span className="font-mono text-[15px]">{formatMs(client.nudgeMs)}</span>
          </div>
          <div className="flex flex-col gap-0.5 rounded-xl p-2.5" style={{ background: "var(--stage)" }}>
            <span className="text-[11px]" style={{ color: "var(--faint)" }}>table</span>
            <span className="font-mono text-[15px]">{client.tableLatencyMs == null ? "—" : `${client.tableLatencyMs} ms`}</span>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[13px]" style={{ color: "var(--muted)" }}>Part</span>
          <div className="flex gap-2">
            {PILL_ROLES.map((role) => {
              const active = (client.pinnedRole ?? client.assignment?.role) === role;
              return (
                <button
                  key={role}
                  onClick={() => host.assign(client.id, role)}
                  className="h-11 grow rounded-xl border-2 text-sm font-semibold capitalize"
                  style={{ borderColor: ROLE_COLORS[role], background: active ? ROLE_COLORS[role] : "transparent", color: active ? "#0B0F14" : "var(--text)" }}
                >
                  {role}
                </button>
              );
            })}
          </div>
          <label className="flex items-center gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => host.assign(client.id, e.target.checked ? (client.assignment?.role as StemRole | undefined) ?? PILL_ROLES[0]! : null)}
              className="h-5 w-5"
              style={{ accentColor: "var(--primary-fill)" }}
            />
            Keep this part when others join
          </label>
        </div>

        <NudgeSlider value={client.nudgeMs} onCommit={(ms) => host.nudge(client.id, ms)} label="Nudge" />

        <button
          onClick={() => {
            host.kick(client.id);
            onClose();
          }}
          className="h-11 rounded-xl text-sm font-semibold"
          style={{ color: "var(--health-bad)" }}
        >
          Remove from hive
        </button>
      </div>
    </div>
  );
}
