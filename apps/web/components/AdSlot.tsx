/**
 * Placeholder for a sponsor slot on player phones — the revenue story for the pitch, purely
 * visual for now. Every joined phone is guaranteed-attention screen space between songs; a real
 * implementation would rotate creatives from the server per room/venue.
 */
export function AdSlot({ dark = false }: { dark?: boolean }) {
  const faint = dark ? "rgba(241,245,249,0.55)" : "var(--faint)";
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-xl border border-dashed px-3.5 py-2.5"
      style={{ borderColor: dark ? "rgba(241,245,249,0.3)" : "var(--border)", color: faint }}
    >
      <span className="text-[10px] font-semibold tracking-[0.2em] uppercase">Sponsored</span>
      <span className="text-[12px]">Your brand here — on every phone in the room</span>
    </div>
  );
}
