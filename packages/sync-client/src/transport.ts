/**
 * Shared plumbing for both clients: the event emitter, the persisted client id, and the room socket
 * with its JOIN / reconnect lifecycle. `createStubClient` and `createHiveClient` differ only in what
 * they do with audio, so everything up to the message handler lives here and has exactly one
 * implementation to get wrong.
 */
import { PROTOCOL_VERSION, parseServerMessage, type ClientMessage, type ScenePlan, type ServerMessage } from "@hive/protocol";
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

/**
 * Reconnect backoff, nominal: `min(5000, 300·2^min(attempt, 4))` — 300, 600, 1200, 2400, 4800 ms for
 * attempt 0, 1, 2, 3, 4+. The transport counts its first retry as attempt 1, so what a phone actually
 * waits is 600, 1200, 2400, 4800, 4800… (the "300" in docs/03 is this function's value at 0, which
 * the transport never uses; the host page's own /tracks retry does).
 */
export const reconnectDelayMs = (attempt: number): number => Math.min(5000, 300 * 2 ** Math.min(attempt, 4));

/** How far a reconnect is spread *beyond* its nominal delay: up to +50 %. */
export const RECONNECT_JITTER = 0.5;

/**
 * The delay the transport actually waits before retry number `attempt` (1 = the first).
 *
 * Jittered, because the one event that disconnects a phone usually disconnects all of them: after a
 * server restart every phone used to re-JOIN on the same millisecond at each step — N JOINs and N
 * snapshot fan-outs in one tick, in waves (measured by scale-net: 58 connects/s from 100 phones).
 * Upward only: no phone comes back sooner than it used to, so nothing that relied on the old timing
 * (the reconnect banner being on screen long enough to read) gets a shorter window.
 */
export const jitteredReconnectDelayMs = (attempt: number, random: () => number = Math.random): number =>
  reconnectDelayMs(attempt) * (1 + RECONNECT_JITTER * random());

/**
 * `POST /rooms/:code/vibe`, shared by the real client and the stub.
 *
 * The host key goes in `Authorization: Bearer` (SG-09) so the endpoint can be locked to hosts; the
 * server's CORS policy allows exactly `Content-Type, Authorization`. A refusal is an error the caller
 * sees — with the status, and for 401/403 the reason — never a resolved promise with nothing in it.
 */
export async function postVibe(opts: Pick<HiveClientOptions, "apiUrl" | "roomCode" | "hostKey">, prompt: string): Promise<ScenePlan> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.hostKey) headers.authorization = `Bearer ${opts.hostKey}`;
  const res = await fetch(`${opts.apiUrl}/rooms/${opts.roomCode}/vibe`, { method: "POST", headers, body: JSON.stringify({ prompt }) });
  if (!res.ok) {
    const why =
      res.status === 401 || res.status === 403
        ? opts.hostKey
          ? "the server did not accept this host key"
          : "this client has no host key"
        : "the request was refused";
    throw Object.assign(new Error(`vibe failed: ${res.status} (${why})`), { status: res.status });
  }
  const body = (await res.json()) as { scenePlan?: ScenePlan };
  if (!body.scenePlan) throw Object.assign(new Error("vibe failed: the server returned no scene plan"), { status: res.status });
  return body.scenePlan;
}

/**
 * The library key as JOIN may carry it: hosts only, and only when it has the shape the wire schema
 * accepts (16–64 chars) — a malformed key must cost the host their uploads, not the whole JOIN, which
 * the server would otherwise reject as a bad message.
 */
function libraryKeyForJoin(opts: HiveClientOptions): string | undefined {
  const key = opts.libraryKey;
  return opts.kind === "host" && typeof key === "string" && key.length >= 16 && key.length <= 64 ? key : undefined;
}

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
   * The server answered this socket's JOIN with an ERROR (NO_ROOM, …) and left the socket open: it is
   * connected to nothing. Nothing closes it, so the reconnect loop never runs again — connect() is
   * what a caller that wants another try has to be able to use (PARTY-01).
   */
  private refused = false;
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
    // An open socket whose JOIN was refused is not a connection: open() replaces it and JOINs again.
    if (state === WebSocket.OPEN && !this.refused) return Promise.resolve();
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
      this.refused = false;
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
          ...(libraryKeyForJoin(this.opts) ? { libraryKey: libraryKeyForJoin(this.opts) } : {}),
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
          // The hook first: what WELCOME says (isHost, the protocol version) has to be in place by the
          // time anyone hears that the connection is open.
          this.hooks.onWelcome(msg);
          this.setConnection("open");
          this.hooks.onMessage?.(msg, at);
          resolve();
          return;
        }
        if (msg.type === "ERROR" && !welcomed) {
          // Before the hook: a listener may call connect() from inside it.
          if (this.ws === sock) this.refused = true;
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
        }, jitteredReconnectDelayMs(this.attempt));
      };

      sock.onerror = () => {
        /* onclose always follows; the backoff lives there */
      };
    });
  }
}
