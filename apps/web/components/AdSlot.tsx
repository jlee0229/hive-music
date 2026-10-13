/**
 * Placeholder for a sponsor slot on player phones — the revenue story for the pitch, purely
 * visual for now. Every joined phone is guaranteed-attention screen space between songs; a real
 * implementation would rotate creatives from the server per room/venue.
 *
 * `dark` is the slot on the playing screen's scrim panel, over a role colour. Its text is 80 % of
 * --text there, which is 5.4:1 or better on every role (it was 55 %: 2.6:1 on unison, 3.3:1 on
 * vocals). On the stage it is --muted, 7.5:1. Label over line rather than side by side: on a
 * 320 px phone the line used to be squeezed into three rows beside the label.
 */
export function AdSlot({ dark = false }: { dark?: boolean }) {
  return (
    <div
      className="flex flex-col gap-0.5 rounded-xl border px-3.5 py-2"
      style={{
        borderColor: dark ? "rgba(241,245,249,0.3)" : "var(--border)",
        color: dark ? "rgba(241,245,249,0.8)" : "var(--muted)",
      }}
    >
      <span className="eyebrow">Sponsored</span>
      <span className="text-sm" style={{ textWrap: "balance" }}>
        Your brand here — on every phone in the room
      </span>
    </div>
  );
}
