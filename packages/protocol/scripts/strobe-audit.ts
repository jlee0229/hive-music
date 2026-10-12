/**
 * Audit measurements (protocol-planner, PROTO-07/08/09): what STROBE actually does for a few rooms.
 *   bun run packages/protocol/scripts/strobe-audit.ts
 * Prints, per case: the pattern, how far the last switch of a 4-minute song lands from the true beat
 * grid, the fraction of time nobody is audible, and the lowest summed gain around a handoff.
 */
import { IDLE_CALIBRATION, PROTOCOL_VERSION, STEMS, evaluatePattern, plan, type ClientRecord, type RoomState } from "../src/index";

const client = (i: number): ClientRecord => ({
  id: `c${i}-00000000`, kind: "player", plays: true, name: `P${i}`, device: { userAgent: "", platform: "x", browserFamily: "other" },
  joinIndex: i, joinedAtServerTime: 0, position: null, pinnedRole: null, nudgeMs: 0, tableLatencyMs: null, calibratedOffsetMs: null,
  assignment: null, connected: true, audioReadyTrackId: null,
});
function room(joinIndexes: number[], params: RoomState["mode"]["params"], bpm?: number, beatOffsetSec?: number): RoomState {
  return {
    code: "BZQ7", protocolVersion: PROTOCOL_VERSION, createdAtServerTime: 0, hostClientIds: [],
    track: { id: "t", title: "t", durationSec: 240, stems: [...STEMS], bpm, beatOffsetSec }, transport: { state: "stopped" },
    mode: { kind: "STROBE", params }, scenePlan: null, calibration: IDLE_CALIBRATION, clients: Object.fromEntries(joinIndexes.map((j) => [client(j).id, client(j)])),
  };
}

function report(name: string, r: RoomState) {
  const pats = Object.values(plan(r)).map((a) => a!.pattern!);
  const p0 = pats[0]!;
  const bpm = r.track!.bpm;
  const params = { groups: 2, beatsPerSwitch: 1, ...r.mode.params };
  let drift = "n/a";
  if (bpm) {
    const trueSlot = (60000 / bpm) * params.beatsPerSwitch;
    // the planner's slot is one group's on-time; compare where the last switch of the song lands
    const slot = p0.periodMs / Math.max(1, new Set(pats.map((p) => p.phaseMs)).size, 1 / (p0.duty ?? 0.5) > 1.5 ? Math.round(1 / (p0.duty ?? 0.5)) : 1);
    const n = Math.floor(240_000 / trueSlot);
    drift = `${(n * slot - n * trueSlot).toFixed(1)} ms after ${n} switches (slot ${slot.toFixed(3)} vs true ${trueSlot.toFixed(3)})`;
  }
  // silence and handoff, sampled at 0.25 ms over two periods
  let silent = 0, total = 0, minSum = Infinity;
  for (let t = 0; t < 2 * p0.periodMs; t += 0.25) {
    const sum = pats.reduce((acc, p) => acc + evaluatePattern(p, t), 0);
    total++;
    if (sum < 0.01) silent++;
    minSum = Math.min(minSum, sum);
  }
  console.log(`${name}\n  period ${p0.periodMs} ms, duty ${p0.duty}, phases [${pats.map((p) => +p.phaseMs.toFixed(2)).join(", ")}]\n  drift: ${drift}\n  silent ${((100 * silent) / total).toFixed(1)} % of the time, min summed gain ${minSum.toFixed(3)}`);
}

report("128 BPM, 2 groups, quarter notes, 2 phones", room([1, 2], { groups: 2, beatsPerSwitch: 1 }, 128));
report("190 BPM, 2 groups, sixteenths, 2 phones", room([1, 2], { groups: 2, beatsPerSwitch: 0.25 }, 190));
report("70 BPM, 8 groups, half notes, 8 phones", room([1, 2, 3, 4, 5, 6, 7, 8], { groups: 8, beatsPerSwitch: 2 }, 70));
report("120 BPM, 4 groups, 2 phones", room([1, 2], { groups: 4, beatsPerSwitch: 1 }, 120));
report("120 BPM, 2 groups, phones with joinIndex 1 and 3", room([1, 3], { groups: 2, beatsPerSwitch: 1 }, 120));
report("120 BPM, 1 group, 3 phones", room([1, 2, 3], { groups: 1, beatsPerSwitch: 1 }, 120));
report("240 BPM, 1 group, sixteenths", room([1], { groups: 1, beatsPerSwitch: 0.25 }, 240));
report("no bpm, defaults, 2 phones", room([1, 2], {}));
