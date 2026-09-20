import type { ConnectionState } from "@hive/sync-client";

/** Every screen shows this when the socket drops; the engine reconnects with backoff on its own. */
export function ReconnectBanner({ connection }: { connection: ConnectionState }) {
  if (connection !== "reconnecting") return null;
  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-medium"
      style={{ background: "var(--ringer-bg)", borderColor: "var(--ringer-border)", color: "var(--ringer-fg)" }}
    >
      <span className="inline-block h-2 w-2 animate-pulse rounded-full" style={{ background: "var(--ringer-fg)" }} />
      Reconnecting to the hive…
    </div>
  );
}
