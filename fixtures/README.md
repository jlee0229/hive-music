# fixtures/

Demo audio the server serves on `GET /audio/:trackId/:stem.wav` and the mock serves on the same routes.
WAV files are gitignored; `meta.json` files are committed. Regenerate the synthetic track with `bun run fixtures`.

## Layout

```
fixtures/tracks/<id>/
├── drums.wav      # one mono stem per role (a non-stem track is a single stem named mix.wav)
├── bass.wav
├── vocals.wav
├── other.wav
└── meta.json      # { id, title, durationSec, sampleRate, stems[], bpm?, dropSec?, clickTimesSec?, energy[60], generated }
```

## WAV spec (every stem, no exceptions)

- 16-bit PCM, **mono**, **44100 Hz**, plain 44-byte RIFF header, **≤ 60 s**.
- All stems of a track have the same length. Peak-normalize to about −3 dBFS.
- Every phone preloads every stem (≤4 × 60 s × 44.1 kHz mono ≈ 42 MB decoded), so keep clips short.

## Adding a Demucs-separated track

1. Pick a ≤60 s clip of a file the host owns (see licensing below), e.g. `clip.wav`.
2. Separate it (4 stems, or `--two-stems=vocals` for vocals + accompaniment):
   ```
   demucs -n htdemucs clip.wav            # → separated/htdemucs/clip/{drums,bass,vocals,other}.wav
   demucs -n htdemucs --two-stems=vocals clip.wav
   ```
3. Convert each stem to the spec above:
   ```
   ffmpeg -i separated/htdemucs/clip/drums.wav -ac 1 -ar 44100 -sample_fmt s16 -t 60 fixtures/tracks/<id>/drums.wav
   ```
   (repeat for bass / vocals / other; for two-stem output name them `vocals.wav` and `other.wav`).
4. Write `meta.json` with a per-second energy curve. The generator in `gen-synthetic.ts` shows the exact
   shape; for real tracks the backend agent's `fixtures/meta-from-wavs.ts` (to be written) computes
   `energy[]` as RMS of the summed stems per second, normalized so the max is 1.0, plus `durationSec`,
   `sampleRate`, and `stems[]`. `clickTimesSec` is optional and only used by the calibration rig.

## Synthetic test track

`bun run fixtures` runs `gen-synthetic.ts`: a dependency-free Bun script that writes
`fixtures/tracks/synthetic-60s/{drums,bass,vocals,other}.wav` + `meta.json` (120 BPM, drop at 30 s,
seeded noise, so the output is byte-for-byte reproducible). CI regenerates it before typecheck/test.

## Licensing

Only the host's own files, played at private events. Nothing in this folder is redistributed: the WAVs
are gitignored and the synthetic track is generated. Do not commit copyrighted stems.
