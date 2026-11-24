import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  root,
  resolve: {
    alias: {
      "next/headers": fileURLToPath(new URL("./next-headers-stub.ts", import.meta.url)),
      "next/server": fileURLToPath(new URL("./next-server-stub.ts", import.meta.url)),
      "@": fileURLToPath(new URL("../../apps/web", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/a2-routes-public/**/*.test.ts"],
    setupFiles: ["./tests/vitest/setup.ts"],
    reporters: ["default"],
    retry: 0,
    testTimeout: 10_000,
  },
});
