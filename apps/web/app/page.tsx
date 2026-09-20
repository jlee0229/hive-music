"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ROOM_CODE_LENGTH } from "@hive/protocol";
import { apiUrl } from "@/lib/hive/client";
import { safeAreaPadding } from "@/lib/hive/safe-area";

export default function LandingPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [hosting, setHosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function hostAHive() {
    setHosting(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl()}/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`POST /rooms failed: ${res.status}`);
      const data = (await res.json()) as { code: string; hostKey: string };
      try {
        globalThis.localStorage?.setItem(`hive:hostKey:${data.code}`, data.hostKey);
      } catch {
        /* ignore */
      }
      router.push(`/h/${data.code}`);
    } catch {
      setError("Could not reach the hive server. Is it running?");
      setHosting(false);
    }
  }

  function join(e: React.FormEvent) {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (c.length < 3) return;
    router.push(`/j/${c}`);
  }

  return (
    <main
      className="mx-auto flex min-h-dvh max-w-md flex-col justify-between gap-8"
      style={{ padding: safeAreaPadding(56, 24, 32) }}
    >
      <div className="flex items-center gap-2.5">
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="var(--text)" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 2l10.4 6v12L14 26 3.6 20V8z" />
          <circle cx="14" cy="14" r="4" />
        </svg>
        <span className="font-display text-xl font-bold tracking-wide">HiveMusic</span>
      </div>

      <div className="flex flex-col gap-4">
        <h1 className="font-display text-5xl leading-[1.02] font-extrabold tracking-tight">
          Every phone in the room. One speaker.
        </h1>
      </div>

      <div className="flex flex-col gap-3">
        <button
          onClick={hostAHive}
          disabled={hosting}
          className="flex h-14 items-center justify-center rounded-2xl text-lg font-semibold disabled:opacity-60"
          style={{ background: "var(--primary-fill)", color: "var(--primary-text)" }}
        >
          {hosting ? "Creating your hive…" : "Host a hive"}
        </button>
        <form onSubmit={join} className="flex items-end gap-2.5">
          <label className="flex grow flex-col gap-1.5 text-xs" style={{ color: "var(--muted)" }}>
            Hive code
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, ROOM_CODE_LENGTH + 2))}
              aria-label="Hive code"
              placeholder="BZQ7"
              className="font-mono h-13 w-full rounded-2xl border px-4 text-xl tracking-[0.2em] uppercase outline-none"
              style={{ height: 52, background: "var(--surface)", borderColor: "var(--border)", color: "var(--text)" }}
            />
          </label>
          <button
            type="submit"
            className="flex h-13 items-center justify-center rounded-2xl border px-5 font-semibold"
            style={{ height: 52, background: "var(--surface)", borderColor: "var(--border)", color: "var(--text)" }}
          >
            Join
          </button>
        </form>
        {error ? <p className="text-center text-sm" style={{ color: "var(--health-bad)" }}>{error}</p> : null}
        <p className="mt-1 text-center text-sm" style={{ color: "var(--faint)" }}>
          Runs in your browser. Nothing to install.
        </p>
      </div>
    </main>
  );
}
