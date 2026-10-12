/**
 * Property tests for plan(): every mode × 0–60 clients × hosts playing or not × viewers × pins × placed
 * and unplaced × connected or not × 1-, 2- and 4-stem tracks × random (schema-valid) mode params.
 * Seeded, so a failure names its case and replays exactly.
 */
import { describe, expect, test } from "bun:test";
import { MODES, STEMS, type ModeKind } from "../constants";
import { speakerLayout } from "../layout";
import { ModeParamsSchema, resolveModeParams, type ModeParams } from "../mode";
import { arrangeStrobe, plan, withAssignments } from "../planner";
import { AssignmentSchema, RoomStateSchema, type ClientRecord, type RoomState, type StemRole } from "../room";
import { prng } from "./harness";
import { audible, client, heard, room, uncoveredFraction } from "./room-fixture";

type Rng = ReturnType<typeof prng>;

function randomParams(r: Rng, trims: boolean): ModeParams {
  const p: ModeParams = {};
  if (r.bool()) p.axis = r.pick(["x", "y"] as const);
  if (r.bool()) p.spanMs = r.pick([0, 1, 120, 240, 300, r.next() * 300]);
  if (r.bool()) p.periodMs = r.pick([100, 500, 8000, 100 + r.next() * 7900]);
  if (r.bool()) p.duty = r.pick([0.05, 0.5, 1, 0.05 + r.next() * 0.95]);
  if (r.bool()) p.groups = r.int(1, 8);
  if (r.bool()) p.beatsPerSwitch = r.pick([0.25, 0.5, 1, 2, 4, 0.25 + r.next() * 3.75]);
  if (trims && r.bool(0.3)) p.stemGainsDb = Object.fromEntries(STEMS.filter(() => r.bool()).map((s) => [s, r.pick([-60, -6, 0, 6, 12])]));
  return ModeParamsSchema.parse(p);
}

function randomRoom(r: Rng, opts: { trims?: boolean; maxClients?: number } = {}): RoomState {
  const n = r.int(0, opts.maxClients ?? 60);
  const joins = r.shuffle(Array.from({ length: 250 }, (_, k) => k)).slice(0, n);
  const clients: ClientRecord[] = joins.map((j) => {
    const kind = r.pick(["player", "player", "player", "player", "host", "viewer"] as const);
    return client(j, {
      kind,
      plays: kind === "player" ? true : kind === "host" ? r.bool(0.5) : false,
      connected: r.bool(0.85),
      position: r.bool(0.3) ? { x: r.pick([0, 1, 0.5, r.next()]), y: r.pick([0, 1, 0.5, r.next()]) } : null,
      pinnedRole: r.bool(0.15) ? (r.pick(STEMS) as StemRole) : null,
      nudgeMs: r.pick([0, 0, -100, 100, Math.round(r.next() * 200 - 100)]),
      tableLatencyMs: r.pick([null, 25, 45, 60]),
      calibratedOffsetMs: r.pick([null, null, 31.5, -12.25, 180]),
    });
  });
  const stems = r.pick([[...STEMS], [...STEMS], ["mix"], ["drums", "bass"], ["vocals", "other", "drums"]]);
  const kind = r.pick(MODES);
  const track = r.bool(0.05)
    ? null
    : { bpm: r.pick([undefined, 60, 120, 128, 174.6, 190, 97.3]), beatOffsetSec: r.pick([undefined, 0, 0.25, 3.7, 12.345]) };
  const rm = room(clients, { kind, params: randomParams(r, opts.trims ?? true) }, stems, track ?? {});
  if (track === null) rm.track = null;
  return rm;
}

function assertFinite(v: unknown, path: string): void {
  if (typeof v === "number") expect(Number.isFinite(v), `${path} = ${v}`).toBe(true);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) assertFinite(x, `${path}.${k}`);
}

const speakersOf = (rm: RoomState) => Object.values(rm.clients).filter((c) => c.plays);
function presentOf(rm: RoomState): ClientRecord[] {
  const s = speakersOf(rm);
  return s.some((c) => c.connected) ? s.filter((c) => c.connected) : s;
}

describe("plan() properties (PROTO-11)", () => {
  test("every speaker gets a schema-valid, finite assignment; everyone else gets null; the room survives a JSON round trip", () => {
    const r = prng(1);
    for (let i = 0; i < 3000; i++) {
      const rm = randomRoom(r);
      const applyAt = r.bool(0.3) ? 1_700_000_000_000 + r.next() * 1e6 : null;
      const a = plan(rm, applyAt);
      expect(Object.keys(a).sort()).toEqual(Object.keys(rm.clients).sort());
      const stems = rm.track?.stems ?? ["mix"];
      for (const c of Object.values(rm.clients)) {
        const v = a[c.id];
        if (!c.plays) {
          expect(v, `case ${i}: ${c.kind} ${c.id}`).toBeNull();
          continue;
        }
        const parsed = AssignmentSchema.safeParse(v);
        expect(parsed.success, `case ${i} ${rm.mode.kind}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`).toBe(true);
        assertFinite(v, `case ${i} ${rm.mode.kind} ${c.id}`);
        expect(Object.keys(v!.gainsDb).sort()).toEqual([...stems].sort());
        expect(v!.compensationMs).toBe(c.nudgeMs + (c.calibratedOffsetMs ?? c.tableLatencyMs ?? 0));
        expect(v!.applyAtServerTime).toBe(applyAt);
        expect(v!.pattern !== null).toBe(rm.mode.kind === "WAVE" || rm.mode.kind === "STROBE");
        expect(v!.pitchSemitones !== undefined).toBe(rm.mode.kind === "CHOIR");
        if (rm.mode.kind !== "WAVE") expect(v!.delayMs).toBe(0);
      }
      // what the server broadcasts: the whole room, through JSON, through the schema every phone applies
      const wire = JSON.parse(JSON.stringify(withAssignments(rm, applyAt)));
      const whole = RoomStateSchema.safeParse(wire);
      expect(whole.success, `case ${i} ${rm.mode.kind}: ${whole.success ? "" : JSON.stringify(whole.error.issues.slice(0, 3))}`).toBe(true);
    }
  });

  test("deterministic: same room, any key order, same plan", () => {
    const r = prng(2);
    for (let i = 0; i < 500; i++) {
      const rm = randomRoom(r);
      const shuffled: RoomState = { ...rm, clients: Object.fromEntries(r.shuffle(Object.entries(rm.clients))) };
      const a = plan(rm);
      const b = plan(shuffled);
      for (const id of Object.keys(rm.clients)) expect(b[id], `case ${i} ${rm.mode.kind}`).toEqual(a[id]!);
      expect(JSON.stringify(plan(rm))).toBe(JSON.stringify(a));
    }
  });

  test("the whole song is in the room: every stem is audible on a connected speaker, in every mode", () => {
    const r = prng(3);
    let checked = 0;
    for (let i = 0; i < 4000; i++) {
      const rm = randomRoom(r, { trims: false });
      const present = presentOf(rm);
      if (present.length === 0) continue;
      const stems = rm.track?.stems ?? ["mix"];
      // ORCHESTRA's one exception is the host's own doing: every connected speaker pinned
      if (rm.mode.kind === "ORCHESTRA" && present.every((c) => c.pinnedRole !== null && stems.includes(c.pinnedRole))) continue;
      const a = plan(rm);
      expect(heard(a, present.map((c) => c.id)), `case ${i} ${rm.mode.kind} × ${present.length}`).toEqual([...stems].sort());
      checked++;
    }
    expect(checked).toBeGreaterThan(3000);
  });

  test("STROBE: the connected speakers' on-windows cover the whole rotation (no moment when nobody is audible)", () => {
    const r = prng(4);
    let checked = 0;
    for (let i = 0; i < 3000; i++) {
      const rm = randomRoom(r);
      rm.mode = { kind: "STROBE", params: rm.mode.params };
      const present = presentOf(rm);
      if (present.length === 0) continue;
      const a = plan(rm);
      const p = resolveModeParams(rm.mode);
      const groups = arrangeStrobe(rm, p.groups).groups;
      const beatLocked = !!rm.track?.bpm;
      const pats = present.map((c) => a[c.id]!.pattern!);
      expect(new Set(pats.map((x) => x.periodMs)).size).toBe(1);
      if (beatLocked && groups >= 2) expect(uncoveredFraction(pats), `case ${i}`).toBeLessThan(1e-9);
      else if (beatLocked) expect(uncoveredFraction(pats), `case ${i}`).toBeCloseTo(0.5, 9); // one group: on a turn, off a turn
      else if (p.duty * groups >= 1) expect(uncoveredFraction(pats), `case ${i}`).toBeLessThan(1e-9); // free-running, host's own duty
      checked++;
    }
    expect(checked).toBeGreaterThan(2500);
  });

  test("stable under a join: a newcomer does not change an existing speaker's assignment, except where the mode has to", () => {
    const r = prng(5);
    const counts: Partial<Record<ModeKind, number>> = {};
    for (let i = 0; i < 4000; i++) {
      const rm = randomRoom(r, { maxClients: 40 });
      const top = Math.max(-1, ...Object.values(rm.clients).map((c) => c.joinIndex));
      const newcomer = client(top + r.int(1, 7));
      const grown: RoomState = { ...rm, clients: { ...rm.clients, [newcomer.id]: newcomer } };
      const before = plan(rm);
      const after = plan(grown);
      const present = presentOf(rm);
      const kind = rm.mode.kind;
      const sameRings = speakerLayout(rm).rings === speakerLayout(grown).rings;
      let comparable: boolean;
      switch (kind) {
        case "UNISON":
          comparable = true;
          break;
        case "WAVE":
          comparable = sameRings; // the hive grew a ring: everyone rescales, once
          break;
        case "STEREO": {
          const sides = present.map((c) => before[c.id]!.label);
          comparable = sameRings && sides.includes("left") && sides.includes("right"); // the split already existed
          break;
        }
        case "STROBE":
          comparable = present.length >= resolveModeParams(rm.mode).groups; // the rotation was already full
          break;
        case "CHOIR":
          comparable = present.some((c) => c.joinIndex % 4 === 0) || present[0] === speakersOf(rm).sort((x, y) => x.joinIndex - y.joinIndex)[0];
          break;
        case "ORCHESTRA":
          comparable = false; // checked on the arrangement itself in orchestra.test.ts (a join may take folded stems away)
          break;
      }
      if (!comparable) continue;
      counts[kind] = (counts[kind] ?? 0) + 1;
      // STROBE seats the speakers that are there first; one that is offline is re-seated when it returns anyway
      const watched = kind === "STROBE" ? present : speakersOf(rm);
      for (const c of watched) expect(after[c.id], `case ${i} ${kind} ${c.id}`).toEqual(before[c.id]!);
    }
    for (const k of ["UNISON", "WAVE", "STEREO", "STROBE", "CHOIR"] as const) expect(counts[k] ?? 0, k).toBeGreaterThan(100);
  });

  test("trims: stemGainsDb moves audible stems only, and never outside [−60, 12]", () => {
    const r = prng(6);
    for (let i = 0; i < 1000; i++) {
      const rm = randomRoom(r);
      const trims = { drums: r.pick([-60, -20, 12]), bass: r.pick([-3, 12]), mix: -6 };
      const plain = plan({ ...rm, mode: { kind: rm.mode.kind, params: { ...rm.mode.params, stemGainsDb: undefined } } });
      const trimmed = plan({ ...rm, mode: { kind: rm.mode.kind, params: { ...rm.mode.params, stemGainsDb: trims } } });
      for (const [id, v] of Object.entries(plain)) {
        if (!v) continue;
        for (const [stem, db] of Object.entries(v.gainsDb)) {
          const t = trimmed[id]!.gainsDb[stem]!;
          const trim = (trims as Record<string, number>)[stem] ?? 0;
          expect(t).toBe(db === -60 ? -60 : Math.max(-60, db + trim));
          expect(t >= -60 && t <= 12).toBe(true);
        }
      }
    }
  });

  test("an empty room, a room of only hosts and viewers, and a room with no track all plan cleanly", () => {
    for (const kind of MODES) {
      expect(plan(room([], { kind, params: {} }))).toEqual({});
      const idle = plan(room([client(0, { kind: "host", plays: false }), client(1, { kind: "viewer", plays: false })], { kind, params: {} }));
      expect(Object.values(idle)).toEqual([null, null]);
      const noTrack = room([client(1), client(2)], { kind, params: {} });
      noTrack.track = null;
      for (const v of Object.values(plan(noTrack))) expect(audible(v!)).toEqual(["mix"]);
    }
  });
});
