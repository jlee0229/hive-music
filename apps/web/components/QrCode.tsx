"use client";

import { useEffect, useRef } from "react";
import QRCode from "qrcode";

export function QrCode({ value, size = 172 }: { value: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    QRCode.toCanvas(ref.current, value, { width: size, margin: 1, color: { dark: "#0B0F14", light: "#FFFFFF" } }).catch(() => {});
  }, [value, size]);

  return <canvas ref={ref} width={size} height={size} role="img" aria-label={`QR code for ${value}`} />;
}
