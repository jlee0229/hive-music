import { engineKind } from "@/lib/hive/client";

/** NEXT_PUBLIC_HIVE_ENGINE=real is the default now; this only shows when stub is explicitly opted into. */
export function StubEngineBanner() {
  if (engineKind() !== "stub") return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex justify-center"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      aria-hidden="true"
    >
      <span
        className="font-mono rounded-b-lg px-3 py-1 text-[10px] font-semibold tracking-widest"
        style={{ background: "var(--ringer-bg)", color: "var(--ringer-fg)", border: "1px solid var(--ringer-border)", borderTop: "none" }}
      >
        STUB ENGINE — no audio
      </span>
    </div>
  );
}
