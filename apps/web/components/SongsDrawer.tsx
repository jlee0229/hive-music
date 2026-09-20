"use client";

import { useRef } from "react";
import type { TrackLibraryEntry } from "@hive/protocol";
import { safeAreaPadding } from "@/lib/hive/safe-area";

/**
 * The stage's song panel: the same library + upload the lobby has, reachable mid-show. Picking a
 * track sends SET_TRACK, which stops the transport server-side — the host lands back in the lobby
 * with the new song selected and presses Start (that gesture also re-arms the automatic tuning).
 */
export function SongsDrawer({
  tracks,
  currentTrackId,
  uploadPhase,
  uploadError,
  onSelect,
  onUpload,
  onClose,
}: {
  tracks: TrackLibraryEntry[];
  currentTrackId: string | null;
  uploadPhase: "analyzing" | "uploading" | null;
  uploadError: string | null;
  onSelect: (trackId: string) => void;
  onUpload: (file: File) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "var(--stage)" }}>
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4" style={{ padding: safeAreaPadding(52, 20, 28) }}>
        <div className="flex items-center justify-between">
          <span className="font-display text-xl font-bold">Songs</span>
          <span className="text-[13px]" style={{ color: "var(--muted)" }}>
            picking one pauses the show
          </span>
        </div>
        <div className="flex flex-col gap-2 overflow-y-auto">
          {tracks.map((t) => (
            <button
              key={t.id}
              onClick={() => onSelect(t.id)}
              className="flex items-center gap-3 rounded-2xl border px-3.5 py-3 text-left"
              style={{ background: "var(--surface)", borderColor: t.id === currentTrackId ? "var(--primary-fill)" : "var(--border)" }}
            >
              <span className="flex grow flex-col gap-0.5">
                <span className="text-[15px] font-semibold">{t.title}</span>
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  {t.stems.length} parts · {Math.round(t.durationSec)}s{t.id === currentTrackId ? " · now playing" : ""}
                </span>
              </span>
            </button>
          ))}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="audio/*,.mp3,.m4a,.aac,.wav,.flac,.ogg"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUpload(f);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => inputRef.current?.click()}
          disabled={uploadPhase !== null}
          className="flex items-center justify-center gap-2 rounded-2xl border border-dashed px-3.5 py-3 text-[15px] font-semibold disabled:opacity-60"
          style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--muted)" }}
        >
          {uploadPhase === "analyzing" ? "Analyzing…" : uploadPhase === "uploading" ? "Uploading…" : "+ Upload a song"}
        </button>
        {uploadError ? (
          <p className="text-center text-sm" style={{ color: "var(--health-bad)" }}>
            {uploadError}
          </p>
        ) : null}
        <div className="grow" />
        <button
          onClick={onClose}
          className="flex h-13 items-center justify-center rounded-2xl border font-semibold"
          style={{ height: 52, background: "var(--surface)", borderColor: "var(--border)" }}
        >
          Back to the stage
        </button>
      </div>
    </div>
  );
}
