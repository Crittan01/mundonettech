import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { lineNumberAt, repositoryFiles } from "./lib/file-utils.mjs";

export const voseoPattern =
  /(?<![\p{L}\p{N}_])(?:vos|sos|sabés|tenés|querés|podés|hacés|decís|venís|sentís|servís|seguís|conseguís|elegís|comprás|pagás|usás|contás|llevás|llegás|dejás|esperás|podás|tengás|querás|hagás|mirá|probá|comprá|pagá|usá|contá|mostrá|ingresá|registrá|creá|configurá|instalá|actualizá|descargá|revisá|contactá|elegí|encontrá|conocé|hacé|decí|vení|poné|andá|volvé|leé|iniciá|registrate|suscribite|escribinos|contactanos|llamanos|contanos|buscanos)(?![\p{L}\p{N}_])/giu;

export function findLanguageViolations(file, text) {
  const errors = [];

  for (const match of text.matchAll(voseoPattern)) {
    const index = match.index ?? 0;
    errors.push(`${file}:${lineNumberAt(text, index)}: use es-CO tuteo instead of "${match[0]}".`);
  }

  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = repositoryFiles().filter(
    (file) =>
      file !== "scripts/check-language.mjs" &&
      /\.(?:md|mdx|html|json|js|jsx|mjs|cjs|ts|tsx|mts|cts)$/.test(file),
  );
  const errors = [];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    errors.push(...findLanguageViolations(file, text));
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log(`Language guards passed: ${files.length} files checked.`);
  }
}
