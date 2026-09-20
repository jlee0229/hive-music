"use client";

import { useState } from "react";
import type { HiveHostControls } from "@hive/sync-client";

/** Vibe prompt + Direct -> host.vibe(prompt); the server falls back to rules within its own 5s budget. */
export function VibeBox({ host }: { host: HiveHostControls }) {
  const [prompt, setPrompt] = useState("calm, then explode at the drop");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await host.vibe(trimmed);
    } catch {
      setError("Could not reach the vibe director; try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <label className="flex h-[46px] grow items-center rounded-2xl border px-3.5" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value.slice(0, 200))}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Describe the vibe"
            aria-label="Describe the vibe"
            className="w-full bg-transparent text-sm outline-none"
            style={{ color: "var(--text)" }}
          />
        </label>
        <button
          onClick={submit}
          disabled={busy}
          className="flex h-[46px] items-center justify-center rounded-2xl px-4 text-sm font-semibold disabled:opacity-60"
          style={{ background: "var(--primary-fill)", color: "var(--primary-text)" }}
        >
          {busy ? "Directing…" : "Direct"}
        </button>
      </div>
      {error ? (
        <span className="text-xs" style={{ color: "var(--health-bad)" }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
