import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source, so Next must transpile them.
  transpilePackages: ["@hive/protocol", "@hive/sync-client"],
  // Phones join dev builds through the tunnel; Next's floating dev overlay ("N Issues" bubble)
  // reads as an app error to the crowd, so keep it off even in dev.
  devIndicators: false,
};

export default nextConfig;
