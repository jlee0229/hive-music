"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AudioState, HealthSnapshot, RoomState } from "@hive/protocol";
import type { ClientRecord, ConnectionState, HiveClient, HiveClientOptions } from "@hive/sync-client";
import { apiUrl, createClient, wsUrl } from "./client";
import { guardProtocolVersion } from "./protocolVersionGuard";

export interface UseHiveClientOptions {
  roomCode: string;
  kind: "host" | "player";
  plays: boolean;
  hostKey?: string;
  name?: string;
  /** Connect immediately on mount. Player Join defers this until the tap unlocks audio. */
  autoConnect?: boolean;
  /** Overrides the per-room persisted clientId. See app/h/[code]/page.tsx's demotion recovery for why. */
  clientId?: string;
  /** Hosts only: this browser's library key (lib/hive/storage.ts getLibraryKey), sent inside the host's JOIN. */
  libraryKey?: string;
}

export interface UseHiveClientResult {
  client: HiveClient;
  room: RoomState | null;
  me: ClientRecord | null;
  connection: ConnectionState;
  status: HiveClient["status"];
  audio: { state: AudioState; loadProgress: number; muted: boolean };
  health: Record<string, HealthSnapshot>;
  healthServerTime: number | null;
  /** True once a one-shot reload has already failed to clear a PROTOCOL_VERSION mismatch. */
  protocolMismatch: boolean;
  /** Call inside a user gesture (tap), then connect(). Safe to call multiple times. */
  connect: () => Promise<void>;
}

/** The one hook every page uses: one HiveClient per page, subscribed to every event, re-rendered from the latest snapshot. */
export function useHiveClient(opts: UseHiveClientOptions): UseHiveClientResult {
  // `libraryKey` is an engine option that arrives with the owned-uploads work (HiveClientOptions
  // gains it and the transport puts it in a host's JOIN). The intersection type keeps this file
  // compiling on either side of that merge; an engine without the option ignores the extra field.
  const clientOpts: HiveClientOptions & { libraryKey?: string } = useMemo(
    () => ({
      wsUrl: wsUrl(),
      apiUrl: apiUrl(),
      roomCode: opts.roomCode,
      kind: opts.kind,
      plays: opts.plays,
      hostKey: opts.hostKey,
      name: opts.name,
      clientId: opts.clientId,
      libraryKey: opts.kind === "host" ? opts.libraryKey : undefined,
    }),
    [opts.roomCode, opts.kind, opts.plays, opts.hostKey, opts.name, opts.clientId, opts.libraryKey],
  );

  const clientRef = useRef<HiveClient | null>(null);
  const optsRef = useRef<HiveClientOptions | null>(null);
  const everConnectedRef = useRef(false);
  if (!clientRef.current) {
    clientRef.current = createClient(clientOpts);
    optsRef.current = clientOpts;
  } else if (!everConnectedRef.current && (optsRef.current?.name !== clientOpts.name || optsRef.current?.hostKey !== clientOpts.hostKey)) {
    // Pre-connect only: the player's name can still change while typing, and the host's key
    // arrives asynchronously from POST /rooms after the first render.
    clientRef.current = createClient(clientOpts);
    optsRef.current = clientOpts;
  }
  const client = clientRef.current;

  const [room, setRoom] = useState<RoomState | null>(client.room);
  const [me, setMe] = useState<ClientRecord | null>(client.me);
  const [connection, setConnection] = useState<ConnectionState>(client.connection);
  const [status, setStatus] = useState(client.status);
  const [audioState, setAudioState] = useState<AudioState>(client.audio.state);
  const [loadProgress, setLoadProgress] = useState(client.audio.loadProgress);
  const [muted, setMuted] = useState(client.audio.muted);
  const [health, setHealth] = useState<Record<string, HealthSnapshot>>({});
  const [healthServerTime, setHealthServerTime] = useState<number | null>(null);
  const [protocolMismatch, setProtocolMismatch] = useState(false);

  useEffect(() => {
    guardProtocolVersion(clientOpts.apiUrl).then((result) => {
      if (result === "banner") setProtocolMismatch(true);
    });
    // Runs once per mount, independent of the client/connect lifecycle below: a mismatch that
    // survives the one-shot reload should show the banner even if connect() never resolves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const offState = client.on("state", (r) => {
      setRoom(r);
      setMe(client.me);
    });
    const offStatus = client.on("status", setStatus);
    const offConnection = client.on("connection", setConnection);
    const offAudio = client.on("audio", (s, p) => {
      setAudioState(s);
      setLoadProgress(p);
      setMuted(client.audio.muted);
    });
    const offHealth = client.on("health", (clients, serverTime) => {
      setHealth(clients);
      setHealthServerTime(serverTime);
    });
    if (opts.autoConnect) {
      everConnectedRef.current = true;
      client.connect().catch(() => {});
    }
    return () => {
      offState();
      offStatus();
      offConnection();
      offAudio();
      offHealth();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  return {
    client,
    room,
    me,
    connection,
    status,
    audio: { state: audioState, loadProgress, muted },
    health,
    healthServerTime,
    protocolMismatch,
    connect: () => {
      everConnectedRef.current = true;
      return client.connect();
    },
  };
}
