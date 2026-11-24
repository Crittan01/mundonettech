import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { auditProject } from "./lib/ast-graph.mjs";
import { repositoryFiles } from "./lib/file-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = repositoryFiles();
const result = auditProject(
  {
    root,
    listFiles() {
      return files;
    },
    readFile(file) {
      return readFileSync(path.resolve(root, file), "utf8");
    },
  },
  { checkStaleExceptions: true },
);

if (result.diagnostics.length > 0) {
  for (const issue of result.diagnostics) console.error(issue.message);
  console.error(
    `AST guard failed: ${result.diagnostics.length} findings across ${result.stats.files} source files.`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `AST guard passed: ${result.stats.files} files, ${result.stats.exports} exports, ${result.stats.evaluatedModules} evaluated modules, ${result.cache.cacheFamilies.length} cache families and ${result.environment.reads.length} environment keys checked.`,
  );
}
