import { execFileSync } from "node:child_process";

export function repositoryFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );

  return [...new Set(output.split("\0").filter(Boolean))].sort();
}

export function lineNumberAt(text, index) {
  return text.slice(0, index).split(/\r\n|\r|\n/).length;
}
