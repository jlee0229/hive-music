"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/hive/client";
import { safeAreaPadding } from "@/lib/hive/safe-area";
import { Creators } from "@/components/Creators";

/** The server accepts 3–8 character codes (random ones are 4); see ClientMessageSchema JOIN. */
const CODE_MIN = 3;
const CODE_MAX = 8;
/**
 * Why "Host a hive" did not work, in the page's own words. The service says no for two reasons a
 * person can act on, and "check your connection" is the wrong advice for both of them.
 */
const HOST_ERRORS = {
  /** 429 rate_limited: too many hives started from this network in the last minute. */
  tooMany: "Too many hives started from here just now. Wait a minute and try again.",
  /** 503 server_full: every hive the service can run is running. */
  full: "HiveMusic is full right now. Try again in a little while.",
  /** No answer, a dropped request, or any other failure. */
  connection: "Couldn't start a hive. Check your connection and try again.",
} as const;

/** A cold server can take a few seconds to answer; past this the guest needs their button back. */
const HOST_TIMEOUT_MS = 10_000;

/**
 * Whatever was typed or pasted, as a hive code: a whole join link gives up its code, and spaces,
 * dashes and lower case (how codes get read out and texted) are forgiven.
 */
function codeFromInput(value: string): string {
  const fromLink = value.match(/\/j\/([^/?#\s]+)/i);
  return (fromLink ? fromLink[1]! : value).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_MAX);
}

export default function LandingPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [hosting, setHosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);

  async function hostAHive() {
    setHosting(true);
    setError(null);
    const abort = new AbortController();
    // Without a deadline a request that never answers left "Creating your hive…" up for good.
    const deadline = setTimeout(() => abort.abort(), HOST_TIMEOUT_MS);
    try {
      const res = await fetch(`${apiUrl()}/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
        signal: abort.signal,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (res.status === 429) setError(HOST_ERRORS.tooMany);
        else if (res.status === 503 && body?.error === "server_full") setError(HOST_ERRORS.full);
        else setError(HOST_ERRORS.connection);
        setHosting(false);
        return;
      }
      const data = (await res.json()) as { code: string; hostKey: string };
      try {
        globalThis.localStorage?.setItem(`hive:hostKey:${data.code}`, data.hostKey);
      } catch {
        /* ignore */
      }
      router.push(`/h/${data.code}`);
    } catch {
      setError(HOST_ERRORS.connection);
      setHosting(false);
    } finally {
      clearTimeout(deadline);
    }
  }

  function join(e: React.FormEvent) {
    e.preventDefault();
    if (code.length < CODE_MIN) {
      // Used to do nothing at all, which reads as a dead button.
      setError("Enter the code from the host's screen.");
      codeInput.current?.focus();
      return;
    }
    router.push(`/j/${code}`);
  }

  return (
    // One screen on every phone: brand, the headline, the two actions, the byline, GitHub.
    // Upright the three blocks stack; on a phone held sideways (the `sideways` variant in
    // globals.css) the headline and the actions sit side by side. On a desktop the column widens
    // for the headline only — the actions stay a hand-sized column.
    <main
      className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 sideways:flex-row sideways:items-center sideways:gap-8"
      style={{ padding: safeAreaPadding(16, 20, 16) }}
    >
      <div className="flex flex-1 flex-col gap-6 sideways:self-stretch">
        <div className="flex items-center gap-2 lg:justify-center">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="var(--text)" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 2l10.4 6v12L14 26 3.6 20V8z" />
            <circle cx="14" cy="14" r="4" />
          </svg>
          <span className="font-display text-xl font-bold tracking-wide">HiveMusic</span>
        </div>

        {/* The words are the founder's and are not to be edited. A sentence to a line, sized from
            the width so "Party wherever." always holds one line (--landing-headline): it used to
            be a fixed 48 px, which broke as "Party / wherever. / Party / together. / Become the /
            speaker." on a 320 px phone and pushed the Join row off the screen. */}
        <h1 className="font-display my-auto text-center leading-[1.02] font-extrabold tracking-tight" style={{ fontSize: "var(--landing-headline)" }}>
          <span className="block">Party wherever.</span> <span className="block">Party together.</span>{" "}
          <span className="block" style={{ textWrap: "balance" }}>
            Become the speaker.
          </span>
        </h1>
      </div>

      <div className="mx-auto flex w-full max-w-md flex-col gap-3 sideways:flex-1">
        <button
          onClick={hostAHive}
          disabled={hosting}
          className="flex h-14 shrink-0 items-center justify-center rounded-2xl text-xl font-semibold disabled:opacity-60"
          style={{ background: "var(--primary-fill)", color: "var(--primary-text)" }}
        >
          {hosting ? "Creating your hive…" : "Host a hive"}
        </button>
        <form onSubmit={join} className="flex gap-2">
          <input
            ref={codeInput}
            value={code}
            onChange={(e) => {
              setCode(codeFromInput(e.target.value));
              setError(null);
            }}
            aria-label="Hive code"
            // Says what goes here, and is not a real code: the old demo code read as "type this".
            placeholder="Hive code"
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="go"
            className="font-mono h-14 min-w-0 grow rounded-2xl border px-4 text-xl tracking-[0.2em] uppercase outline-none focus-visible:border-[color:var(--text)]"
            style={{ background: "var(--surface)", borderColor: "var(--border-strong)", color: "var(--text)" }}
          />
          <button
            type="submit"
            className="flex h-14 shrink-0 items-center justify-center rounded-2xl border px-5 text-base font-semibold"
            style={{ background: "var(--surface)", borderColor: "var(--border-strong)", color: "var(--text)" }}
          >
            Join
          </button>
        </form>
        {error ? (
          <p role="alert" className="text-center text-sm" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}
        <Creators big />
        <a
          href="https://github.com/piar1243/hive-music-official"
          target="_blank"
          rel="noreferrer"
          aria-label="HiveMusic on GitHub"
          className="flex h-11 shrink-0 items-center justify-center gap-2 rounded-2xl border px-4 text-sm font-semibold"
          style={{ background: "var(--surface)", borderColor: "var(--border-strong)", color: "var(--muted)" }}
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
