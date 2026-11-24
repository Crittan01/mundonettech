import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  experimental: {
    serverActions: { bodySizeLimit: "110mb" },
    staticGenerationMaxConcurrency: 4,
    staticGenerationMinPagesPerWorker: 25,
  },
  htmlLimitedBots: /.*/,
  images: {
    unoptimized: true,
  },
  output: "standalone",
  outputFileTracingRoot: path.resolve(import.meta.dirname, "../.."),
  partialPrefetching: true,
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
