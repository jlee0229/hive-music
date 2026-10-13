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
      setError("Couldn’t set the vibe. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <label className="flex h-11 min-w-0 grow items-center rounded-2xl border px-4" style={{ background: "var(--surface)", borderColor: "var(--border-strong)" }}>
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value.slice(0, 200))}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Describe the vibe"
            aria-label="Describe the vibe"
            // 16 px: anything smaller makes iOS zoom the page when the box is focused.
            className="w-full min-w-0 bg-transparent text-base outline-none"
            style={{ color: "var(--text)" }}
          />
        </label>
        <button
          onClick={submit}
          disabled={busy}
          className="flex h-11 shrink-0 items-center justify-center rounded-2xl px-4 text-sm font-semibold disabled:opacity-60"
          style={{ background: "var(--primary-fill)", color: "var(--primary-text)" }}
        >
          {busy ? "Directing…" : "Direct"}
        </button>
      </div>
      {error ? (
        <span className="text-xs" style={{ color: "var(--danger)" }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
