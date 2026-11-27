import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { repositoryFiles } from "./lib/file-utils.mjs";

export const level0Documents = [
  { path: "AGENTS.md", maxLines: 120 },
  { path: "docs/STATE.md", maxLines: 120 },
  { path: "docs/PLAN.md", maxLines: 160 },
];
export const level0ByteBudget = 13 * 1024;

const forbiddenDocPathPattern =
  /(?:^|\/)(?:\d{4}-\d{2}-\d{2}|.*(?:changelog|bitacora|bitácora|_archive)).*\.md$/iu;
const datedHeadingPattern = /^#{1,6}\s+.*\b20\d{2}-\d{2}-\d{2}\b/mu;

export function validateDocs({ files, readText }) {
  const errors = [];
  let totalBytes = 0;

  for (const document of level0Documents) {
    if (!files.includes(document.path)) {
      errors.push(`${document.path}: required Level 0 document is missing.`);
      continue;
    }
    const text = readText(document.path);
    const bytes = Buffer.byteLength(text);
    const lines = text.split(/\r\n|\r|\n/).length - (text.endsWith("\n") ? 1 : 0);
    totalBytes += bytes;

    if (lines > document.maxLines) {
      errors.push(`${document.path}: ${lines} lines exceeds ${document.maxLines}.`);
    }
  }

  if (totalBytes > level0ByteBudget) {
    errors.push(`Level 0 uses ${totalBytes} bytes; the budget is ${level0ByteBudget}.`);
  }

  for (const file of files) {
    if (!/\.md$/i.test(file)) continue;

    if (forbiddenDocPathPattern.test(file)) {
      errors.push(`${file}: dated chronicles, changelogs, and archived docs are forbidden.`);
      continue;
    }

    if (!file.startsWith("docs/")) continue;

    const text = readText(file);
    if (datedHeadingPattern.test(text)) {
      errors.push(`${file}: dated log headings are forbidden in living documentation.`);
    }
  }

  const packageNames = new Set(
    files
      .map((file) => /^packages\/([^/]+)\/package\.json$/.exec(file)?.[1])
      .filter((name) => Boolean(name)),
  );

  for (const pkgName of packageNames) {
    const readmePath = `packages/${pkgName}/README.md`;
    if (!files.includes(readmePath)) {
      errors.push(`${readmePath}: co-located Level 2 package README is required.`);
    }
  }

  return { errors, totalBytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = repositoryFiles();
  const { errors, totalBytes } = validateDocs({
    files,
    readText: (filePath) => readFileSync(filePath, "utf8"),
  });

  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log(`Documentation guards passed: ${totalBytes}/${level0ByteBudget} bytes.`);
  }
}
