// System + user prompt builders for the Vibe Director LLM call (docs/05-effect-modes.md §System prompt outline).

export interface TrackMetaForPrompt {
  title: string;
  durationSec: number;
  stems: string[];
  bpm?: number;
  dropSec?: number;
  energy?: number[];
}

export const SYSTEM_PROMPT = `You are the lighting-and-sound director for a crowd of phones playing one track together on HiveMusic.

Five modes are available:
- UNISON: every phone plays the whole mix in sync. The calm, safe default.
- ORCHESTRA: each phone plays one instrument stem; needs at least 2 real stems.
- STEREO: the room splits into a left zone (drums+bass) and a right zone (vocals+other); needs real stems.
- WAVE: the beat rolls across the room from one side to the other; high energy, works with any stems.
- STROBE: the music gates on and off in groups, ping-ponging across the room; the most intense mode.

Parameters: WAVE takes { axis: 'x'|'y', spanMs: 0-300, default 240 }. STROBE takes
{ periodMs: 100-8000 default 500, duty: 0.05-1 default 0.5, groups: 1-8 default 2 }.
Any mode may include { stemGainsDb } to trim an individual stem in dB.

Rules: the first scene must be at atTrackSec 0. Do not switch modes more than once every 8 seconds.
Match the energy curve: low energy favors UNISON or ORCHESTRA, rises favor WAVE, peaks favor STROBE.
Each note must be 40 characters or fewer. Never propose more scenes than durationSec / 8.
Output only the scene list; the response format is enforced for you.`;

function downsampleEnergy(energy: number[] | undefined, maxPoints = 60): number[] {
  if (!energy || energy.length <= maxPoints) return energy ?? [];
  const out: number[] = [];
  const step = energy.length / maxPoints;
  for (let i = 0; i < maxPoints; i++) out.push(energy[Math.floor(i * step)]!);
  return out;
}

function topRises(energy: number[] | undefined, count = 3): number[] {
  if (!energy || energy.length < 2) return [];
  const rises = energy.slice(1).map((v, i) => ({ t: i + 1, rise: v - energy[i]! }));
  return rises
    .sort((a, b) => b.rise - a.rise)
    .slice(0, count)
    .map((r) => r.t);
}

export function userPrompt(prompt: string, meta: TrackMetaForPrompt, playerCount: number, currentMode: string): string {
  const energy = downsampleEnergy(meta.energy);
  const rises = topRises(meta.energy);
  return [
    `Vibe request: "${prompt}"`,
    `Track: "${meta.title}", ${meta.durationSec}s${meta.bpm ? `, ${meta.bpm} BPM` : ""}, stems: ${meta.stems.join(", ")}.`,
    `${playerCount} phones connected. Current mode: ${currentMode}.`,
    meta.dropSec != null ? `Known drop at ${meta.dropSec}s.` : "",
    `Energy curve (0..1, ${energy.length} points across the track): ${JSON.stringify(energy)}`,
    rises.length ? `Largest energy rises at sample indices: ${rises.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
