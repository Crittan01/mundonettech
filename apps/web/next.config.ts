import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  images: {
    unoptimized: true,
  },
  output: "standalone",
  outputFileTracingRoot: path.resolve(import.meta.dirname, "../.."),
  partialPrefetching: true,
  poweredByHeader: false,
};

export default nextConfig;
