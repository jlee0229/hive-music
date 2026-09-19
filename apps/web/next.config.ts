import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source, so Next must transpile them.
  transpilePackages: ["@hive/protocol", "@hive/sync-client"],
};

export default nextConfig;
