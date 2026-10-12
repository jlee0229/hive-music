"use client";

import { ROLE_COLORS, STEMS, type ClientRecord, type StemRole } from "@hive/protocol";
import type { HiveHostControls } from "@hive/sync-client";
import { deviceLabel, formatMs } from "@/lib/hive/derive";
import { safeAreaPaddingBottom } from "@/lib/hive/safe-area";
import { NudgeSlider } from "@/components/NudgeSlider";

const PILL_ROLES: StemRole[] = [...STEMS];

/**
 * Bottom sheet over Stage: name, health numbers, part pills (pin), nudge, Remove.
 *
 * The sheet is taller than a small phone (and than any phone held sideways), so it is capped to the
 * screen and scrolls inside, and it carries its own close button: with only the backdrop to tap, a
 * sheet that covered the whole screen left "Remove from hive" as the one way out.
 */
export function PlayerSheet({
  client,
  host,
  onClose,
  showParts = true,
}: {
  client: ClientRecord;
  host: HiveHostControls;
  onClose: () => void;
  /** False where a part cannot be seen or heard (any mode but ORCHESTRA, or a one-stem song): pinning one there is hidden state. */
  showParts?: boolean;
}) {
  const roleColor = client.assignment ? ROLE_COLORS[client.assignment.role] : ROLE_COLORS.unison;
  const pinned = client.pinnedRole !== null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-label={`${client.name}'s player sheet`}>
      <button
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0"
        style={{ background: "rgba(11,15,20,0.7)" }}
      />
      <div
        className="relative flex max-h-full flex-col gap-4 overflow-y-auto rounded-t-[24px] border-t p-5"
        style={{ background: "var(--surface)", borderColor: "var(--border)", paddingBottom: safeAreaPaddingBottom(32) }}
      >
        <div className="flex items-center gap-3">
          <span className="h-11 w-11 shrink-0 rounded-full" style={{ background: roleColor }} />
          <div className="flex min-w-0 grow flex-col gap-0.5">
            <span className="font-display truncate text-[22px] font-bold">{client.name}</span>
            <span className="truncate text-[13px]" style={{ color: "var(--muted)" }}>
              {deviceLabel(client.device)} ·{" "}
              <span style={{ color: client.connected ? "var(--health-good)" : "var(--health-bad)" }}>{client.connected ? "connected" : "disconnected"}</span>
            </span>
          </div>
          <button
            aria-label="Close player sheet"
            onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border"
            style={{ background: "var(--stage)", borderColor: "var(--border)", color: "var(--muted)" }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M2 2l10 10M12 2L2 12" />
            </svg>
          </button>
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

        <div className={showParts ? "flex flex-col gap-2" : "hidden"}>
          <span className="text-[13px]" style={{ color: "var(--muted)" }}>Part</span>
          <div className="flex gap-2">
            {PILL_ROLES.map((role) => {
              const active = (client.pinnedRole ?? client.assignment?.role) === role;
              return (
                <button
                  key={role}
                  onClick={() => host.assign(client.id, role)}
                  className="h-11 min-w-0 grow rounded-xl border-2 text-sm font-semibold capitalize"
                  style={{ borderColor: ROLE_COLORS[role], background: active ? ROLE_COLORS[role] : "transparent", color: active ? "#0B0F14" : "var(--text)" }}
                >
                  {role}
                </button>
              );
            })}
          </div>
          <label className="flex min-h-11 items-center gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => {
                // The current role is only pinnable if it is a stem: in every mode but ORCHESTRA it is
                // "unison", which ASSIGN rejects (the server answered BAD_MESSAGE and the box never ticked).
                const current = PILL_ROLES.find((r) => r === client.assignment?.role);
                host.assign(client.id, e.target.checked ? (current ?? PILL_ROLES[0]!) : null);
              }}
              className="h-5 w-5 shrink-0"
              style={{ accentColor: "var(--primary-fill)" }}
            />
            Keep this part when others join
          </label>
        </div>

        <NudgeSlider value={client.nudgeMs} onCommit={(ms) => host.nudge(client.id, ms)} label="Nudge" />

        {/* Not on the host's own dot: KICK on yourself closes this phone's socket for good and
            leaves a stage where nothing works. */}
        {client.kind === "host" ? null : (
          <button
            onClick={() => {
              host.kick(client.id);
              onClose();
            }}
            className="h-11 shrink-0 rounded-xl text-sm font-semibold"
            style={{ color: "var(--health-bad)" }}
          >
            Remove from hive
          </button>
        )}
      </div>
    </div>
  );
}
