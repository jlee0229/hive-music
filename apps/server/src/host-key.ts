// Host keys are signed, not just random: `<issuedAt>.<nonce>.<hmac>` where the HMAC covers the room
// code. That is what lets the server tell "the key this server issued for room BZQ7" from "a string
// somebody made up" *without any stored state* — rooms live in memory, so after a deploy/restart (or
// the idle timeout) the room is gone, and the only proof of who hosted it is the key in the host's
// localStorage. A verified key may re-create its own room; nothing else can (audit SG-01).
//
// The format stays opaque to clients and under JOIN's `hostKey: z.string().max(64)`: 9 + 1 + 12 + 1 + 32 = 55.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** How long after it was issued a key may bring a vanished room back. A party is hours, not days;
 *  past this a 4-char code may have been dealt to someone else and the old key must not squat it. */
export const HOST_KEY_RESTORE_TTL_MS = 24 * 60 * 60 * 1000;

const NONCE_BYTES = 9; // 12 base64url chars
const SIG_CHARS = 32; // 192 bits of the HMAC-SHA256

/** Constant-time string equality (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class HostKeys {
  private secret: Buffer;

  /** No secret → a random one: keys still work for the life of the process, but none survives a restart. */
  constructor(secret?: string | Uint8Array) {
    this.secret = secret && secret.length >= 16 ? Buffer.from(secret) : randomBytes(32);
  }

  private sign(code: string, issuedAt: string, nonce: string): string {
    return createHmac("sha256", this.secret).update(`hive-host-key:v1|${code.toUpperCase()}|${issuedAt}|${nonce}`).digest("base64url").slice(0, SIG_CHARS);
  }

  issue(code: string, nowMs: number): string {
    const issuedAt = Math.floor(nowMs).toString(36);
    const nonce = randomBytes(NONCE_BYTES).toString("base64url");
    return `${issuedAt}.${nonce}.${this.sign(code, issuedAt, nonce)}`;
  }

  /** True only for a key this server (this secret) issued for exactly this code, inside the restore window. */
  verify(code: string, key: string, nowMs: number): boolean {
    if (typeof key !== "string" || key.length > 64) return false;
    const parts = key.split(".");
    if (parts.length !== 3) return false;
    const [issuedAt, nonce, sig] = parts as [string, string, string];
    if (!/^[0-9a-z]{1,11}$/.test(issuedAt) || nonce.length === 0 || sig.length !== SIG_CHARS) return false;
    if (!safeEqual(sig, this.sign(code, issuedAt, nonce))) return false;
    const age = nowMs - parseInt(issuedAt, 36);
    // A little tolerance for a clock stepped backwards across a restart; never a key "from the future".
    return age >= -60_000 && age <= HOST_KEY_RESTORE_TTL_MS;
  }
}
