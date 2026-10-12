"use client";

import { MODES, type ModeKind } from "@hive/protocol";
import type { HiveHostControls } from "@hive/sync-client";

function label(kind: ModeKind): string {
  return kind.charAt(0) + kind.slice(1).toLowerCase();
}

/**
 * Three to a row, so all six modes are on screen at every phone width. As one scrolling row, Strobe
 * and Choir sat off the right edge on anything narrower than ~400 px with nothing to say they exist.
 */
export function ModeChips({ current, host }: { current: ModeKind; host: HiveHostControls }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {MODES.map((kind) => {
        const active = kind === current;
        return (
          <button
            key={kind}
            onClick={() => host.setMode(kind)}
            aria-pressed={active}
            className="h-11 min-w-0 rounded-full border px-1 text-sm"
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
