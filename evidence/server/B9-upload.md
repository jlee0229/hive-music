# B9 — Bring-your-own-stems upload

Phase-2 item 1 (Replicate stays out of scope; stems are separated on the human's laptop with Demucs
beforehand, per the new `docs/09-deploy.md` §D).

```
$ bun run --cwd apps/server test src/upload
bun test v1.3.11 (af24e281)

 18 pass
 0 fail
 53 expect() calls
Ran 18 tests across 3 files. [1298.00ms]
```

## What it does

`POST /tracks`, multipart form: `title` + `hostKey` (must match some room's current hostKey — host-only,
since the route has no room code in its path) + either a single `mix` file or 1–4 files named
`drums`/`bass`/`vocals`/`other`.

- **Parsing/conversion is pure TS, no ffmpeg** (`apps/server/src/upload/wav.ts`, `convert.ts`): reads RIFF/WAVE
  PCM (8/16/24/32-bit) and 32-bit IEEE float, any channel count and sample rate; downmixes to mono; resamples
  (linear interpolation — good enough for a demo track, not a substitute for a real resampler) every stem in
  one upload to the same 44100 Hz so stems from different source files never end up misaligned; rejects
  anything over 60s with a message naming the actual length; re-encodes as 16-bit PCM mono, matching
  `fixtures/README.md`'s spec exactly.
- **meta.json is computed the way `fixtures/gen-synthetic.ts` computes it** (`apps/server/src/upload/meta.ts`,
  `apps/server/src/vibe/energy.ts` — the energy/drop-detection logic is now shared with the vibe rules
  fallback instead of duplicated): per-second energy `RMS` of the summed stems normalized to 1.0, `dropSec`
  from the same rise-detection heuristic, `durationSec`, `sampleRate`.
- Files land at `fixtures/tracks/<slug-title-8hex>/{stem}.wav` + `meta.json`; `RoomManager.reloadLibrary()`
  re-scans the directory so the new track shows up in `GET /tracks` immediately, no restart.
- `GET /audio/:id/:stem.wav` now honours a single-`Range` request (206 Partial Content) — iOS Safari probes
  media with `bytes=0-1` and a plain 200 makes it retry or give up rather than play; this was flagged in the
  engine's review of their earlier apps/server draft (`docs/PROTOCOL-REQUESTS.md` R-1 point 5) and fixed here
  since it's the same route.
- `GET /tracks` and the upload response now build `urls` from the request's own origin instead of a
  boot-time base (also from that review), so the identical binary serves `localhost:8080` and
  `https://<app>.fly.dev` with no env var — this also removed the need for the `vibe/track-meta.ts`
  filesystem-read workaround from R-1: `dropSec` now comes straight off the library entry, per the engine's
  R-2 answer.

## Known limits (acceptable for a hackathon demo track, called out rather than hidden)

- **Resampling is linear interpolation**, not a windowed-sinc resampler — audible aliasing on a large rate
  change (e.g. 8kHz → 44.1kHz) is possible. Demucs output is already 44.1kHz so the common path (Demucs →
  upload) never resamples at all.
- **Uploads vanish on the next Fly deploy** — the disk is ephemeral and `bun run fixtures` in the Dockerfile
  starts from an empty `fixtures/tracks/`. `docs/09-deploy.md` §D documents both the re-upload workaround and
  the `fly volumes` fix for before the demo.
- No `PROTOCOL_VERSION` bump and no change to `packages/protocol`: the upload response is typed against the
  existing, unmodified `TrackLibraryEntrySchema`; nothing new was added to the wire contract.

## Test coverage

`apps/server/src/upload/__tests__/{wav,convert,route}.test.ts`: WAV round-trip across every supported bit
depth, unsupported-format rejection, resampling at both directions (22050→44100, 48000→44100) with duration
preserved, the 60s cap with a client-readable error, stem-length alignment via silence padding, hostKey
rejection, "mix" XOR named-stems validation, the full HTTP round trip (upload → `GET /tracks` → `GET /audio`
→ real `SET_TRACK` over the WebSocket protocol), and the Range-request 206 path.

Root `bun run typecheck && bun run test`: green, 145 tests total (protocol 26, sync-client 79, server 40 —
including the 18 new upload tests — web 0).
