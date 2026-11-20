import { readFileSync } from "node:fs";

const documents = [
  { path: "AGENTS.md", maxLines: 120 },
  { path: "docs/STATE.md", maxLines: 120 },
  { path: "docs/PLAN.md", maxLines: 160 },
];
const byteBudget = 13 * 1024;
const errors = [];
let totalBytes = 0;

for (const document of documents) {
  const text = readFileSync(document.path, "utf8");
  const bytes = Buffer.byteLength(text);
  const lines = text.split(/\r\n|\r|\n/).length - (text.endsWith("\n") ? 1 : 0);
  totalBytes += bytes;

  if (lines > document.maxLines) {
    errors.push(`${document.path}: ${lines} lines exceeds ${document.maxLines}.`);
  }
}

if (totalBytes > byteBudget) {
  errors.push(`Level 0 uses ${totalBytes} bytes; the budget is ${byteBudget}.`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(`Documentation guards passed: ${totalBytes}/${byteBudget} bytes.`);
}
