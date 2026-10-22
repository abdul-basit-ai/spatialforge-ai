import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: __dirname, // keep standalone output rooted here even when a parent folder has a lockfile
  serverExternalPackages: ["pg", "@clickhouse/client", "iovalkey"],
};

export default nextConfig;
