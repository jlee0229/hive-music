"use client";

import { resolveModeParams, type Mode } from "@hive/protocol";
import type { HiveHostControls } from "@hive/sync-client";

/** Note division → beats each group stays audible (4/4 assumed: 1/4 = one beat). */
const DIVISIONS = [
  { label: "1/2", beats: 2 },
  { label: "1/4", beats: 1 },
  { label: "1/8", beats: 0.5 },
  { label: "1/16", beats: 0.25 },
] as const;
const GROUP_CHOICES = [2, 3, 4, 5, 6, 8] as const;

/**
 * Shown only while STROBE is the mode: pick the beat division and how many groups trade off.
 * Each set of choices is a grid that fills the row — every option on screen and finger-sized at
 * 320 px (as scrolling rows the group chips were 34 px wide and "8" was off the edge).
 */
export function StrobeControls({ mode, bpm, host }: { mode: Mode; bpm: number | null; host: HiveHostControls }) {
  const p = resolveModeParams(mode);
  const chip = (active: boolean): React.CSSProperties => ({
    borderColor: active ? "var(--primary-fill)" : "var(--border)",
    background: active ? "var(--primary-fill)" : "transparent",
    color: active ? "var(--primary-text)" : "var(--text)",
    fontWeight: active ? 600 : 500,
  });
  return (
    <div className="flex flex-col gap-1.5 rounded-2xl border p-3" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
      <span className="text-xs" style={{ color: "var(--muted)" }}>
        Beat
      </span>
      <div className="grid grid-cols-4 gap-1.5">
        {DIVISIONS.map((d) => (
          <button
            key={d.label}
            onClick={() => host.setMode("STROBE", { ...mode.params, beatsPerSwitch: d.beats })}
            disabled={bpm == null}
            aria-pressed={p.beatsPerSwitch === d.beats}
            className="h-11 min-w-0 rounded-full border text-sm disabled:opacity-50"
            style={chip(p.beatsPerSwitch === d.beats)}
          >
            {d.label}
          </button>
        ))}
      </div>
      <span className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
        Groups
      </span>
      <div className="grid grid-cols-6 gap-1.5">
        {GROUP_CHOICES.map((g) => (
          <button
            key={g}
            onClick={() => host.setMode("STROBE", { ...mode.params, groups: g })}
            aria-pressed={p.groups === g}
            className="h-11 min-w-0 rounded-full border text-sm"
            style={chip(p.groups === g)}
          >
            {g}
          </button>
        ))}
      </div>
      <span className="mt-0.5 text-xs" style={{ color: "var(--faint)" }}>
        {bpm != null ? `${Math.round(bpm)} BPM — strobing on the beat` : "No tempo detected for this song — steady strobe"}
      </span>
    </div>
  );
}
