import type { Metadata } from "next";
import type { ReactNode } from "react";

/** The tab title for the host: which hive this phone is running. */
export async function generateMetadata({ params }: { params: Promise<{ code: string }> }): Promise<Metadata> {
  const { code } = await params;
  const hive = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return { title: hive ? `Hosting hive ${hive}` : "HiveMusic" };
}

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
