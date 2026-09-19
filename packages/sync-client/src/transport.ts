/**
 * Shared plumbing for both clients: the event emitter, the persisted client id, and the room socket
 * with its JOIN / reconnect lifecycle. `createStubClient` and `createHiveClient` differ only in what
 * they do with audio, so everything up to the message handler lives here and has exactly one
 * implementation to get wrong.
 */
import { PROTOCOL_VERSION, parseServerMessage, type ClientMessage, type ServerMessage } from "@hive/protocol";
import { detectDevice, type ConnectionState, type HiveClientOptions, type HiveEvents } from "./index";

export class Emitter {
  private handlers = new Map<string, Set<(...a: never[]) => void>>();
  on<K extends keyof HiveEvents>(event: K, handler: HiveEvents[K]): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler as (...a: never[]) => void);
    return () => this.off(event, handler);
  }
  off<K extends keyof HiveEvents>(event: K, handler: HiveEvents[K]): void {
    this.handlers.get(event)?.delete(handler as (...a: never[]) => void);
  }
  emit<K extends keyof HiveEvents>(event: K, ...args: Parameters<HiveEvents[K]>): void {
    for (const h of this.handlers.get(event) ?? []) (h as unknown as (...a: Parameters<HiveEvents[K]>) => void)(...args);
  }
}

/** One id per room, kept in localStorage: it is what makes a reconnect restore the same slot. */
export function persistedClientId(roomCode: string): string {
  const key = `hive:clientId:${roomCode}`;
  const fresh = () => globalThis.crypto?.randomUUID?.() ?? `c-${Math.random().toString(36).slice(2, 14)}`;
  try {
    const existing = globalThis.localStorage?.getItem(key);
    if (existing) return existing;
    const id = fresh();
    globalThis.localStorage?.setItem(key, id);
    return id;
  } catch {
    return fresh(); // private mode, or no DOM at all (tests)
  }
}

/** Reconnect backoff: 300, 600, 1200, 2400, 4800 ms then flat (docs/03-sync-engine.md). */
export const reconnectDelayMs = (attempt: number): number => Math.min(5000, 300 * 2 ** Math.min(attempt, 4));

export interface TransportHooks {
  /** Called with the arrival stamp of every server message, before it is dispatched. */
  onMessage?(msg: ServerMessage, receivedAtLocal: number): void;
  onWelcome(msg: Extract<ServerMessage, { type: "WELCOME" }>): void;
  onConnection(state: ConnectionState): void;
  /** A reconnect is about to re-JOIN; the clock keeps its offset but restarts the burst. */
  onReconnect?(): void;
}

/**
 * The room socket. Owns exactly one concern: keeping a JOINed connection alive and handing parsed
 * messages upward. It never touches audio or the clock.
 */
export class RoomTransport {
  connection: ConnectionState = "closed";
  private ws: WebSocket | null = null;
  private attempt = 0;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly opts: HiveClientOptions,
    readonly clientId: string,
    private readonly hooks: TransportHooks,
    private readonly localNow: () => number,
  ) {}

  get isOpen(): boolean {
    return this.ws?.readyState === 1;
  }

  send(msg: ClientMessage): void {
    if (this.isOpen) this.ws!.send(JSON.stringify(msg));
  }

  connect(): Promise<void> {
    this.closedByUser = false;
    return this.open();
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.setConnection("closed");
  }

  /** `ERROR KICKED`: stop trying to come back. */
  stopReconnecting(): void {
    this.closedByUser = true;
  }

  private setConnection(next: ConnectionState): void {
    if (this.connection === next) return;
    this.connection = next;
    this.hooks.onConnection(next);
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.setConnection(this.attempt === 0 ? "connecting" : "reconnecting");
      const sock = new WebSocket(this.opts.wsUrl);
      this.ws = sock;
      let welcomed = false;

      sock.onopen = () => {
        this.send({
          type: "JOIN",
          clientId: this.clientId,
          roomCode: this.opts.roomCode,
          kind: this.opts.kind,
          // A player is always a speaker; only a host chooses.
          plays: this.opts.kind === "player" ? true : this.opts.plays,
          hostKey: this.opts.hostKey,
          name: this.opts.name,
          device: detectDevice(),
          protocolVersion: PROTOCOL_VERSION,
        });
      };

      sock.onmessage = (e) => {
        const at = this.localNow();
        const msg = parseServerMessage(String(e.data));
        if (!msg) return;
        if (msg.type === "WELCOME") {
          welcomed = true;
          this.attempt = 0;
          this.setConnection("open");
          this.hooks.onWelcome(msg);
          this.hooks.onMessage?.(msg, at);
          resolve();
          return;
        }
        if (msg.type === "ERROR" && !welcomed) {
          this.hooks.onMessage?.(msg, at);
          reject(new Error(`${msg.code}: ${msg.message}`));
          return;
        }
        this.hooks.onMessage?.(msg, at);
      };

      sock.onclose = () => {
        if (this.ws !== sock) return; // a newer socket already replaced this one
        if (this.closedByUser) return this.setConnection("closed");
        this.attempt++;
        this.setConnection("reconnecting");
        this.hooks.onReconnect?.();
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.open().catch(() => {
            /* onclose fires again and schedules the next attempt */
          });
        }, reconnectDelayMs(this.attempt));
      };

      sock.onerror = () => {
        /* onclose always follows; the backoff lives there */
      };
    });
  }
}
