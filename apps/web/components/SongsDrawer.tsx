"use client";

import { useRef, useState } from "react";
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
  const [query, setQuery] = useState("");
  const shown = query.trim() ? tracks.filter((t) => t.title.toLowerCase().includes(query.trim().toLowerCase())) : tracks;

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "var(--stage)" }}>
      {/* min-h-0 down the flex chain: without it the track list refuses to shrink, so it can't
          scroll and shoves the upload/back buttons off-screen once the library grows. */}
      <div className="mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col gap-4" style={{ padding: safeAreaPadding(52, 20, 28) }}>
        <div className="flex shrink-0 items-center justify-between">
          <span className="font-display text-xl font-bold">Songs</span>
          <span className="text-[13px]" style={{ color: "var(--muted)" }}>
            picking one pauses the show
          </span>
        </div>
        <label className="flex h-11 shrink-0 items-center gap-2.5 rounded-2xl border px-3.5" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the library"
            aria-label="Search the library"
            className="grow bg-transparent text-[15px] outline-none"
            style={{ color: "var(--text)" }}
          />
        </label>
        <div className="flex min-h-0 grow flex-col gap-2 overflow-y-auto">
          {shown.map((t) => (
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
          className="flex shrink-0 items-center justify-center gap-2 rounded-2xl border border-dashed px-3.5 py-3 text-[15px] font-semibold disabled:opacity-60"
          style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--muted)" }}
        >
          {uploadPhase === "analyzing" ? "Analyzing…" : uploadPhase === "uploading" ? "Uploading…" : "+ Upload a song"}
        </button>
        {uploadError ? (
          <p className="shrink-0 text-center text-sm" style={{ color: "var(--health-bad)" }}>
            {uploadError}
          </p>
        ) : null}
        <button
          onClick={onClose}
          className="flex h-13 shrink-0 items-center justify-center rounded-2xl border font-semibold"
          style={{ height: 52, background: "var(--surface)", borderColor: "var(--border)" }}
        >
          Back to the stage
        </button>
      </div>
    </div>
  );
}
