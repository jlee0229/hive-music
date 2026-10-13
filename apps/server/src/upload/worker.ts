// Worker entry for one upload (see process.ts). Spawned per upload by route.ts and terminated when
// it answers, which also returns its whole heap — the Float32 copy of the song, several times the
// size of the file — to the system at once instead of leaving it to the main heap's collector.
import { processUpload, type UploadJob, type UploadOutcome } from "./process";

declare const self: Worker;

self.onmessage = async (event: MessageEvent<UploadJob>) => {
  let outcome: UploadOutcome;
  try {
    outcome = await processUpload(event.data);
  } catch (e) {
    outcome = { ok: false, status: 507, error: "the song could not be saved — try again", log: `worker failed: ${e instanceof Error ? e.message : e}` };
  }
  self.postMessage(outcome);
};
