"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ROOM_CODE_LENGTH } from "@hive/protocol";
import { apiUrl } from "@/lib/hive/client";
import { safeAreaPadding } from "@/lib/hive/safe-area";
import { Creators } from "@/components/Creators";

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
        <h1 className="font-display text-center text-5xl leading-[1.02] font-extrabold tracking-tight">
          Party wherever. Party together. Become the speaker.
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
        <Creators big />
        <a
          href="https://github.com/piar1243/hive-music-official"
          target="_blank"
          rel="noreferrer"
          aria-label="HiveMusic on GitHub"
          className="flex items-center justify-center gap-2.5 rounded-2xl border px-4 py-3 text-[14px] font-semibold"
          style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--muted)" }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.387.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.333-1.754-1.333-1.754-1.09-.745.083-.73.083-.73 1.205.084 1.84 1.236 1.84 1.236 1.07 1.835 2.807 1.305 3.492.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12z"
            />
          </svg>
          GitHub
        </a>
      </div>
    </main>
  );
}
