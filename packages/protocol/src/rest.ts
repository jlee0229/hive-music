import { z } from "zod";
import { ScenePlanSchema } from "./scene";
import { TrackInfoSchema } from "./room";

/** POST /rooms */
export const CreateRoomRequestSchema = z.object({ code: z.string().min(3).max(8).optional() });
export const CreateRoomResponseSchema = z.object({ code: z.string(), hostKey: z.string(), joinUrl: z.string() });
export type CreateRoomResponse = z.infer<typeof CreateRoomResponseSchema>;

/** GET /rooms/:code */
export const RoomSummarySchema = z.object({ code: z.string(), players: z.number().int(), exists: z.boolean() });

/** GET /tracks?q= — one entry per fixture folder (meta.json + audio urls). */
export const TrackLibraryEntrySchema = TrackInfoSchema.extend({
  /** stem name → absolute or server-relative URL of the 16-bit mono WAV. */
  urls: z.record(z.string(), z.string()),
  /** Per-second loudness 0..1 (fixtures/gen-synthetic.ts writes it; ffmpeg for real tracks). */
  energy: z.array(z.number().min(0).max(1)).optional(),
  clickTimesSec: z.array(z.number()).optional(),
  generated: z.boolean().optional(),
});
export type TrackLibraryEntry = z.infer<typeof TrackLibraryEntrySchema>;
export const TrackLibraryResponseSchema = z.object({ tracks: z.array(TrackLibraryEntrySchema) });

/** POST /rooms/:code/vibe */
export const VibeRequestSchema = z.object({ prompt: z.string().min(1).max(500) });
export const VibeResponseSchema = z.object({ scenePlan: ScenePlanSchema });

/** GET /health */
export const HealthResponseSchema = z.object({ ok: z.literal(true), protocolVersion: z.number().int(), serverTime: z.number() });

export const REST_ROUTES = {
  health: "GET /health",
  createRoom: "POST /rooms",
  room: "GET /rooms/:code",
  tracks: "GET /tracks?q=",
  audio: "GET /audio/:trackId/:stem.wav",
  vibe: "POST /rooms/:code/vibe",
  uploadTrack: "POST /tracks (stretch)",
} as const;
