import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import { repositoryFiles } from "./lib/file-utils.mjs";

const requiredFiles = [".gitignore", ".gitleaks.toml"];
const forbiddenPaths = [
  {
    pattern:
      /(^|\/)(?:tmp|_archive|node_modules|\.next|\.turbo|out|build|dist|coverage|test-results|playwright-report|blob-report|\.DS_Store)(?:\/|$)|^playwright\/\.cache(?:\/|$)|^packages\/db\/src\/generated(?:\/|$)/,
    reason: "generated, scratch, or archived paths are not versioned",
  },
  {
    pattern:
      /(?:\.log|\.tsbuildinfo|\.sql\.gz|\.dump|\.gpg|\.tar\.gz|\.zip|\.pem|\.key|\.p12|\.pfx)$/i,
    reason: "logs, build caches, dumps, archives, and private keys are not versioned",
  },
];

export function findGitHygieneViolations(files) {
  const errors = [];

  for (const requiredFile of requiredFiles) {
    if (!files.includes(requiredFile)) {
      errors.push(`${requiredFile}: required hygiene file is missing.`);
    }
  }

  for (const file of files) {
    if (basename(file).startsWith(".env") && basename(file) !== ".env.example") {
      errors.push(`${file}: only .env.example environment files may be versioned.`);
    }

    for (const rule of forbiddenPaths) {
      if (rule.pattern.test(file)) errors.push(`${file}: ${rule.reason}.`);
    }
  }

  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = repositoryFiles();
  const errors = findGitHygieneViolations(files);

  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log(`Git hygiene guards passed: ${files.length} files checked.`);
  }
}
