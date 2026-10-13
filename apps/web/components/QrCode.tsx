"use client";

import { useEffect, useRef } from "react";
import QRCode from "qrcode";

export function QrCode({ value, size = 172 }: { value: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    QRCode.toCanvas(ref.current, value, { width: size, margin: 1, color: { dark: "#0B0F14", light: "#FFFFFF" } }).catch(() => {});
  }, [value, size]);

  // The canvas is drawn at CSS-pixel resolution and scaled up by the device pixel ratio; without
  // "pixelated" a 3x phone smooths every module edge into a grey ramp, which is exactly the part
  // of the image a scanner thresholds on.
  return <canvas ref={ref} width={size} height={size} role="img" aria-label={`QR code for ${value}`} style={{ imageRendering: "pixelated" }} />;
}
