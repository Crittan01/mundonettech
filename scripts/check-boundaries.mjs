import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

import { lineNumberAt, repositoryFiles } from "./lib/file-utils.mjs";

const brandPattern = /mundo[-_]?net[-_]?tech|\bMNT-/giu;
const tailwindPaletteColorPattern =
  /(?<![-\w])(?:bg|text|border|ring|fill|stroke|from|via|to|outline|decoration|accent|caret|divide|placeholder)-(?:(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)|white|black)(?:\/\d{1,3})?(?![-\w])/g;
const arbitraryColorPattern =
  /(?<![-\w])(?:bg|text|border|ring|fill|stroke|from|via|to|outline|decoration|accent|caret|divide|placeholder)-\[(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\()/g;
const rawCssColorLiteralPattern = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\(/g;
const commentMarkerPattern = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g;
const incompleteTagPattern = /\b(?:TODO|FIXME|HACK|XXX)\b/;
const notImplementedThrowPattern =
  /\bthrow\s+new\s+\w*Error\(\s*["'`][^"'`]*(?:not\s+implemented|pendiente|todo|stub)\b/giu;
const prismaModelBlockPattern = /\bmodel\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)\n\}/g;
const monetaryFieldNamePattern =
  /(?:Cents$|^(?:price|cost|subtotal|total|discount|tax|fee|amount|balance|credit|revenue|proceeds|charge)$|(?:^|[a-z0-9])(?:Price|Cost|Subtotal|Total|Discount|Tax|Fee|Amount|Balance|Credit|Revenue|Proceeds|Charge)$)/;
const floatMoneyNamePattern =
  /(?:price|cost|amount|subtotal|total|tax|discount|fee|refund|credit|balance|revenue|cents)/i;
const softDeleteTotalUniqueExceptions = new Set([
  "Category.materializedPath",
  "ProductVariant.id.productId",
]);

function isSoftDeleteUniqueCandidate(fieldName) {
  return fieldName !== "id" && !/^(?:createdAt|updatedAt|deletedAt)$/.test(fieldName);
}

function isSoftDeleteTotalUniqueException(modelName, fields) {
  return softDeleteTotalUniqueExceptions.has(`${modelName}.${fields.join(".")}`);
}

function prismaStatements(body, bodyStart) {
  const statements = [];
  let statement = "";
  let statementStart = bodyStart;
  let parentheses = 0;
  let brackets = 0;
  let offset = bodyStart;

  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    if (!statement) statementStart = offset;
    statement += `${rawLine}\n`;
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < rawLine.length; index += 1) {
      const character = rawLine[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quoted && character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        quoted = !quoted;
        continue;
      }
      if (!quoted && character === "/" && rawLine[index + 1] === "/") break;
      if (quoted) continue;
      if (character === "(") parentheses += 1;
      if (character === ")") parentheses -= 1;
      if (character === "[") brackets += 1;
      if (character === "]") brackets -= 1;
    }
    offset += rawLine.length + 1;
    if (parentheses === 0 && brackets === 0) {
      statements.push({ text: statement.trim(), start: statementStart });
      statement = "";
    }
  }
  if (statement) statements.push({ text: statement.trim(), start: statementStart });
  return statements;
}

function staticModuleText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

export function moduleSpecifiers(sourceFile) {
  const specifiers = [];

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const value = staticModuleText(node.moduleSpecifier);
      if (value) specifiers.push(value);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const value = staticModuleText(node.moduleReference.expression);
      if (value) specifiers.push(value);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const value = staticModuleText(node.argument.literal);
      if (value) specifiers.push(value);
    } else if (ts.isCallExpression(node)) {
      const [argument] = node.arguments;
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const value = staticModuleText(argument);

      if ((isDynamicImport || isRequire) && value) {
        specifiers.push(value);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

export function findBoundaryViolations(file, text, root = process.cwd()) {
  const errors = [];
  const isPackage = file.startsWith("packages/");
  const isConfig = file.startsWith("config/");
  const isAppSharedLayer = /^apps\/web\/(?:components|lib)\//.test(file);

  if (isPackage) {
    const sanitizedText = text.replaceAll("@mundonettech/", "@workspace/");
    for (const match of sanitizedText.matchAll(brandPattern)) {
      errors.push(
        `${file}:${lineNumberAt(sanitizedText, match.index ?? 0)}: store identity must come from config, not packages.`,
      );
    }
  }

  if (file.endsWith(".prisma") || file.endsWith(".css")) return errors;

  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

  for (const specifier of moduleSpecifiers(sourceFile)) {
    const resolvedPath = specifier.startsWith(".")
      ? path
          .relative(root, path.resolve(path.dirname(path.resolve(root, file)), specifier))
          .replaceAll("\\", "/")
      : specifier;

    if (isPackage || isConfig) {
      const crossesApplicationBoundary =
        resolvedPath.startsWith("apps/") ||
        /^@mundonettech\/web(?:\/|$)/.test(resolvedPath) ||
        /^@\//.test(resolvedPath);
      const packageImportsConfig =
        isPackage &&
        (resolvedPath.startsWith("config/") || /^@mundonettech\/config(?:\/|$)/.test(resolvedPath));
      const configImportsPackage =
        isConfig &&
        (resolvedPath.startsWith("packages/") ||
          /^@mundonettech\/(?:db|core|media|cms|integrations|legal-co)(?:\/|$)/.test(resolvedPath));

      if (crossesApplicationBoundary || packageImportsConfig || configImportsPackage) {
        errors.push(`${file}: forbidden dependency on "${specifier}".`);
      }
    }

    if (isAppSharedLayer) {
      const importsAppRoutes =
        resolvedPath.startsWith("apps/web/app/") ||
        resolvedPath === "apps/web/app" ||
        /^@\/app(?:\/|$)/.test(resolvedPath);

      if (importsAppRoutes) {
        errors.push(`${file}: shared components/lib cannot import route module "${specifier}".`);
      }
    }
  }

  return errors;
}

export function findManifestBoundaryViolations(file, text) {
  const errors = [];
  const manifest = JSON.parse(text);
  const dependencySections = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ];
  const isPackage = file.startsWith("packages/");
  const isConfig = file.startsWith("config/");

  for (const section of dependencySections) {
    const deps = manifest[section];
    if (!deps || typeof deps !== "object") continue;

    for (const depName of Object.keys(deps)) {
      const forbiddenInPackage =
        isPackage && (depName === "@mundonettech/config" || depName === "@mundonettech/web");
      const forbiddenInConfig =
        isConfig &&
        (depName === "@mundonettech/web" ||
          /^@mundonettech\/(?:db|core|media|cms|integrations|legal-co)$/.test(depName));

      if (forbiddenInPackage || forbiddenInConfig) {
        errors.push(`${file}: forbidden workspace dependency "${depName}" in ${section}.`);
      }
    }
  }

  return errors;
}

export function findTokenColorViolations(file, text) {
  const errors = [];

  if (file === "apps/web/app/globals.css") {
    for (const match of text.matchAll(rawCssColorLiteralPattern)) {
      errors.push(
        `${file}:${lineNumberAt(text, match.index ?? 0)}: color literal "${match[0]}" must live in config/theme.config.ts.`,
      );
    }
    return errors;
  }

  for (const match of text.matchAll(tailwindPaletteColorPattern)) {
    errors.push(
      `${file}:${lineNumberAt(text, match.index ?? 0)}: use semantic CSS tokens instead of "${match[0]}".`,
    );
  }

  for (const match of text.matchAll(arbitraryColorPattern)) {
    errors.push(
      `${file}:${lineNumberAt(text, match.index ?? 0)}: arbitrary color utility "${match[0]}..." is forbidden; use semantic tokens.`,
    );
  }

  return errors;
}

export function findIncompleteCodeViolations(file, text) {
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) return [];
  const errors = [];

  for (const comment of text.matchAll(commentMarkerPattern)) {
    const tag = incompleteTagPattern.exec(comment[0]);
    if (tag) {
      errors.push(
        `${file}:${lineNumberAt(text, (comment.index ?? 0) + (tag.index ?? 0))}: incomplete marker "${tag[0]}" is forbidden; ship production-complete code.`,
      );
    }
  }

  for (const match of text.matchAll(notImplementedThrowPattern)) {
    errors.push(
      `${file}:${lineNumberAt(text, match.index ?? 0)}: stubbed throw "${match[0]}..." is forbidden; implement full production behavior.`,
    );
  }

  return errors;
}

export function findPrismaSchemaViolations(file, text) {
  if (!file.endsWith(".prisma")) return [];
  const errors = [];

  for (const modelMatch of text.matchAll(prismaModelBlockPattern)) {
    const modelName = modelMatch[1];
    const body = modelMatch[2] ?? "";
    const bodyStart = (modelMatch.index ?? 0) + modelMatch[0].indexOf(body);
    const hasDeletedAt = /^\s*deletedAt\s+DateTime\?/m.test(body);

    for (const statement of prismaStatements(body, bodyStart)) {
      const trimmed = statement.text;
      const lineIndex = statement.start;
      if (!trimmed || trimmed.startsWith("//")) continue;

      if (trimmed.startsWith("@@unique")) {
        if (hasDeletedAt) {
          const colsMatch = /^@@unique\(\s*\[([\s\S]*?)\]/.exec(trimmed);
          const cols = (colsMatch?.[1] ?? "")
            .split(",")
            .map((col) => col.trim().replace(/\([^)]*\)/g, ""))
            .filter(Boolean);
          if (!isSoftDeleteTotalUniqueException(modelName, cols)) {
            errors.push(
              `${file}:${lineNumberAt(text, lineIndex)}: model ${modelName} has deletedAt; declare partial unique index WHERE "deletedAt" IS NULL in SQL migration instead of @@unique (ADR-004).`,
            );
          }
        }
        continue;
      }

      if (trimmed.startsWith("@@")) continue;

      const fieldMatch =
        /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\?|\[\])?([\s\S]*)$/.exec(trimmed);
      if (!fieldMatch) continue;
      const [, fieldName = "", fieldType = "", , attributes = ""] = fieldMatch;

      if (
        (monetaryFieldNamePattern.test(fieldName) && fieldType !== "BigInt") ||
        ((fieldType === "Float" || fieldType === "Decimal") &&
          floatMoneyNamePattern.test(fieldName) &&
          !/(?:Rate|Ratio|Percent|Score)$/i.test(fieldName))
      ) {
        errors.push(
          `${file}:${lineNumberAt(text, lineIndex)}: monetary field ${modelName}.${fieldName} must use BigInt COP cents instead of ${fieldType} (ADR-002).`,
        );
      }

      if (
        hasDeletedAt &&
        isSoftDeleteUniqueCandidate(fieldName) &&
        !isSoftDeleteTotalUniqueException(modelName, [fieldName]) &&
        /\B@unique\b/.test(attributes)
      ) {
        errors.push(
          `${file}:${lineNumberAt(text, lineIndex)}: soft-deletable ${modelName}.${fieldName} must use a SQL partial unique index WHERE "deletedAt" IS NULL instead of @unique (ADR-004).`,
        );
      }
    }
  }

  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd();
  const allFiles = repositoryFiles();
  const codeFiles = allFiles.filter((file) =>
    /^(?:apps|config|packages)\/.*\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs|prisma)$/.test(file),
  );
  const manifestFiles = allFiles.filter((file) =>
    /^(?:config\/package\.json|packages\/[^/]+\/package\.json)$/.test(file),
  );
  const styleTargets = allFiles.filter((file) =>
    /^(?:apps|packages)\/.*\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs|css)$/.test(file),
  );
  const errors = [];

  for (const file of codeFiles) {
    const text = readFileSync(file, "utf8");
    errors.push(...findBoundaryViolations(file, text, root));
    errors.push(...findIncompleteCodeViolations(file, text));
    errors.push(...findPrismaSchemaViolations(file, text));
  }

  for (const file of manifestFiles) {
    const text = readFileSync(file, "utf8");
    errors.push(...findManifestBoundaryViolations(file, text));
  }

  for (const file of styleTargets) {
    const text = readFileSync(file, "utf8");
    errors.push(...findTokenColorViolations(file, text));
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log(
      `Boundary and token guards passed: ${codeFiles.length} source files and ${manifestFiles.length} manifests checked.`,
    );
  }
}
