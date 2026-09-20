import { PROTOCOL_VERSION } from "@hive/protocol";
import type { DeviceInfo, HiveClient } from "@hive/sync-client";

export interface DiagReport {
  device: string;
  browserFamily: string;
  ctxState: string | null;
  sampleRate: number | null;
  outputLatencyMs: number | null;
  clockOffsetMs: number | null;
  rttMs: number | null;
  syncErrMs: number | null;
  audioSessionType: string;
  wakeLock: string;
  unlockState: string;
  protocolVersion: number;
}

/**
 * A compact JSON snapshot a human can copy off a phone and paste to whoever is debugging it.
 * ctxState/sampleRate are not yet on the public HiveAudio interface (see PROTOCOL-REQUESTS R-7),
 * so they ship as null until that lands.
 */
export function buildDiagReport(
  client: HiveClient,
  device: DeviceInfo,
  wakeLockState: string,
  audioSessionType: string,
): DiagReport {
  return {
    device: device.model ?? device.platform,
    browserFamily: device.browserFamily,
    ctxState: null,
    sampleRate: null,
    outputLatencyMs: client.status.outputLatencyMs,
    clockOffsetMs: client.status.clockOffsetMs,
    rttMs: client.status.rttMs,
    syncErrMs: client.status.syncErrMs,
    audioSessionType,
    wakeLock: wakeLockState,
    unlockState: client.audio.state,
    protocolVersion: PROTOCOL_VERSION,
  };
}
