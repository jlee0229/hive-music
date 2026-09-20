"use client";

import { use, useEffect, useState } from "react";
import { QrCode } from "@/components/QrCode";

/**
 * The "Join QR code" page the host opens from the stage: one giant scannable QR and almost nothing
 * else, sized to the viewport so it works held up on a phone or thrown on a TV. Read-only, no
 * connection to the room — it only encodes the join URL.
 */
export default function QrPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const roomCode = code.toUpperCase();

  const [joinUrl, setJoinUrl] = useState(`/j/${roomCode}`);
  const [size, setSize] = useState(320);
  useEffect(() => {
    setJoinUrl(`${window.location.origin}/j/${roomCode}`);
    const fit = () => setSize(Math.floor(Math.min(window.innerWidth - 48, window.innerHeight - 200)));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [roomCode]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 p-6" style={{ background: "var(--stage)" }}>
      <span className="font-display text-4xl font-extrabold tracking-[0.12em]">{roomCode}</span>
      <div className="rounded-3xl bg-white p-4">
        <QrCode value={joinUrl} size={size} />
      </div>
      <span className="font-mono text-center text-lg" style={{ color: "var(--muted)" }}>
        {joinUrl.replace(/^https?:\/\//, "")}
      </span>
    </main>
  );
}
