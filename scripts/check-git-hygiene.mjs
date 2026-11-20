import { basename } from "node:path";

import { repositoryFiles } from "./lib/file-utils.mjs";

const files = repositoryFiles();
const errors = [];
const requiredFiles = [".gitignore", ".gitleaks.toml"];
const forbiddenPaths = [
  {
    pattern:
      /(^|\/)(?:tmp|_archive|node_modules|\.next|dist|coverage|test-results|playwright-report)(?:\/|$)/,
    reason: "generated, scratch, or archived paths are not versioned",
  },
  {
    pattern: /(?:\.log|\.sql\.gz|\.dump|\.gpg|\.tar\.gz|\.zip)$/i,
    reason: "logs, dumps, and archives are not versioned",
  },
];

for (const requiredFile of requiredFiles) {
  if (!files.includes(requiredFile))
    errors.push(`${requiredFile}: required hygiene file is missing.`);
}

for (const file of files) {
  if (basename(file).startsWith(".env") && basename(file) !== ".env.example") {
    errors.push(`${file}: only .env.example environment files may be versioned.`);
  }

  for (const rule of forbiddenPaths) {
    if (rule.pattern.test(file)) errors.push(`${file}: ${rule.reason}.`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(`Git hygiene guards passed: ${files.length} files checked.`);
}
