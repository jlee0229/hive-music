/** The byline. `dark` renders on the playing screen's scrim panel; `big` for the landing page. */
export function Creators({ dark = false, big = false }: { dark?: boolean; big?: boolean }) {
  return (
    <p
      className={`text-center ${big ? "text-xl font-bold" : "text-sm font-semibold"}`}
      // On the scrim the line was 80 % of --text: 3.7:1 over unison. At full strength it is 7.3:1 or better.
      style={{ color: dark ? "var(--text)" : "var(--muted)" }}
    >
      Creators: Frank Lucci &amp; Jaeho Lee
    </p>
  );
}
