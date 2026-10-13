"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { apiUrl } from "@/lib/hive/client";
import { QrCode } from "@/components/QrCode";

/** Smallest QR worth drawing: below ~3 px a module a phone camera stops resolving it. */
const MIN_QR_PX = 96;

/**
 * The "Join QR code" page the host opens from the stage: one giant scannable QR and almost nothing
 * else, sized to the viewport so it works held up on a phone or thrown on a TV. Read-only, no
 * connection to the room — it encodes the join URL, and asks the server once whether the hive is
 * still there so a stale tab does not go on advertising a dead code.
 */
export default function QrPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const roomCode = code.toUpperCase().replace(/[^A-Z0-9]/g, "");

  const [joinUrl, setJoinUrl] = useState(`/j/${roomCode}`);
  const [size, setSize] = useState(320);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    setJoinUrl(`${window.location.origin}/j/${roomCode}`);
    // The floor matters on a very short window (split screen, a landscape phone with the browser
    // chrome out): innerHeight - 200 goes negative there, which only drew a QR by accident.
    const fit = () => setSize(Math.max(MIN_QR_PX, Math.floor(Math.min(window.innerWidth - 48, window.innerHeight - 200))));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [roomCode]);

  useEffect(() => {
    let cancelled = false;
    // Only a definite "no such room" replaces the QR; offline or a server error leaves it up.
    fetch(`${apiUrl()}/rooms/${roomCode}`)
      .then((res) => {
        if (!cancelled && res.status === 404) setGone(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [roomCode]);

  if (gone) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-5 text-center" style={{ background: "var(--stage)" }}>
        <h1 className="font-display text-[2rem] leading-tight font-bold">Hive not found</h1>
        <p style={{ color: "var(--muted)" }}>No hive is running at code {roomCode}.</p>
        <Link href="/" className="mt-4 flex h-14 items-center justify-center rounded-2xl px-8 text-base font-semibold" style={{ background: "var(--primary-fill)", color: "var(--primary-text)" }}>
          Back home
        </Link>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 p-6" style={{ background: "var(--stage)" }}>
      <span className="font-display text-4xl font-extrabold tracking-[0.12em]">{roomCode}</span>
      <div className="rounded-3xl bg-white p-4">
        <QrCode value={joinUrl} size={size} />
      </div>
      <span className="font-mono text-center text-lg break-all" style={{ color: "var(--muted)" }}>
        {joinUrl.replace(/^https?:\/\//, "")}
      </span>
    </main>
  );
}
