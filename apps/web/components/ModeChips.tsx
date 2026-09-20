"use client";

import { MODES, type ModeKind } from "@hive/protocol";
import type { HiveHostControls } from "@hive/sync-client";

function label(kind: ModeKind): string {
  return kind.charAt(0) + kind.slice(1).toLowerCase();
}

export function ModeChips({ current, host }: { current: ModeKind; host: HiveHostControls }) {
  return (
    <div className="flex gap-2 overflow-x-auto">
      {MODES.map((kind) => {
        const active = kind === current;
        return (
          <button
            key={kind}
            onClick={() => host.setMode(kind)}
            className="h-10 shrink-0 rounded-full border px-3.5 text-sm"
            style={{
              borderColor: active ? "var(--primary-fill)" : "var(--border)",
              background: active ? "var(--primary-fill)" : "transparent",
              color: active ? "var(--primary-text)" : "var(--text)",
              fontWeight: active ? 600 : 500,
            }}
          >
            {label(kind)}
          </button>
        );
      })}
    </div>
  );
}
