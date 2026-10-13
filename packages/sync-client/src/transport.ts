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
  /**
   * One listener throwing must not stop the others — or the caller. `state` is emitted from inside the
   * socket's message handler *before* the audio engine is handed the snapshot, so an exception in any
   * UI listener used to mean the phone silently never applied that ROOM_STATE.
   */
  emit<K extends keyof HiveEvents>(event: K, ...args: Parameters<HiveEvents[K]>): void {
    for (const h of [...(this.handlers.get(event) ?? [])]) {
      try {
        (h as unknown as (...a: Parameters<HiveEvents[K]>) => void)(...args);
      } catch (err) {
        console.error(`[hive] a "${event}" listener threw`, err);
      }
    }
  }
}

/**
 * One id per room *and role*, kept in localStorage: it is what makes a reconnect restore the same slot.
 *
 * Per role because every tab of one browser shares localStorage. With a single key, opening the join
 * page on the phone that is hosting took over the host's own slot, and an id first used by `/screen`
 * came back as a silent viewer when the same browser later joined as a player (SG-03). Players keep
 * the original key — nothing to migrate, and it is the one existing sessions and tests read.
 */
export function persistedClientId(roomCode: string, kind: HiveClientOptions["kind"] = "player"): string {
  const key = `hive:clientId:${roomCode}${kind === "host" ? ":host" : kind === "viewer" ? ":screen" : ""}`;
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

/** Reconnect backoff, nominal: 300, 600, 1200, 2400, 4800 ms then flat, for attempt 0, 1, 2… (docs/03-sync-engine.md). */
export const reconnectDelayMs = (attempt: number): number => Math.min(5000, 300 * 2 ** Math.min(attempt, 4));

/** How far a reconnect delay is spread around its nominal value: ±25 %. */
export const RECONNECT_JITTER = 0.25;

/**
 * The delay the transport actually waits before reconnect number `attempt` (0 = the first).
 *
 * Jittered, because the one event that disconnects a phone usually disconnects all of them: after a
 * server restart every phone used to re-JOIN on the same millisecond at each step — N JOINs and N
 * snapshot fan-outs in one tick, in waves (measured by scale-net: 58 connects/s from 100 phones).
 */
export const jitteredReconnectDelayMs = (attempt: number, random: () => number = Math.random): number =>
  reconnectDelayMs(attempt) * (1 - RECONNECT_JITTER + 2 * RECONNECT_JITTER * random());

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
  /** The in-flight connect, so a second call joins it instead of opening a second socket. */
  private connecting: Promise<void> | null = null;
  /**
   * What a host's JOIN says about "this phone plays too": the *current* choice, not the option the
   * client was created with. The server takes a host's `plays` from every JOIN, so re-JOINing with the
   * creation-time value (false) switched the host's own speaker off on every reconnect while the page's
   * toggle stayed ticked (HOST-06).
   */
  private plays: boolean;

  constructor(
    private readonly opts: HiveClientOptions,
    readonly clientId: string,
    private readonly hooks: TransportHooks,
    private readonly localNow: () => number,
  ) {
    this.plays = opts.plays;
  }

  /** Records a SET_PLAYS so the next re-JOIN repeats it. */
  setPlays(plays: boolean): void {
    this.plays = plays;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === 1;
  }

  send(msg: ClientMessage): void {
    if (this.isOpen) this.ws!.send(JSON.stringify(msg));
  }

  /**
   * Idempotent (P0-4). The player UI calls this again from "Tap to resume" after every iOS
   * interrupted/suspended, and without a guard each tap opened another socket: the orphan's later close
   * reaches the server, which demotes the *live* connection's record. One socket per transport.
   */
  connect(): Promise<void> {
    this.closedByUser = false;
    /*
     * Cancel a reconnect that is already scheduled. Without this, a "Tap to resume" during the backoff
     * left the timer armed: it fired a few hundred ms later, replaced the socket that had just JOINed,
     * and the server saw a close for a client it had just re-registered — the overlap that the mock's
     * close handler used to resolve by demoting the live connection. One socket per transport means one
     * *pending* connect too.
     */
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const state = this.ws?.readyState;
    if (state === WebSocket.OPEN) return Promise.resolve();
    if (state === WebSocket.CONNECTING && this.connecting) return this.connecting;
    const pending = this.open();
    this.connecting = pending;
    void pending.catch(() => {}).then(() => {
      if (this.connecting === pending) this.connecting = null;
    });
    return pending;
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
      /*
       * Replace, do not abandon. An abandoned socket stays open until the browser collects it, and its
       * eventual close is indistinguishable, server-side, from the live client leaving. Detaching the
       * handlers first means our own reconnect logic ignores this close (it is intentional), so closing
       * it cannot start a reconnect storm.
       */
      const previous = this.ws;
      if (previous) {
        this.ws = null;
        previous.onclose = null;
        previous.onmessage = null;
        previous.onerror = null;
        try {
          previous.close(1000, "replaced");
        } catch {
          /* already closing */
        }
      }
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
          plays: this.opts.kind === "player" ? true : this.plays,
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
        /*
         * A socket that dies before WELCOME settles its connect() — as a rejection. It used to leave the
         * promise pending forever: the player page awaits connect() inside its Join handler, so a server
         * that was unreachable at the moment of the tap left that handler (and its "joining" state)
         * hanging even after a later automatic reconnect had succeeded. Reconnecting carries on below
         * regardless; this only tells the caller that *this* attempt is over.
         */
        if (!welcomed) reject(new Error("connection closed before WELCOME"));
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
          // `attempt` was just incremented: the first retry is attempt 0 — 300 ms, as documented. It used
          // to be passed as-is, which made the real sequence 600, 1200, 2400, 4800, 5000.
        }, jitteredReconnectDelayMs(this.attempt - 1));
      };

      sock.onerror = () => {
        /* onclose always follows; the backoff lives there */
      };
    });
  }
}
