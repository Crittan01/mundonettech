import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { repositoryFiles } from "./lib/file-utils.mjs";
import { auditSecuritySurface } from "./lib/security-surface.mjs";
import { securitySurfaceManifest } from "./lib/security-surface-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = repositoryFiles();
const result = auditSecuritySurface(
  {
    root,
    listFiles() {
      return files;
    },
    readFile(file) {
      return readFileSync(path.resolve(root, file), "utf8");
    },
  },
  securitySurfaceManifest,
);

if (result.diagnostics.length > 0) {
  for (const issue of result.diagnostics) console.error(issue.message);
  console.error(
    `Security surface guard failed: ${result.diagnostics.length} findings across ${result.stats.files} entry modules.`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `Security surface guard passed: ${result.stats.files} modules, ${result.stats.serverActions} Server Actions, ${result.stats.routeHandlers} Route Handlers and ${result.stats.proxyHandlers} proxy handler checked.`,
  );
}
