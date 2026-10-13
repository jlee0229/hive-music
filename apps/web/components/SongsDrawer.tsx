"use client";

import { useEffect, useRef, useState } from "react";
import { songSubtitle } from "@/lib/hive/derive";
import type { LibraryTrack } from "@/lib/hive/library";
import { safeAreaPadding } from "@/lib/hive/safe-area";

/**
 * The stage's song panel: the library + upload, reachable mid-show. Picking a different track sends
 * SET_TRACK, which stops the transport server-side — the stage then shows "Up next" and Start for
 * it. Picking the song that is already loaded changes nothing (the page just closes the drawer).
 *
 * A song this browser uploaded (`mine`) carries one small remove control: the first tap turns it
 * into "Remove?", the second removes. Nothing else marks whose song is whose.
 */
export function SongsDrawer({
  tracks,
  currentTrackId,
  playing = false,
  uploadPhase,
  uploadProgress = null,
  uploadError,
  onSelect,
  onUpload,
  onRemove,
  onClose,
}: {
  tracks: LibraryTrack[];
  currentTrackId: string | null;
  /** The current track is audible (transport playing or paused), as opposed to queued behind Start. */
  playing?: boolean;
  uploadPhase: "analyzing" | "uploading" | null;
  /** 0..1 while the file is on its way to the server. */
  uploadProgress?: number | null;
  /** The drawer's one error line: a failed upload, or a song that could not be removed. */
  uploadError: string | null;
  onSelect: (trackId: string) => void;
  onUpload: (file: File) => void;
  /** Remove one of this browser's own uploads (already confirmed in place). */
  onRemove?: (trackId: string) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const shown = query.trim() ? tracks.filter((t) => t.title.toLowerCase().includes(query.trim().toLowerCase())) : tracks;
  // The song whose remove control has been tapped once and is asking "Remove?". It lets go by itself.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  useEffect(() => {
    if (!confirmingId) return;
    const t = setTimeout(() => setConfirmingId(null), 4000);
    return () => clearTimeout(t);
  }, [confirmingId]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "var(--stage)" }}>
      {/* min-h-0 down the flex chain: without it the track list refuses to shrink, so it can't
          scroll and shoves the upload/back buttons off-screen once the library grows. */}
      <div className="mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col gap-4" style={{ padding: safeAreaPadding(52, 20, 28) }}>
        <div className="flex shrink-0 items-center justify-between">
          <span className="font-display text-xl font-bold">Songs</span>
          {playing ? (
            <span className="text-[13px]" style={{ color: "var(--muted)" }}>
              picking another stops the music
            </span>
          ) : null}
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
            className="min-w-0 grow bg-transparent text-[15px] outline-none"
            style={{ color: "var(--text)" }}
          />
        </label>
        <div className="flex min-h-0 grow flex-col gap-2 overflow-y-auto">
          {shown.map((t) => {
            const removable = !!t.mine && !!onRemove;
            const confirming = confirmingId === t.id;
            return (
              <div
                key={t.id}
                className="flex shrink-0 items-center rounded-2xl border"
                style={{ background: "var(--surface)", borderColor: t.id === currentTrackId ? "var(--primary-fill)" : "var(--border)" }}
              >
                <button
                  onClick={() => {
                    setConfirmingId(null);
                    onSelect(t.id);
                  }}
                  className="flex min-w-0 grow items-center gap-3 rounded-2xl px-3.5 py-3 text-left"
                >
                  <span className="flex min-w-0 grow flex-col gap-0.5">
                    <span className="line-clamp-2 text-[15px] font-semibold [overflow-wrap:anywhere]">{t.title}</span>
                    <span className="text-xs" style={{ color: "var(--muted)" }}>
                      {songSubtitle(t, t.id === currentTrackId ? (playing ? "playing" : "next") : null)}
                    </span>
                  </span>
                </button>
                {removable ? (
                  <button
                    aria-label={confirming ? `Remove ${t.title}? Tap again to remove` : `Remove ${t.title}`}
                    onClick={() => {
                      if (!confirming) return setConfirmingId(t.id);
                      setConfirmingId(null);
                      onRemove!(t.id);
                    }}
                    className="flex h-11 min-w-11 shrink-0 items-center justify-center rounded-2xl px-3 text-[13px] font-semibold"
                    style={{ color: confirming ? "var(--health-bad)" : "var(--faint)" }}
                  >
                    {confirming ? (
                      "Remove?"
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                        <path d="M2 2l10 10M12 2L2 12" />
                      </svg>
                    )}
                  </button>
                ) : null}
              </div>
            );
          })}
          {shown.length === 0 && tracks.length > 0 ? (
            <p className="py-6 text-center text-sm" style={{ color: "var(--muted)" }}>
              No songs match.
            </p>
          ) : null}
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
          {uploadPhase === "analyzing"
            ? "Analyzing…"
            : uploadPhase === "uploading"
              ? `Uploading… ${uploadProgress != null ? `${Math.round(uploadProgress * 100)}%` : ""}`.trim()
              : "+ Upload a song"}
        </button>
        {uploadError ? (
          <p role="alert" className="shrink-0 text-center text-sm" style={{ color: "var(--health-bad)" }}>
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
