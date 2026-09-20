/** Shown when a one-shot reload already failed to clear a PROTOCOL_VERSION mismatch (see protocolVersionGuard.ts). */
export function ProtocolMismatchBanner({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-medium"
      style={{ background: "var(--ringer-bg)", borderColor: "var(--ringer-border)", color: "var(--ringer-fg)" }}
    >
      <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--ringer-fg)" }} />
      This phone is running an older version of the app. Close and reopen this tab to update.
    </div>
  );
}
