"use client";

import { useEffect, useRef, useState } from "react";
import { NUDGE_RANGE_MS } from "@hive/protocol";

/** −100…+100 ms; sends on release, debounced 150 ms so a drag doesn't spam NUDGE. */
export function NudgeSlider({
  value,
  onCommit,
  label = "Nudge",
  dark = false,
}: {
  value: number;
  onCommit: (ms: number) => void;
  label?: string;
  dark?: boolean;
}) {
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setLocal(value), [value]);

  function commit(v: number) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onCommit(v), 150);
  }

  const mutedColor = dark ? "#94A3B8" : "rgba(11,15,20,0.7)";

  return (
    <div className="no-callout flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs" style={{ color: mutedColor }}>
          {label}
        </span>
        <span className="font-mono text-xs">{local > 0 ? "+" : ""}{local} ms</span>
      </div>
      <input
        type="range"
        min={-NUDGE_RANGE_MS}
        max={NUDGE_RANGE_MS}
        step={5}
        value={local}
        aria-label={label}
        onChange={(e) => setLocal(Number(e.target.value))}
        onMouseUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
        onTouchEnd={(e) => commit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
        className="h-11 w-full"
        style={{ accentColor: dark ? "#F1F5F9" : "#0B0F14" }}
      />
      <div className="flex justify-between text-[11px]" style={{ color: mutedColor }}>
        <span>−{NUDGE_RANGE_MS} · sounds early</span>
        <span>sounds late · +{NUDGE_RANGE_MS}</span>
      </div>
      <span className="text-[11px]" style={{ color: mutedColor }}>
        Small moves are absorbed — try ±20
      </span>
    </div>
  );
}
