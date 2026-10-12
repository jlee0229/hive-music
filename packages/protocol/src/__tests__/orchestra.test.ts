/**
 * PROTO-05 · ORCHESTRA must keep the whole song in the room.
 * Before: one stem per phone by `joinIndex % stems` — two phones on a four-stem track played two stems and
 * the other two were simply gone; a phone that dropped off the Wi-Fi took its instrument with it.
 */
import { describe, expect, test } from "bun:test";
import { STEMS, type Role } from "../constants";
import { arrangeOrchestra, plan } from "../planner";
import type { ClientRecord, RoomState, StemRole } from "../room";
import { prng } from "./harness";
import { audible, client, heard, room } from "./room-fixture";

const ORCH: RoomState["mode"] = { kind: "ORCHESTRA", params: {} };
const ALL = [...STEMS].sort();
const host = client(0, { kind: "host", plays: false });

describe("ORCHESTRA with fewer phones than stems folds the missing instruments (PROTO-05)", () => {
  test("one phone plays everything", () => {
    const a = plan(room([host, client(1)], ORCH));
    expect(audible(a["c1-00000000"]!)).toEqual(ALL);
    expect(a["c1-00000000"]!.label).toBe("unison");
    expect(a["c1-00000000"]!.role).toBe("unison");
  });

  test("two phones: rhythm section on one, melody on the other", () => {
    const a = plan(room([host, client(1), client(2)], ORCH));
    expect(audible(a["c1-00000000"]!)).toEqual(["other", "vocals"]);
    expect(audible(a["c2-00000000"]!)).toEqual(["bass", "drums"]);
    expect(a["c1-00000000"]!.label).toBe("vocals + other");
    expect(a["c2-00000000"]!.label).toBe("drums + bass");
    expect(heard(a)).toEqual(ALL);
  });

  test("three phones: drums+bass, vocals, other", () => {
    const a = plan(room([host, client(1), client(2), client(3)], ORCH));
    expect([1, 2, 3].map((i) => audible(a[`c${i}-00000000`]!).join("+")).sort()).toEqual(["bass+drums", "other", "vocals"]);
    expect(heard(a)).toEqual(ALL);
  });

  test("four phones: one instrument each, exactly as before", () => {
    const a = plan(room([host, client(1), client(2), client(3), client(4)], ORCH));
    expect([1, 2, 3, 4].map((i) => audible(a[`c${i}-00000000`]!)).every((s) => s.length === 1)).toBe(true);
    expect(heard(a)).toEqual(ALL);
    for (const i of [1, 2, 3, 4]) expect(a[`c${i}-00000000`]!.label).toBe(audible(a[`c${i}-00000000`]!)[0]!);
  });

  test("a phone that drops off the network has its instrument carried by its partner until it is back", () => {
    const four = [client(1), client(2), client(3), client(4)];
    const full = plan(room([host, ...four], ORCH));
    const drummer = four.find((c) => full[c.id]!.label === "drums")!;
    const bassist = four.find((c) => full[c.id]!.label === "bass")!;
    const gone = plan(room([host, ...four.map((c) => (c.id === drummer.id ? { ...c, connected: false } : c))], ORCH));
    const stillThere = four.filter((c) => c.id !== drummer.id).map((c) => c.id);
    expect(heard(gone, stillThere)).toEqual(ALL);
    expect(audible(gone[bassist.id]!)).toEqual(["bass", "drums"]);
    expect(gone[drummer.id]!.label).toBe("drums"); // its own seat is unchanged: it resumes as the drummer
    for (const c of four) if (c.id !== bassist.id) expect(gone[c.id]).toEqual(full[c.id]!);
  });

  test("pins win, are never folded onto, and the unpinned phones cover the rest", () => {
    const a = plan(room([host, client(1, { pinnedRole: "vocals" }), client(2)], ORCH));
    expect(audible(a["c1-00000000"]!)).toEqual(["vocals"]);
    expect(audible(a["c2-00000000"]!)).toEqual(["bass", "drums", "other"]);
    // every phone pinned: the host has decided what the room hears, nothing is folded
    const pinned = plan(room([client(1, { pinnedRole: "vocals" }), client(2, { pinnedRole: "vocals" })], ORCH));
    expect(heard(pinned)).toEqual(["vocals"]);
    // a pin to a stem the track does not have is ignored
    const twoStem = plan(room([client(1, { pinnedRole: "vocals" })], ORCH, ["drums", "bass"]));
    expect(audible(twoStem["c1-00000000"]!)).toEqual(["bass", "drums"]);
  });

  test("N > stems doubles instruments evenly; a joiner never changes who anyone is", () => {
    for (let n = 4; n <= 60; n++) {
      const phones = Array.from({ length: n }, (_, i) => client(i + 1));
      const a = plan(room([host, ...phones], ORCH));
      const tally: Record<string, number> = {};
      for (const c of phones) {
        expect(audible(a[c.id]!)).toHaveLength(1);
        tally[a[c.id]!.label] = (tally[a[c.id]!.label] ?? 0) + 1;
      }
      const counts = STEMS.map((s) => tally[s] ?? 0);
      expect(Math.max(...counts) - Math.min(...counts), `n=${n}`).toBeLessThanOrEqual(1);
      const grown = plan(room([host, ...phones, client(n + 1)], ORCH));
      for (const c of phones) expect(grown[c.id], `n=${n}`).toEqual(a[c.id]!);
    }
  });

  test("tracks with 2, 3 or 6 stems, including stems that are not one of the four roles, are fully covered", () => {
    for (const stems of [["drums", "bass"], ["drums", "bass", "vocals"], ["drums", "bass", "vocals", "other", "piano", "guitar"], ["mix"]]) {
      for (let n = 1; n <= 8; n++) {
        const a = plan(room([host, ...Array.from({ length: n }, (_, i) => client(i + 1))], ORCH, stems));
        expect(heard(a), `${stems.join(",")} × ${n}`).toEqual([...stems].sort());
        for (const v of Object.values(a)) if (v) expect(v.label.length).toBeLessThanOrEqual(24);
      }
    }
  });
});

describe("ORCHESTRA properties over random rooms (PROTO-05)", () => {
  const r = prng(2024);
  function randomRoom(): { clients: ClientRecord[]; stems: string[] } {
    const stems = r.pick([[...STEMS], ["drums", "bass"], ["drums", "vocals", "other"], ["mix"]]);
    const n = r.int(1, 60);
    const joinIndexes = r.shuffle(Array.from({ length: 200 }, (_, k) => k)).slice(0, n);
    const clients = joinIndexes.map((j) =>
      client(j, {
        kind: r.bool(0.1) ? "host" : "player",
        plays: r.bool(0.9),
        connected: r.bool(0.8),
        pinnedRole: r.bool(0.15) ? (r.pick(STEMS) as StemRole) : null,
      }),
    );
    return { clients, stems };
  }

  test("every stem is audible on a connected phone whenever a connected unpinned speaker exists", () => {
    for (let i = 0; i < 2000; i++) {
      const { clients, stems } = randomRoom();
      const a = plan(room(clients, ORCH, stems));
      const speakers = clients.filter((c) => c.plays);
      const present = speakers.some((c) => c.connected) ? speakers.filter((c) => c.connected) : speakers;
      const isPinned = (c: ClientRecord) => c.pinnedRole !== null && stems.includes(c.pinnedRole);
      if (!present.some((c) => !isPinned(c))) continue;
      expect(heard(a, present.map((c) => c.id)), `case ${i}`).toEqual([...stems].sort());
      for (const c of speakers) {
        // a pinned phone plays its pin and nothing else
        if (isPinned(c)) expect(audible(a[c.id]!)).toEqual([c.pinnedRole!]);
        // a phone that is not there is never handed someone else's stem
        if (!present.includes(c) && stems.length > 1 && stems[0] !== "mix") expect(audible(a[c.id]!).length).toBe(1);
      }
    }
  });

  test("a joiner (higher joinIndex, unpinned) never changes an existing phone's instrument and never adds to its load", () => {
    for (let i = 0; i < 1000; i++) {
      const { clients, stems } = randomRoom();
      const before = arrangeOrchestra(room(clients, ORCH, stems));
      const top = Math.max(...clients.map((c) => c.joinIndex));
      const after = arrangeOrchestra(room([...clients, client(top + r.int(1, 9))], ORCH, stems));
      for (const c of clients) {
        if (!c.plays) continue;
        expect(after.get(c.id)!.primary, `case ${i}`).toBe(before.get(c.id)!.primary);
        for (const s of after.get(c.id)!.stems) expect(before.get(c.id)!.stems, `case ${i}`).toContain(s);
      }
    }
  });

  test("role and colour always follow the phone's own instrument", () => {
    for (let i = 0; i < 300; i++) {
      const { clients, stems } = randomRoom();
      const rm = room(clients, ORCH, stems);
      const seats = arrangeOrchestra(rm);
      const a = plan(rm);
      for (const c of clients.filter((x) => x.plays)) {
        const seat = seats.get(c.id)!;
        const everything = stems.every((s) => seat.stems.includes(s));
        const expected: Role = seat.primary === null || everything ? "unison" : seat.primary;
        expect(a[c.id]!.role).toBe(expected);
      }
    }
  });
});
