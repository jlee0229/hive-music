# 10 · Contingency: what to do when the phone test goes badly

The risk register in [08-roadmap.md](08-roadmap.md#risk-register) lists what might go wrong. This doc is the other half: **a triage
order for the first phone test, a symptom → fallback table, and three demo tiers with the pitch rewritten for each**, so the claims
on stage always match what the room can actually show. Read it before the first test, not after.

The honest premise: the two failures most likely to bite are physical, not code. An iPhone with its ringer switch off is silent
while reporting healthy, and venue Wi-Fi with RTT spikes or a captive portal breaks clock sync. Neither has a software fix; both
have a staging fix.

## 1. Triage in the first fifteen minutes

Do these in order and stop at the first failure. Paste `/diag` → **Copy report** from each phone to the orchestrating session
with one line of what you heard.

| # | Check | Pass | Fail → jump to |
|---|---|---|---|
| 1 | Host phone opens `/h/BZQ7`, lobby shows QR | lobby renders | §3 row **Hosting** |
| 2 | Two phones scan, tap to join, reach **Synced ±N ms** with N ≤ 20 | both within 60 s | §3 row **Clock** |
| 3 | Press Start: both phones make sound | sound from both | §3 row **Silent phone** |
| 4 | Stand between them, eyes closed: one source or two? | fused, or a slight thickening | §3 row **Smear** |
| 5 | Drag one phone's nudge slider +40 ms: it audibly falls behind; −40 ms: it leads | direction matches the label | §3 row **Nudge backwards** (stop and report; do not calibrate) |
| 6 | Tune the hive with three phones, one nudged +40: that residual ≈ −40 ± 5, others ≈ 0 | signs right, Apply tightens the sound | §3 row **Calibration wrong** |
| 7 | Orchestra, then Wave, then Strobe, each for 20 s | modes switch without a gap or reload | §3 row **Mode glitch** |
| 8 | Lock one phone 10 s, unlock: it rejoins within 5 s and is back in sync | one tap at most | §3 row **Resume** |
| 9 | Vibe: "calm, then explode at the drop" | two-scene strip, drop lands together | rules fallback covers it; note only |

If 1–4 pass on two phones, add phones in pairs up to the demo count and repeat 4 each time. The number of phones at which
row 4 fails is the demo size; do not argue with it on stage.

## 2. How to read what you hear

- **A clean echo or a "slapback"** between phones = skew above ~30 ms. Clock or latency-table problem; nudge fixes one phone at a
  time, calibration fixes all at once.
- **A thickening / chorus / comb-filter swish** = skew 5–25 ms. Expected for UNISON on mixed devices before tuning; tuning should
  remove most of it. This is the regime where ORCHESTRA already sounds right (see §4).
- **One phone drifting slowly out and snapping back** every minute or two = the audio clock drift sawtooth (B4); harmless at
  ≤10 ms, and B9e slewing (phase 2) removes the snap. If the snap is audible as a click, cut WAVE and keep the crossfade.
- **Everything fine at t=0, ragged after 3 minutes** = drift correction not running (`syncErrMs` climbing on `/diag`). Restart
  playback from the host; report.
- **Sound stops on one phone when its screen locks** = wake lock lost; that phone's user taps once. If it happens on every
  iPhone, set auto-lock to Never on the demo phones (checklist item in 08).

## 3. Symptom → fallback

| Symptom | First move (≤ 2 min) | Second move | Demo tier |
|---|---|---|---|
| **Hosting** — Vercel or Fly page fails | check `https://hivemusic-server.fly.dev/health` and the Vercel deployment list; promote the last **Ready** deployment | bag laptop: `bun run --cwd apps/server dev` + `cloudflared tunnel` (09-deploy §D); phones on the hotspot | A |
| **Clock** — Synced ±N with N > 20 on most phones, or never syncs | every phone onto the host's **hotspot**, cellular off; the server stays on Fly | if the hotspot's uplink is also bad: bag laptop on the hotspot's LAN, `NEXT_PUBLIC_WS_URL` at the laptop's IP, plain `ws://` needs `http://` pages, so use the tunnel | A, smaller room |
| **Silent phone** — ready, no sound | iPhone: ringer switch **on**, volume up, close other audio apps; Android: media volume not ring volume | that phone stays visual-only (it still pulses); do not spend stage time on it | A |
| **Smear** — UNISON audibly two sources after tuning | fewer phones, closer together (within 1 m of each other); one device family if possible | drop the UNISON beat from the script; open on ORCHESTRA | B |
| **Nudge backwards** — +40 makes a phone *lead* | stop; paste `/diag` and say so; this is a sign bug and calibration would double every error | demo on nudge-free modes until fixed | B |
| **Calibration wrong** — residual sign inverted or values wild | do **not** Apply; use **Reset tuning** (phase 2) if offsets were already applied | Tier 1 only: nudge one phone live on stage instead (08 script note) | A without the tuning beat |
| **Mode glitch** — gap or dropout when entering WAVE | keep WAVE out; ORCHESTRA → STROBE directly | if STROBE also glitches, finish on ORCHESTRA + vibe scene strip | B |
| **Resume** — locked phone never comes back | that user reloads the join page (identity persists, 120 s retention) | auto-lock Never on all demo phones | A |
| **Stems too slow** — progress bars stall on N phones | start the join phase 5 min earlier; the demo-light track (30 s, 22.05 kHz, phase 2) is a quarter of the bytes | one-stem `mix` track: UNISON/WAVE/STROBE still work, ORCHESTRA does not | A or B |
| **Fly restart mid-demo** | host reloads `/h/BZQ7` (room is re-created with the fixed code), re-selects the track, presses Play; players' reconnect banners clear | if players show "Hive not found", they reload the join page | A |
| **Nothing works on the day** | see §4 tier C | | C |

## 4. Three demo tiers

Pick the tier at the end of the last rehearsal, not during the talk. Each tier's pitch line is written so it is *true* for what
that tier shows.

### Tier A — full script (08-roadmap §demo script)
Six or more phones, unison fusion, tuning moment, orchestra, vibe, wave/strobe finale.
Pitch line: *"+10 dB from ten phones, fusion under 10 ms, and no laptop anywhere."*

### Tier B — stems first, no unison claim
Four to six phones. Open on **ORCHESTRA** (each phone a different instrument), walk the room, drag the map, vibe prompt, finish
on **STROBE** (and WAVE if it is clean). Skip the unison beat and the tuning moment, or do the tuning moment only if §1 row 6
passed.
Why this works when unison does not: the fusion threshold (~10–20 ms) is for *identical* signals arriving twice, where the ear
hears the second copy as an echo or comb filter. Different stems from different phones are different signals: 20–40 ms between a
drum phone and a bass phone reads as groove, not as a defect, and the precedence effect localises each part to its phone, which
is the point of the mode. STROBE is judged by eye, where 30–50 ms is invisible.
Pitch line: *"Every phone plays a different part of the same song on one shared clock. Walk the room and the mix changes around
you. No app, no laptop."*

### Tier C — visual sync plus the recording
Phones muted or silent (or the hall too loud). Show the **Hive Map on the projector** (`/screen/BZQ7`, phase 2), the phones
flashing STROBE and sweeping WAVE together in the audience's hands, the `/diag` numbers, and the **video from the successful
rehearsal** for the audio claim. The measurement rig's output (evidence/backend/B8-calibration.md) is the evidence for the
≤10 ms number if a judge asks.
Pitch line: *"Thirty phones on one clock to within a few milliseconds; here is what it sounds like when the room is quiet"* (cut
to the video).

**Record the first run that works tonight**, with a phone held between two players and then panning across the room. It is
the Tier C asset and it costs nothing when things are going well.

## 5. Pre-emptive work (phase 2, no phones needed)

| Item | Owner | Why it is on this list |
|---|---|---|
| `CALIBRATION_RESET` (host-only; clears `calibratedOffsetMs` for all or one client) + **Reset tuning** button | engine → server → frontend | a tuning run that makes things worse must be undoable in one tap; today it can only be nudged over |
| demo-light track: 30 s, 22.05 kHz variant of `synthetic-60s` (`synthetic-30s-lite`) | engine (fixtures) | a quarter of the download; phone speakers have no content above ~10 kHz anyway |
| `/screen/[code]` projector view | frontend | Tier C, and Tier A's projector without mirroring the host phone |
| `/diag` **Copy report** | frontend | the paste-to-orchestrator loop in §1 |
| bag-laptop fallback rehearsed once: `bun run --cwd apps/server dev`, `cloudflared tunnel`, Vercel env pointed at it | human (09-deploy §D) | Fly or venue-network failure |
| **code freeze** after the last good rehearsal: set the GitHub repo variable `FLY_DEPLOY_DISABLED=true`, tag `demo` on main, stop merging | orchestrator | main auto-deploys to Fly on every merge; the demo must not run on code nobody has heard |

## 6. Freeze procedure

1. After the last rehearsal that sounded right: `git tag demo <sha> && git push origin demo`.
2. GitHub → Settings → Secrets and variables → Actions → Variables → `FLY_DEPLOY_DISABLED` = `true`. Vercel → the Ready
   deployment of that sha → **Promote to Production** (Vercel has no auto-deploy switch per branch; promoting pins it).
3. Nothing merges to `main` until after the demo. Fixes found in the rehearsal go to a branch and are cherry-picked *only* with a
   fresh phone check.
4. To resume: variable back to `false`, next merge deploys.
