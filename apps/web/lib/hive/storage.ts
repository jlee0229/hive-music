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

function remove(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
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

/** The room is gone: a key for it can only ever demote this phone if the code is reused. */
export function clearHostKey(roomCode: string): void {
  remove(`hive:hostKey:${roomCode}`);
}

const LIBRARY_KEY = "hive:libraryKey";
/** The key for this page's lifetime when storage would not keep it (private mode, site data blocked). */
let sessionLibraryKey: string | null = null;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * This browser's library key: the secret that says whose uploads are whose (the server keeps only
 * a hash of it and shows a host the shared songs plus their own). 32 random bytes, base64url — 43
 * characters — made the first time this browser hosts and kept in localStorage, so next week's
 * hive from the same phone still has its songs. Where storage is blocked it lasts for the page.
 *
 * It is a bearer secret: it goes to the server inside the host's JOIN and nowhere else. Never put
 * it in a URL, never log it.
 */
export function getLibraryKey(): string {
  const stored = get(LIBRARY_KEY);
  if (stored && /^[A-Za-z0-9_-]{16,64}$/.test(stored)) return stored;
  if (sessionLibraryKey) return sessionLibraryKey;
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  const key = base64url(bytes);
  set(LIBRARY_KEY, key);
  if (get(LIBRARY_KEY) !== key) sessionLibraryKey = key; // not kept: remember it ourselves
  return key;
}
