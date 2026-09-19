// Frontend agent: see agents/FRONTEND-AGENT.md and docs/06-hive-map-ui.md
import Link from "next/link";

export default function LandingPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 p-6">
      <h1 className="text-4xl font-semibold tracking-tight">HiveMusic</h1>
      <p className="max-w-xs text-center text-slate-400">
        Every phone in the room becomes one speaker.
      </p>
      <nav className="flex w-full max-w-xs flex-col gap-4">
        <Link
          href="/h/BZQ7"
          className="rounded-2xl bg-slate-100 px-6 py-4 text-center text-lg font-medium text-slate-900"
        >
          Host
        </Link>
        <Link
          href="/j/BZQ7"
          className="rounded-2xl border border-slate-600 px-6 py-4 text-center text-lg font-medium"
        >
          Join
        </Link>
      </nav>
    </main>
  );
}
