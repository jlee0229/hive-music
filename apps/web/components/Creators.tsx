/** The byline. `dark` renders on the player's colored/stage backgrounds; `big` for the landing page. */
export function Creators({ dark = false, big = false }: { dark?: boolean; big?: boolean }) {
  return (
    <p
      className={`text-center ${big ? "text-[17px] font-bold" : "text-[13px] font-semibold"}`}
      style={{ color: dark ? "rgba(241,245,249,0.8)" : "var(--muted)" }}
    >
      Creators: Frank Lucci &amp; Jaeho Lee
    </p>
  );
}
