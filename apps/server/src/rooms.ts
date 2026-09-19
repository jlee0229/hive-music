/**
 * The room registry: in-memory, no database. One process owns every room (the demo runs on one
 * always-on Fly machine), so `ROOM_FIXED_CODE` makes `POST /rooms` idempotent and the demo QR code
 * survives a restart — the room comes back empty but the link still works.
 */
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, ROOM_IDLE_TTL_MS } from "@hive/protocol";
import { serverNow } from "./clock";
import { Room } from "./room";

const randomCode = (): string => {
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH));
  for (const b of bytes) out += ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length];
  return out;
};

const randomKey = (): string => crypto.randomUUID().replace(/-/g, "");

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  constructor(
    /** Returns the publish function for a room topic (Bun's `server.publish(code, …)`). */
    private readonly broadcastFor: (code: string) => (payload: string) => void,
    private readonly opts: { fixedCode?: string | null; fixedHostKey?: string | null } = {},
  ) {}

  /**
   * `POST /rooms`. With ROOM_FIXED_CODE set (or an explicit code that already exists) this is
   * idempotent: the same code and the same hostKey come back, so a reloaded host stays the host.
   */
  create(requested?: string): Room {
    const code = (requested ?? this.opts.fixedCode ?? randomCode()).toUpperCase();
    const existing = this.rooms.get(code);
    if (existing) {
      existing.touch();
      return existing;
    }
    const isFixed = this.opts.fixedCode != null && code === this.opts.fixedCode.toUpperCase();
    const hostKey = (isFixed ? this.opts.fixedHostKey : null) ?? randomKey();
    const room = new Room(code, hostKey, this.broadcastFor(code));
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  all(): Room[] {
    return [...this.rooms.values()];
  }

  /** Drops stale client records everywhere and empty rooms that have been quiet for ROOM_IDLE_TTL_MS. */
  reap(now = serverNow()): void {
    for (const room of this.rooms.values()) {
      room.purgeDisconnected(now);
      const idle = now - room.lastActivityServerTime > ROOM_IDLE_TTL_MS;
      const isFixed = this.opts.fixedCode != null && room.code === this.opts.fixedCode.toUpperCase();
      if (idle && room.connectedCount() === 0 && !isFixed) {
        room.dispose();
        this.rooms.delete(room.code);
      }
    }
  }

  disposeAll(): void {
    for (const room of this.rooms.values()) room.dispose();
    this.rooms.clear();
  }
}
