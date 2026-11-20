import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

import { lineNumberAt, repositoryFiles } from "./lib/file-utils.mjs";

const root = process.cwd();
const files = repositoryFiles().filter((file) =>
  /^(?:config|packages)\/.*\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs|prisma)$/.test(file),
);
const errors = [];

function moduleSpecifiers(sourceFile) {
  const specifiers = [];

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const [argument] = node.arguments;
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";

      if ((isDynamicImport || isRequire) && argument && ts.isStringLiteral(argument)) {
        specifiers.push(argument.text);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const isPackage = file.startsWith("packages/");
  const sanitizedText = text.replaceAll("@mundonettech/", "@workspace/");
  const brandPattern = /mundonettech|\bMNT-/giu;

  if (isPackage) {
    for (const match of sanitizedText.matchAll(brandPattern)) {
      errors.push(
        `${file}:${lineNumberAt(sanitizedText, match.index)}: store identity must come from config, not packages.`,
      );
    }
  }

  if (file.endsWith(".prisma")) continue;

  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

  for (const specifier of moduleSpecifiers(sourceFile)) {
    const resolvedPath = specifier.startsWith(".")
      ? path
          .relative(root, path.resolve(path.dirname(path.resolve(file)), specifier))
          .replaceAll("\\", "/")
      : specifier;
    const crossesApplicationBoundary =
      resolvedPath.startsWith("apps/") || /^@\/(?:app|components)(?:\/|$)/.test(resolvedPath);
    const packageImportsConfig =
      isPackage &&
      (resolvedPath.startsWith("config/") || /^@mundonettech\/config(?:\/|$)/.test(resolvedPath));
    const configImportsPackage =
      file.startsWith("config/") &&
      (resolvedPath.startsWith("packages/") ||
        /^@mundonettech\/(?:db|core|media|cms|integrations|legal-co)(?:\/|$)/.test(resolvedPath));

    if (crossesApplicationBoundary || packageImportsConfig || configImportsPackage) {
      errors.push(`${file}: forbidden dependency on "${specifier}".`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(`Boundary guards passed: ${files.length} files checked.`);
}
