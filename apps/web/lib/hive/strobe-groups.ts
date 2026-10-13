/**
 * What the Strobe "Groups" row offers. The planner never runs more groups than there are phones in
 * the room (`arrangeStrobe`): a group with nobody in it would be silence on its beats. The row
 * follows it — it offers what can actually happen and highlights what is actually happening — while
 * the host's *requested* count stays in `room.mode.params` untouched, so the room grows back into it
 * as phones arrive. Pure, unit-tested (strobe-groups.test.ts).
 */
import { arrangeStrobe, resolveModeParams, type RoomState } from "@hive/protocol";

export const GROUP_CHOICES = [2, 3, 4, 5, 6, 8] as const;

export interface StrobeGroupsRow {
  /** Counts to offer, ascending. Empty = do not draw the row (one phone cannot trade off with itself). */
  choices: number[];
  /** The count in rotation right now: min(requested, connected speakers). */
  effective: number;
}

export function strobeGroupsRow(room: RoomState): StrobeGroupsRow {
  const connected = Object.values(room.clients).filter((c) => c.plays && c.connected).length;
  const effective = arrangeStrobe(room, resolveModeParams(room.mode).groups).groups;
  if (connected < 2) return { choices: [], effective };
  const choices = GROUP_CHOICES.filter((g) => g <= connected) as number[];
  // 7 phones with 8 requested run as 7 groups: show that as the highlighted chip rather than none.
  if (effective >= 2 && !choices.includes(effective)) choices.push(effective);
  return { choices: choices.sort((a, b) => a - b), effective };
}
