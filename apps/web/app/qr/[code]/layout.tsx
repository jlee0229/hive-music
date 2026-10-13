import type { Metadata } from "next";
import type { ReactNode } from "react";

/** The tab title for the QR page the host holds up or puts on a TV. */
export async function generateMetadata({ params }: { params: Promise<{ code: string }> }): Promise<Metadata> {
  const { code } = await params;
  let decoded = code;
  try {
    decoded = decodeURIComponent(code);
  } catch {
    /* a stray % in the URL: use it as it came */
  }
  // The same tidying the pages do, so the tab says the code the screen says.
  const hive = decoded.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return { title: hive ? `Scan to join ${hive}` : "HiveMusic" };
}

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
