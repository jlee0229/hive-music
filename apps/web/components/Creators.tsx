/** The byline. `dark` renders on the playing screen's scrim panel; `big` for the landing page. */
export function Creators({ dark = false, big = false }: { dark?: boolean; big?: boolean }) {
  return (
    <p
      // Semibold is the heaviest weight of the body face the page loads; "bold" was a synthesised 600.
      className={`text-center font-semibold ${big ? "whitespace-nowrap" : "text-sm"}`}
      style={{
        // On the scrim the line was 80 % of --text: 3.7:1 over unison. At full strength it is 7.3:1 or better.
        color: dark ? "var(--text)" : "var(--muted)",
        // Landing: as large as one line allows, 20 px at most (17 px on a 320 px phone).
        ...(big ? { fontSize: "var(--landing-byline)" } : null),
      }}
    >
      Creators: Frank Lucci &amp; Jaeho Lee
    </p>
  );
}
