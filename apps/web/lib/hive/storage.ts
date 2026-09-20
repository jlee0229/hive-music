/** localStorage helpers. All reads/writes are guarded: SSR and private-browsing both throw or return null. */

function get(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function set(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* private browsing / SSR: ignore */
  }
}

export function getPlayerName(): string {
  return get("hive:name") ?? "";
}

export function setPlayerName(name: string): void {
  set("hive:name", name);
}

export function getHostKey(roomCode: string): string | null {
  return get(`hive:hostKey:${roomCode}`);
}

export function setHostKey(roomCode: string, hostKey: string): void {
  set(`hive:hostKey:${roomCode}`, hostKey);
}
