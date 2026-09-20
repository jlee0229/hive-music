import { createHiveClient, createStubClient, type HiveClient, type HiveClientOptions } from "@hive/sync-client";

export type EngineKind = "stub" | "real";

/** NEXT_PUBLIC_HIVE_ENGINE=real switches every page to the backend engine; default is the audio-less stub. */
export function engineKind(): EngineKind {
  return process.env.NEXT_PUBLIC_HIVE_ENGINE === "real" ? "real" : "stub";
}

export function wsUrl(): string {
  return process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080/ws";
}

export function apiUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
}

/** Picks createStubClient or createHiveClient by NEXT_PUBLIC_HIVE_ENGINE. */
export function createClient(opts: HiveClientOptions): HiveClient {
  return engineKind() === "real" ? createHiveClient(opts) : createStubClient(opts);
}
