import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier";
import globals from "globals";

import foundation from "./scripts/eslint-rules.mjs";

export default defineConfig([
  globalIgnores([
    "**/.next/**",
    "**/.turbo/**",
    "**/coverage/**",
    "**/dist/**",
    "**/node_modules/**",
    "packages/db/src/generated/**",
    "**/playwright-report/**",
    "**/test-results/**",
    "**/tmp/**",
  ]),
  {
    files: ["**/*.{js,jsx,mjs,cjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  ...nextVitals,
  ...nextTypeScript,
  {
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    plugins: { foundation },
    rules: {
      "@next/next/no-html-link-for-pages": "off",
      "foundation/client-ip": "error",
      "foundation/sharp-safe": "error",
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  prettier,
]);
