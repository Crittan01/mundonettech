import { readFileSync } from "node:fs";

import { lineNumberAt, repositoryFiles } from "./lib/file-utils.mjs";

const voseoPattern =
  /\b(?:vos|tenés|querés|podés|hacés|decís|venís|sentís|servís|seguís|conseguís|elegís|comprás|pagás|usás|contás|llevás|llegás|dejás|esperás|mirá|probá|comprá|pagá|usá|contá|mostrá|ingresá|registrá|creá|configurá|instalá|actualizá|descargá|revisá|contactá|elegí|encontrá|conocé|hacé|decí|vení|poné|andá|volvé|leé|iniciá|registrate|suscribite)\b/giu;
const files = repositoryFiles().filter(
  (file) =>
    file !== "scripts/check-language.mjs" &&
    /\.(?:md|mdx|html|json|js|jsx|mjs|cjs|ts|tsx)$/.test(file),
);
const errors = [];

for (const file of files) {
  const text = readFileSync(file, "utf8");

  for (const match of text.matchAll(voseoPattern)) {
    const index = match.index;
    errors.push(`${file}:${lineNumberAt(text, index)}: use es-CO tuteo instead of "${match[0]}".`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(`Language guards passed: ${files.length} files checked.`);
}
