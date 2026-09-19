"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AudioState, HealthSnapshot, RoomState } from "@hive/protocol";
import type { ClientRecord, ConnectionState, HiveClient, HiveClientOptions } from "@hive/sync-client";
import { apiUrl, createClient, wsUrl } from "./client";

export interface UseHiveClientOptions {
  roomCode: string;
  kind: "host" | "player";
  plays: boolean;
  hostKey?: string;
  name?: string;
  /** Connect immediately on mount. Player Join defers this until the tap unlocks audio. */
  autoConnect?: boolean;
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
  /** Call inside a user gesture (tap), then connect(). Safe to call multiple times. */
  connect: () => Promise<void>;
}

/** The one hook every page uses: one HiveClient per page, subscribed to every event, re-rendered from the latest snapshot. */
export function useHiveClient(opts: UseHiveClientOptions): UseHiveClientResult {
  const clientOpts: HiveClientOptions = useMemo(
    () => ({
      wsUrl: wsUrl(),
      apiUrl: apiUrl(),
      roomCode: opts.roomCode,
      kind: opts.kind,
      plays: opts.plays,
      hostKey: opts.hostKey,
      name: opts.name,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opts.roomCode, opts.kind, opts.hostKey],
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
    connect: () => {
      everConnectedRef.current = true;
      return client.connect();
    },
  };
}
