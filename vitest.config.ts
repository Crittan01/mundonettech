import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/vitest/**/*.test.ts"],
    reporters: ["default"],
    retry: 0,
    setupFiles: ["./tests/vitest/setup.ts"],
    testTimeout: 10_000,
  },
});
