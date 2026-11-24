import path from "node:path";

import ts from "typescript";

const sourcePattern = /\.(?:[cm]?[jt]sx?)$/i;
const productionPattern = /^(?:config|packages|apps\/web)\//;
const scannedPattern = /^(?:config|packages|apps\/web|scripts|tests|e2e)\//;
const runtimePlatformEnvironmentKeys = new Set(["NODE_ENV", "NEXT_PHASE", "VERCEL", "VERCEL_ENV"]);
const toolingPlatformEnvironmentKeys = new Set(["CI", "PATH"]);
const platformEnvironmentKeys = new Set([
  ...runtimePlatformEnvironmentKeys,
  ...toolingPlatformEnvironmentKeys,
]);
const documentedTestEnvironmentKeys = new Set([
  "TEST_DATABASE_URL",
  "TEST_DB_PORT",
  "TEST_DB_CONTAINER",
  "CHROME_PATH",
  "K6_BINARY",
  "RECOVERY_DEBUG",
  "WEB_VERIFY_URL",
]);
const nextRouteFiles = new Set([
  "page",
  "layout",
  "route",
  "template",
  "error",
  "global-error",
  "loading",
  "not-found",
  "forbidden",
  "unauthorized",
  "default",
  "sitemap",
  "robots",
  "manifest",
  "icon",
  "apple-icon",
  "opengraph-image",
  "twitter-image",
]);
const nextSegmentConfigExports = [
  "dynamic",
  "dynamicParams",
  "revalidate",
  "fetchCache",
  "runtime",
  "preferredRegion",
  "maxDuration",
  "experimental_ppr",
];
const nextCommonExports = new Set([
  "default",
  "metadata",
  "generateMetadata",
  "generateStaticParams",
  "generateViewport",
  "viewport",
  ...nextSegmentConfigExports,
]);
const nextImageFiles = new Set(["icon", "apple-icon", "opengraph-image", "twitter-image"]);
const nextImageExports = new Set([
  "default",
  "alt",
  "size",
  "contentType",
  "generateImageMetadata",
  ...nextSegmentConfigExports,
]);
const nextSitemapExports = new Set(["default", "generateSitemaps", ...nextSegmentConfigExports]);
const nextRouteExports = new Set([
  ...nextSegmentConfigExports,
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

export const publicApiEntrypoints = Object.freeze([
  {
    specifier: "@mundonettech/config",
    reason: "The root config entrypoint intentionally exposes the complete store contract.",
  },
]);

export const publicPackageExports = Object.freeze([
  {
    packageName: "@mundonettech/integrations",
    symbol: "FlexShippingProvider",
    reason: "The documented Flex adapter is a deliberate public package contract.",
  },
  {
    packageName: "@mundonettech/integrations",
    symbol: "DianInvoiceProvider",
    reason: "The documented DIAN adapter is a deliberate public package contract.",
  },
]);

export const cacheExceptions = Object.freeze([
  {
    tag: "legal",
    callsite: "apps/web/lib/legal.ts:readLegalDocuments",
    reason: "Legal documents are build-time configuration.",
  },
  {
    tag: "legal:documents",
    callsite: "apps/web/lib/legal.ts:readLegalDocuments",
    reason: "Legal documents are build-time configuration.",
  },
  {
    tag: "legal",
    callsite: "apps/web/app/(storefront)/legal/page.tsx:LegalIndexPage",
    reason: "Legal documents are build-time configuration.",
  },
  {
    tag: "legal:documents",
    callsite: "apps/web/app/(storefront)/legal/page.tsx:LegalIndexPage",
    reason: "Legal documents are build-time configuration.",
  },
  {
    tag: "legal",
    callsite: "apps/web/app/(storefront)/legal/[slug]/page.tsx:CachedLegalArticle",
    reason: "Legal documents are build-time configuration.",
  },
  {
    tag: "legal:documents",
    callsite: "apps/web/app/(storefront)/legal/[slug]/page.tsx:CachedLegalArticle",
    reason: "Legal documents are build-time configuration.",
  },
  {
    tag: "legal:doc:*",
    callsite: "apps/web/app/(storefront)/legal/[slug]/page.tsx:CachedLegalArticle",
    reason: "Legal documents are build-time configuration.",
  },
  {
    tag: "legal",
    callsite: "apps/web/components/layout/store-footer.tsx:StoreFooter",
    reason: "The static shell only renders build-time legal configuration.",
  },
  {
    tag: "help-center",
    callsite: "apps/web/app/(storefront)/ayuda/[slug]/page.tsx:HelpArticlePage",
    reason: "Help articles are build-time configuration.",
  },
  {
    tag: "legal",
    callsite: "apps/web/lib/seo-data.ts:readSitemapEntries",
    reason: "The sitemap reads build-time legal configuration.",
  },
  {
    tag: "help-center",
    callsite: "apps/web/lib/seo-data.ts:readSitemapEntries",
    reason: "The sitemap reads build-time help configuration.",
  },
  {
    tag: "storefront:layout",
    callsite: "apps/web/app/(storefront)/layout.tsx:StorefrontLayout",
    reason: "The storefront layout is a static shell.",
  },
  {
    tag: "storefront:header",
    callsite: "apps/web/components/layout/store-header.tsx:StoreHeader",
    reason: "The storefront header is a static shell.",
  },
  {
    tag: "storefront:footer",
    callsite: "apps/web/components/layout/store-footer.tsx:StoreFooter",
    reason: "The storefront footer is a static shell.",
  },
  {
    tag: "storefront:home",
    callsite: "apps/web/app/(storefront)/page.tsx:HomePage",
    reason: "The home shell is static and the same entry also tags mutable catalog data.",
    requiresFamily: "catalog",
  },
]);

function slash(value) {
  return value.replaceAll("\\", "/");
}

function absolute(root, file) {
  return slash(path.isAbsolute(file) ? path.normalize(file) : path.resolve(root, file));
}

function displayPath(root, file) {
  return slash(path.relative(root, file)) || path.basename(file);
}

function scriptKind(file) {
  if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(file)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function extensionFor(file) {
  if (/\.tsx$/i.test(file)) return ts.Extension.Tsx;
  if (/\.ts$/i.test(file)) return ts.Extension.Ts;
  if (/\.mts$/i.test(file)) return ts.Extension.Mts;
  if (/\.cts$/i.test(file)) return ts.Extension.Cts;
  if (/\.jsx$/i.test(file)) return ts.Extension.Jsx;
  if (/\.mjs$/i.test(file)) return ts.Extension.Mjs;
  if (/\.cjs$/i.test(file)) return ts.Extension.Cjs;
  return ts.Extension.Js;
}

function staticText(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function hasDirective(body, directive) {
  if (!body?.statements) return false;
  for (const statement of body.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) {
      return false;
    }
    if (statement.expression.text === directive) return true;
  }
  return false;
}

function functionName(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  if (ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  return "default";
}

function enclosingFunction(node) {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function diagnostic(root, file, sourceFile, node, category, message) {
  const position = node && sourceFile ? node.getStart(sourceFile) : 0;
  const line = sourceFile ? sourceFile.getLineAndCharacterOfPosition(position).line + 1 : 1;
  return {
    category,
    file: displayPath(root, file),
    line,
    message: `${displayPath(root, file)}:${line}: ${message}`,
  };
}

function hasUseCacheDirective(body) {
  return (
    hasDirective(body, "use cache") ||
    hasDirective(body, "use cache: remote") ||
    hasDirective(body, "use cache: private")
  );
}

function isSourceFileInScope(relative) {
  return (
    sourcePattern.test(relative) &&
    !/\.d\.[cm]?ts$/i.test(relative) &&
    !/(?:^|\/)(?:dist|generated|node_modules|\.next|\.turbo)(?:\/|$)/.test(relative) &&
    (scannedPattern.test(relative) ||
      /^(?:playwright|vitest|eslint|prettier)\.config\.[cm]?[jt]s$/.test(relative))
  );
}

function flattenExportTarget(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const target = flattenExportTarget(entry);
      if (target) return target;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const condition of ["import", "default", "require", "types"]) {
    if (condition in value) {
      const target = flattenExportTarget(value[condition]);
      if (target) return target;
    }
  }
  return null;
}

function bindingIdentifiers(name, output = []) {
  if (ts.isIdentifier(name)) output.push(name);
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) bindingIdentifiers(element.name, output);
    }
  }
  return output;
}

function isFunctionLikeDeclaration(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

export function createVirtualHost(files, { root = "/virtual" } = {}) {
  const copies = new Map();
  for (const [file, text] of Object.entries(files)) copies.set(slash(file), text);
  return {
    root,
    listFiles() {
      return [...copies.keys()].sort();
    },
    readFile(file) {
      const relative = slash(file);
      if (!copies.has(relative)) throw new Error(`Virtual file not found: ${relative}`);
      return copies.get(relative);
    },
  };
}

export function auditProject(
  host,
  {
    exceptions = cacheExceptions,
    entrypoints = publicApiEntrypoints,
    packageExports = publicPackageExports,
    checkStaleExceptions = false,
  } = {},
) {
  const root = slash(host.root ?? process.cwd());
  const allFiles = host.listFiles().map(slash).sort();
  const sourceFiles = new Map();
  for (const relative of allFiles) {
    if (!isSourceFileInScope(relative)) continue;
    sourceFiles.set(absolute(root, relative), host.readFile(relative));
  }

  const diagnostics = [];
  const manifests = new Map();
  for (const relative of allFiles) {
    if (!/(?:^|\/)package\.json$/.test(relative)) continue;
    try {
      manifests.set(absolute(root, relative), JSON.parse(host.readFile(relative)));
    } catch (error) {
      diagnostics.push({
        category: "manifest",
        file: relative,
        line: 1,
        message: `${relative}:1: invalid package.json: ${error.message}`,
      });
    }
  }

  const packages = new Map();
  for (const [manifestPath, manifest] of manifests) {
    if (typeof manifest.name === "string") {
      packages.set(manifest.name, {
        manifest,
        directory: path.dirname(manifestPath),
      });
    }
  }

  function existingFile(candidate) {
    const normalized = slash(path.normalize(candidate));
    if (sourceFiles.has(normalized)) return normalized;
    const extension = path.posix.extname(normalized);
    const withoutExtension = normalized.slice(0, -extension.length);
    const mapped = [];
    if (/\.js$/i.test(normalized)) mapped.push(`${withoutExtension}.ts`, `${withoutExtension}.tsx`);
    if (/\.jsx$/i.test(normalized)) mapped.push(`${withoutExtension}.tsx`);
    if (/\.mjs$/i.test(normalized)) mapped.push(`${withoutExtension}.mts`);
    if (/\.cjs$/i.test(normalized)) mapped.push(`${withoutExtension}.cts`);
    if (/\.d\.ts$/i.test(normalized)) {
      const declarationBase = normalized.slice(0, -5);
      mapped.push(`${declarationBase}.ts`, `${declarationBase}.tsx`);
    }
    if (!extension) {
      mapped.push(
        `${normalized}.ts`,
        `${normalized}.tsx`,
        `${normalized}.mts`,
        `${normalized}.cts`,
        `${normalized}.js`,
        `${normalized}.jsx`,
        `${normalized}.mjs`,
        `${normalized}.cjs`,
      );
    }
    for (const file of mapped) {
      if (sourceFiles.has(file)) return file;
    }
    for (const index of [
      "index.ts",
      "index.tsx",
      "index.mts",
      "index.cts",
      "index.js",
      "index.jsx",
      "index.mjs",
      "index.cjs",
    ]) {
      const file = path.posix.join(normalized, index);
      if (sourceFiles.has(file)) return file;
    }
    return null;
  }

  function sourceVariants(candidate) {
    const normalized = slash(path.normalize(candidate));
    const variants = [normalized];
    if (normalized.includes("/dist/")) variants.push(normalized.replaceAll("/dist/", "/src/"));
    const configDist = `${slash(path.join(root, "config"))}/dist/`;
    if (normalized.startsWith(configDist)) {
      variants.push(normalized.replace(configDist, `${slash(path.join(root, "config"))}/`));
    }
    return variants;
  }

  function resolveAsFile(candidate) {
    for (const variant of sourceVariants(candidate)) {
      const resolved = existingFile(variant);
      if (resolved) return resolved;
    }
    return null;
  }

  function resolvePackage(specifier) {
    for (const [name, entry] of packages) {
      if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
      const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
      const exports = entry.manifest.exports;
      let target = null;
      if (typeof exports === "string" || Array.isArray(exports)) {
        if (subpath === ".") target = flattenExportTarget(exports);
      } else if (exports && typeof exports === "object") {
        if (exports[subpath] !== undefined) {
          target = flattenExportTarget(exports[subpath]);
        } else {
          for (const [pattern, value] of Object.entries(exports)) {
            if (!pattern.includes("*")) continue;
            const [before, after] = pattern.split("*");
            if (!subpath.startsWith(before) || !subpath.endsWith(after)) continue;
            const wildcard = subpath.slice(before.length, subpath.length - after.length);
            const flattened = flattenExportTarget(value);
            if (flattened) target = flattened.replaceAll("*", wildcard);
            if (target) break;
          }
        }
        if (
          !target &&
          subpath === "." &&
          !Object.keys(exports).some((key) => key.startsWith("."))
        ) {
          target = flattenExportTarget(exports);
        }
      }
      if (!target && subpath === ".") {
        target = entry.manifest.main ?? entry.manifest.module ?? entry.manifest.types ?? "./index";
      }
      if (!target && subpath !== ".") target = subpath;
      if (!target) return null;
      return resolveAsFile(path.resolve(entry.directory, target));
    }
    return undefined;
  }

  function resolveModule(specifier, containingFile) {
    if (specifier.startsWith("@/")) {
      return resolveAsFile(path.resolve(root, "apps/web", specifier.slice(2)));
    }
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      return resolveAsFile(path.resolve(path.dirname(containingFile), specifier));
    }
    return resolvePackage(specifier) ?? null;
  }

  const parsed = new Map();
  function sourceFileFor(file) {
    if (!sourceFiles.has(file)) return undefined;
    if (!parsed.has(file)) {
      parsed.set(
        file,
        ts.createSourceFile(
          file,
          sourceFiles.get(file),
          ts.ScriptTarget.Latest,
          true,
          scriptKind(file),
        ),
      );
    }
    return parsed.get(file);
  }

  const compilerHost = {
    getSourceFile(fileName) {
      return sourceFileFor(slash(fileName));
    },
    getSourceFileByPath(_fileName, filePath) {
      return sourceFileFor(slash(filePath));
    },
    getDefaultLibFileName() {
      return "no-default-lib.d.ts";
    },
    writeFile() {},
    getCurrentDirectory() {
      return root;
    },
    getDirectories() {
      return [];
    },
    fileExists(fileName) {
      return sourceFiles.has(slash(fileName));
    },
    readFile(fileName) {
      return sourceFiles.get(slash(fileName));
    },
    getCanonicalFileName(fileName) {
      return slash(fileName);
    },
    useCaseSensitiveFileNames() {
      return true;
    },
    getNewLine() {
      return "\n";
    },
    resolveModuleNameLiterals(moduleLiterals, containingFile) {
      return moduleLiterals.map((literal) => {
        const resolved = resolveModule(literal.text, slash(containingFile));
        return resolved
          ? {
              resolvedModule: {
                resolvedFileName: resolved,
                extension: extensionFor(resolved),
                isExternalLibraryImport: false,
              },
            }
          : {};
      });
    },
  };

  const program = ts.createProgram({
    rootNames: [...sourceFiles.keys()],
    options: {
      allowJs: true,
      allowImportingTsExtensions: true,
      checkJs: false,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      noLib: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
      types: [],
    },
    host: compilerHost,
  });
  const checker = program.getTypeChecker();
  const modules = new Map();

  for (const file of sourceFiles.keys()) {
    const sourceFile = sourceFileFor(file);
    const symbol = checker.getSymbolAtLocation(sourceFile) ?? sourceFile.symbol;
    modules.set(file, {
      file,
      sourceFile,
      symbol,
      exports: [],
      exportsByName: new Map(),
      dependencies: new Set(),
      evaluated: false,
    });
  }

  function addExport(moduleRecord, record) {
    const full = {
      live: false,
      sourceModule: null,
      sourceName: null,
      localSymbol: null,
      targetSymbol: null,
      ...record,
      moduleRecord,
    };
    moduleRecord.exports.push(full);
    if (!moduleRecord.exportsByName.has(full.name)) moduleRecord.exportsByName.set(full.name, []);
    moduleRecord.exportsByName.get(full.name).push(full);
    return full;
  }

  function moduleExportsSymbol(moduleRecord, name) {
    if (!moduleRecord?.symbol) return null;
    return (
      checker.getExportsOfModule(moduleRecord.symbol).find((entry) => entry.name === name) ?? null
    );
  }

  function resolveAlias(symbol) {
    if (!symbol) return null;
    if (!(symbol.flags & ts.SymbolFlags.Alias)) return symbol;
    try {
      return checker.getAliasedSymbol(symbol);
    } catch {
      return symbol;
    }
  }

  for (const moduleRecord of modules.values()) {
    for (const statement of moduleRecord.sourceFile.statements) {
      if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
        const specifier = staticText(statement.moduleSpecifier);
        if (!specifier) continue;
        const resolved = resolveModule(specifier, moduleRecord.file);
        if (resolved) moduleRecord.dependencies.add(resolved);
        else if (
          (specifier.startsWith(".") ||
            specifier.startsWith("@/") ||
            resolvePackage(specifier) !== undefined) &&
          (sourcePattern.test(specifier) || !path.posix.extname(specifier)) &&
          !/(?:^|\/)generated\//.test(specifier)
        ) {
          diagnostics.push(
            diagnostic(
              root,
              moduleRecord.file,
              moduleRecord.sourceFile,
              statement.moduleSpecifier,
              "resolution",
              `cannot resolve internal module "${specifier}" without generated output.`,
            ),
          );
        }
      }

      if (ts.isExportDeclaration(statement)) {
        const specifier = staticText(statement.moduleSpecifier);
        const sourceModule = specifier
          ? modules.get(resolveModule(specifier, moduleRecord.file))
          : null;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            const name = element.name.text;
            const localName = element.propertyName ?? element.name;
            const localSymbol = specifier ? null : checker.getSymbolAtLocation(localName);
            addExport(moduleRecord, {
              name,
              node: element.name,
              typeOnly: statement.isTypeOnly || element.isTypeOnly,
              localSymbol,
              targetSymbol: specifier
                ? moduleExportsSymbol(sourceModule, localName.text)
                : localSymbol,
              sourceModule,
              sourceName: specifier ? localName.text : null,
              sourceSpecifier: specifier ?? null,
            });
          }
        } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
          const name = statement.exportClause.name.text;
          addExport(moduleRecord, {
            name,
            node: statement.exportClause.name,
            typeOnly: statement.isTypeOnly,
            targetSymbol: moduleExportsSymbol(moduleRecord, name),
            sourceModule,
            sourceName: "*namespace",
            sourceSpecifier: specifier ?? null,
          });
        }
        continue;
      }

      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
      if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      const isDefault = modifiers.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
      );
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          for (const nameNode of bindingIdentifiers(declaration.name)) {
            addExport(moduleRecord, {
              name: nameNode.text,
              node: nameNode,
              typeOnly: false,
              targetSymbol: checker.getSymbolAtLocation(nameNode),
            });
          }
        }
      } else if (
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)
      ) {
        const name =
          statement.name && ts.isIdentifier(statement.name) ? statement.name.text : "default";
        const exportSymbol = moduleExportsSymbol(moduleRecord, isDefault ? "default" : name);
        addExport(moduleRecord, {
          name: isDefault ? "default" : name,
          node: statement.name ?? statement,
          typeOnly: ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement),
          targetSymbol: statement.name ? checker.getSymbolAtLocation(statement.name) : exportSymbol,
        });
      }
    }
    for (const statement of moduleRecord.sourceFile.statements) {
      if (ts.isExportAssignment(statement)) {
        addExport(moduleRecord, {
          name: statement.isExportEquals ? "export=" : "default",
          node: statement,
          typeOnly: false,
          targetSymbol: moduleExportsSymbol(
            moduleRecord,
            statement.isExportEquals ? "export=" : "default",
          ),
        });
      }
    }
  }

  for (const moduleRecord of modules.values()) {
    for (const statement of moduleRecord.sourceFile.statements) {
      if (
        !ts.isExportDeclaration(statement) ||
        statement.exportClause ||
        !statement.moduleSpecifier
      ) {
        continue;
      }
      const specifier = staticText(statement.moduleSpecifier);
      const sourceModule = modules.get(resolveModule(specifier, moduleRecord.file));
      if (!sourceModule?.symbol) continue;
      const sourceExports = checker.getExportsOfModule(sourceModule.symbol);
      for (const symbol of sourceExports) {
        if (symbol.name === "default" || moduleRecord.exportsByName.has(symbol.name)) continue;
        addExport(moduleRecord, {
          name: symbol.name,
          node: statement.moduleSpecifier,
          typeOnly: statement.isTypeOnly,
          targetSymbol: symbol,
          sourceModule,
          sourceName: symbol.name,
          sourceSpecifier: specifier ?? null,
        });
      }
    }
  }

  function exportRecords(moduleRecord, name) {
    return moduleRecord?.exportsByName.get(name) ?? [];
  }

  function symbolHasRuntime(symbol) {
    const resolved = resolveAlias(symbol);
    return Boolean(resolved && resolved.flags & ts.SymbolFlags.Value);
  }

  function symbolHasType(symbol) {
    const resolved = resolveAlias(symbol);
    return Boolean(resolved && resolved.flags & ts.SymbolFlags.Type);
  }

  function exportKinds(record, seen = new Set()) {
    if (seen.has(record)) return [];
    seen.add(record);
    if (record.typeOnly) return ["type"];
    if (record.sourceModule && record.sourceName && record.sourceName !== "*namespace") {
      const inherited = exportRecords(record.sourceModule, record.sourceName).flatMap((entry) =>
        exportKinds(entry, seen),
      );
      if (inherited.length > 0) return [...new Set(inherited)];
    }
    const kinds = [];
    if (symbolHasRuntime(record.targetSymbol)) kinds.push("runtime");
    if (symbolHasType(record.targetSymbol)) kinds.push("type");
    if (kinds.length === 0) {
      if (record.targetSymbol?.flags & ts.SymbolFlags.Alias) kinds.push("runtime", "type");
      else kinds.push("runtime");
    }
    return kinds;
  }

  const exportsBySymbol = new Map();
  for (const moduleRecord of modules.values()) {
    for (const record of moduleRecord.exports) {
      const symbol = resolveAlias(record.targetSymbol);
      if (!symbol) continue;
      if (!exportsBySymbol.has(symbol)) exportsBySymbol.set(symbol, []);
      exportsBySymbol.get(symbol).push(record);
    }
  }

  const evaluated = [];
  const symbolWork = [];
  const contractWork = [];
  const symbolQueued = new Set();
  const symbolScanned = new Set();
  const contractQueued = new Set();
  const contractScanned = new Set();
  const exportQueued = new Set();

  function queueSymbol(symbol) {
    const resolved = resolveAlias(symbol);
    if (!resolved || symbolQueued.has(resolved)) return;
    symbolQueued.add(resolved);
    symbolWork.push(resolved);
  }

  function queuePublicContract(symbol) {
    const resolved = resolveAlias(symbol);
    if (!resolved || contractQueued.has(resolved)) return;
    contractQueued.add(resolved);
    contractWork.push(resolved);
  }

  function queueExportsForSymbol(symbol) {
    for (const record of exportsBySymbol.get(resolveAlias(symbol)) ?? []) queueExport(record);
  }

  function queueExport(record) {
    if (!record || record.live || exportQueued.has(record)) return;
    exportQueued.add(record);
    record.live = true;
    if (record.sourceModule && record.sourceName && record.sourceName !== "*namespace") {
      for (const source of exportRecords(record.sourceModule, record.sourceName)) {
        queueExport(source);
      }
    }
    if (record.sourceModule && record.sourceName === "*namespace") {
      queueModule(record.sourceModule.file);
    }
    if (record.localSymbol) markReference(record.localSymbol);
    queueSymbol(record.targetSymbol);
    queuePublicContract(record.targetSymbol);
  }

  function queueNamedExport(moduleRecord, name) {
    for (const record of exportRecords(moduleRecord, name)) queueExport(record);
  }

  function importDetails(symbol) {
    if (!symbol || !(symbol.flags & ts.SymbolFlags.Alias)) return null;
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isImportSpecifier(declaration)) {
        const importDeclaration = declaration.parent.parent.parent;
        const specifier = staticText(importDeclaration.moduleSpecifier);
        const moduleRecord = modules.get(
          resolveModule(specifier, declaration.getSourceFile().fileName),
        );
        return {
          moduleRecord,
          name: (declaration.propertyName ?? declaration.name).text,
          namespace: false,
        };
      }
      if (ts.isImportClause(declaration)) {
        const importDeclaration = declaration.parent;
        const specifier = staticText(importDeclaration.moduleSpecifier);
        return {
          moduleRecord: modules.get(resolveModule(specifier, declaration.getSourceFile().fileName)),
          name: "default",
          namespace: false,
        };
      }
      if (ts.isNamespaceImport(declaration)) {
        const importDeclaration = declaration.parent.parent;
        const specifier = staticText(importDeclaration.moduleSpecifier);
        return {
          moduleRecord: modules.get(resolveModule(specifier, declaration.getSourceFile().fileName)),
          name: null,
          namespace: true,
        };
      }
      if (ts.isImportEqualsDeclaration(declaration)) {
        const reference = declaration.moduleReference;
        const specifier = ts.isExternalModuleReference(reference)
          ? staticText(reference.expression)
          : null;
        return {
          moduleRecord: modules.get(resolveModule(specifier, declaration.getSourceFile().fileName)),
          name: null,
          namespace: true,
        };
      }
    }
    return null;
  }

  function markReference(symbol) {
    const imported = importDetails(symbol);
    if (imported?.moduleRecord && imported.name) {
      queueNamedExport(imported.moduleRecord, imported.name);
    }
    queueSymbol(symbol);
  }

  function namespaceImport(symbol, seen = new Set()) {
    if (!symbol || seen.has(symbol)) return null;
    seen.add(symbol);
    const imported = importDetails(symbol);
    if (!imported?.moduleRecord) return null;
    if (imported.namespace) return imported.moduleRecord;
    if (imported.name) {
      for (const record of exportRecords(imported.moduleRecord, imported.name)) {
        if (record.sourceName === "*namespace" && record.sourceModule) return record.sourceModule;
      }
    }
    return null;
  }

  function queueModule(file) {
    const moduleRecord = modules.get(file);
    if (!moduleRecord || moduleRecord.evaluated) return;
    moduleRecord.evaluated = true;
    evaluated.push(moduleRecord);
  }

  function bindingDestructuredExports(call, targetModule) {
    let current = call.parent;
    while (current && (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current))) {
      current = current.parent;
    }
    if (current && ts.isVariableDeclaration(current) && ts.isObjectBindingPattern(current.name)) {
      for (const element of current.name.elements) {
        if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
        const importedName =
          element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text;
        queueNamedExport(targetModule, importedName);
      }
    }
    if (
      current &&
      ts.isPropertyAccessExpression(current) &&
      current.name.text === "then" &&
      ts.isCallExpression(current.parent) &&
      current.parent.expression === current
    ) {
      const callback = current.parent.arguments[0];
      const parameter =
        callback && isFunctionLikeDeclaration(callback) ? callback.parameters[0] : null;
      if (parameter && ts.isObjectBindingPattern(parameter.name)) {
        for (const element of parameter.name.elements) {
          if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
            const importedName =
              element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.name.text;
            queueNamedExport(targetModule, importedName);
          }
        }
      }
    }
  }

  function scanImportType(node) {
    if (!ts.isLiteralTypeNode(node.argument)) return;
    const specifier = staticText(node.argument.literal);
    if (!specifier) return;
    const targetModule = modules.get(resolveModule(specifier, node.getSourceFile().fileName));
    if (!targetModule) return;
    let qualifier = node.qualifier;
    let name = null;
    while (qualifier) {
      if (ts.isIdentifier(qualifier)) {
        name = qualifier.text;
        break;
      }
      name = qualifier.right.text;
      qualifier = qualifier.left;
    }
    if (name) queueNamedExport(targetModule, name);
  }

  function scanNode(node, declarationRoot = node) {
    if (
      node !== declarationRoot &&
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
    ) {
      return;
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isImportTypeNode(node)) scanImportType(node);

    if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isImport || isRequire) {
        const specifier = staticText(node.arguments[0]);
        const targetModule = specifier
          ? modules.get(resolveModule(specifier, node.getSourceFile().fileName))
          : null;
        if (targetModule) {
          queueModule(targetModule.file);
          bindingDestructuredExports(node, targetModule);
        }
      }
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const expression = node.expression;
      if (ts.isIdentifier(expression)) {
        const namespace = namespaceImport(checker.getSymbolAtLocation(expression));
        const name = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : staticText(node.argumentExpression);
        if (namespace && name) queueNamedExport(namespace, name);
      }
    }

    if (ts.isIdentifier(node)) markReference(checker.getSymbolAtLocation(node));
    ts.forEachChild(node, (child) => scanNode(child, declarationRoot));
  }

  function scanDeclaration(symbol) {
    if (symbolScanned.has(symbol)) return;
    symbolScanned.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (
        ts.isSourceFile(declaration) ||
        ts.isImportSpecifier(declaration) ||
        ts.isImportClause(declaration) ||
        ts.isNamespaceImport(declaration) ||
        ts.isImportEqualsDeclaration(declaration) ||
        ts.isExportSpecifier(declaration)
      ) {
        continue;
      }
      scanNode(declaration, declaration);
    }
  }

  function scanContractNode(node) {
    if (ts.isImportTypeNode(node)) scanImportType(node);
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const imported = importDetails(symbol);
      if (imported?.moduleRecord && imported.name) {
        queueNamedExport(imported.moduleRecord, imported.name);
      }
      queueExportsForSymbol(symbol);
      queueSymbol(symbol);
    }
    ts.forEachChild(node, scanContractNode);
  }

  function scanFunctionContract(declaration) {
    for (const typeParameter of declaration.typeParameters ?? []) scanContractNode(typeParameter);
    for (const parameter of declaration.parameters ?? []) {
      if (parameter.type) scanContractNode(parameter.type);
    }
    if (declaration.type) scanContractNode(declaration.type);
  }

  function scanPublicContract(symbol) {
    if (contractScanned.has(symbol)) return;
    contractScanned.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) {
        scanContractNode(declaration);
      } else if (isFunctionLikeDeclaration(declaration)) {
        scanFunctionContract(declaration);
      } else if (ts.isVariableDeclaration(declaration) && declaration.type) {
        scanContractNode(declaration.type);
      } else if (ts.isClassDeclaration(declaration)) {
        for (const typeParameter of declaration.typeParameters ?? []) {
          scanContractNode(typeParameter);
        }
        for (const heritage of declaration.heritageClauses ?? []) scanContractNode(heritage);
        for (const member of declaration.members) {
          if (isFunctionLikeDeclaration(member)) scanFunctionContract(member);
          if (ts.isPropertyDeclaration(member) && member.type) scanContractNode(member.type);
        }
      }
    }
  }

  function evaluate(statement) {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) return;
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) return;
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer) continue;
        const unwrapped = unwrapExpression(declaration.initializer);
        if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) continue;
        scanNode(declaration.initializer, declaration.initializer);
      }
      return;
    }
    scanNode(statement, statement);
  }

  function isRuntimeImport(statement) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) return false;
      return (
        !statement.exportClause ||
        !ts.isNamedExports(statement.exportClause) ||
        statement.exportClause.elements.some((element) => !element.isTypeOnly)
      );
    }
    if (!statement.importClause) return true;
    if (statement.importClause.isTypeOnly) return false;
    if (statement.importClause.name) return true;
    const bindings = statement.importClause.namedBindings;
    if (!bindings || ts.isNamespaceImport(bindings)) return true;
    return bindings.elements.some((element) => !element.isTypeOnly);
  }

  function drain() {
    while (evaluated.length > 0 || symbolWork.length > 0 || contractWork.length > 0) {
      while (evaluated.length > 0) {
        const moduleRecord = evaluated.shift();
        for (const statement of moduleRecord.sourceFile.statements) {
          if (
            (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
            statement.moduleSpecifier &&
            isRuntimeImport(statement)
          ) {
            const specifier = staticText(statement.moduleSpecifier);
            const target = modules.get(resolveModule(specifier, moduleRecord.file));
            if (target) queueModule(target.file);
          }
          evaluate(statement);
        }
      }
      while (symbolWork.length > 0) scanDeclaration(symbolWork.shift());
      while (contractWork.length > 0) scanPublicContract(contractWork.shift());
    }
  }

  for (const moduleRecord of modules.values()) {
    const relative = displayPath(root, moduleRecord.file);
    const appRouteMatch = /^apps\/web\/(?:src\/)?app\/(.+)$/.exec(relative);
    if (appRouteMatch) {
      const base = path.posix.basename(relative).replace(sourcePattern, "");
      if (nextRouteFiles.has(base)) {
        const names =
          base === "route"
            ? nextRouteExports
            : base === "sitemap"
              ? nextSitemapExports
              : nextImageFiles.has(base)
                ? nextImageExports
                : nextCommonExports;
        for (const name of names) queueNamedExport(moduleRecord, name);
        queueModule(moduleRecord.file);
      }
    }
    if (/^apps\/web\/(?:src\/)?(?:proxy|middleware)\.[cm]?[jt]sx?$/.test(relative)) {
      for (const name of ["default", "proxy", "middleware", "config"])
        queueNamedExport(moduleRecord, name);
      queueModule(moduleRecord.file);
    }
    if (/^apps\/web\/(?:src\/)?instrumentation(?:-client)?\.[cm]?[jt]sx?$/.test(relative)) {
      queueNamedExport(moduleRecord, "register");
      queueNamedExport(moduleRecord, "onRequestError");
      queueModule(moduleRecord.file);
    }
    if (
      /^(?:tests|e2e)\//.test(relative) ||
      /^(?:playwright|vitest|eslint|prettier)\.config\.[cm]?[jt]s$/.test(relative) ||
      /(?:^|\/)next\.config\.[cm]?[jt]s$/.test(relative) ||
      /(?:^|\/)postcss\.config\.[cm]?[jt]s$/.test(relative) ||
      /(?:^|\/)prisma\.config\.[cm]?[jt]s$/.test(relative)
    ) {
      queueNamedExport(moduleRecord, "default");
      queueModule(moduleRecord.file);
    }
  }

  for (const [manifestPath, manifest] of manifests) {
    const manifestDirectory = path.dirname(manifestPath);
    const commands = Object.values(manifest.scripts ?? {});
    if (typeof manifest.bin === "string") commands.push(manifest.bin);
    if (manifest.bin && typeof manifest.bin === "object")
      commands.push(...Object.values(manifest.bin));
    for (const command of commands) {
      if (typeof command !== "string") continue;
      for (const match of command.matchAll(/[^\s"'&|;]+\.[cm]?[jt]sx?/g)) {
        const candidate = match[0];
        if (candidate.includes("/.next/") || candidate.includes("node_modules/")) continue;
        const resolved = resolveAsFile(path.resolve(manifestDirectory, candidate));
        if (resolved) queueModule(resolved);
      }
    }
  }

  for (const entrypoint of entrypoints) {
    const resolved = resolveModule(entrypoint.specifier, absolute(root, "package.json"));
    const moduleRecord = modules.get(resolved);
    if (!moduleRecord) continue;
    for (const record of moduleRecord.exports) queueExport(record);
    queueModule(moduleRecord.file);
  }

  for (const entry of packageExports) {
    const resolved = resolveModule(entry.packageName, absolute(root, "package.json"));
    const moduleRecord = modules.get(resolved);
    if (moduleRecord) queueNamedExport(moduleRecord, entry.symbol);
  }

  drain();

  function hasUnconsumedOrigin(record) {
    if (!record.sourceModule || !record.sourceName || record.sourceName === "*namespace") {
      return false;
    }
    return exportRecords(record.sourceModule, record.sourceName).some((source) => !source.live);
  }

  for (const moduleRecord of modules.values()) {
    if (!productionPattern.test(displayPath(root, moduleRecord.file))) continue;
    if (moduleRecord.exports.length === 0 && !moduleRecord.evaluated) {
      diagnostics.push(
        diagnostic(
          root,
          moduleRecord.file,
          moduleRecord.sourceFile,
          moduleRecord.sourceFile,
          "dead-file",
          "unreachable module has no exports and is never evaluated.",
        ),
      );
      continue;
    }
    for (const record of moduleRecord.exports) {
      if (record.live || hasUnconsumedOrigin(record)) continue;
      if (
        record.sourceName &&
        !record.sourceModule &&
        record.sourceSpecifier &&
        /(?:^|\/)generated\//.test(record.sourceSpecifier)
      ) {
        continue;
      }
      const declarationReachable = symbolQueued.has(resolveAlias(record.targetSymbol));
      const finding = declarationReachable ? "unnecessary" : "dead";
      const kinds = exportKinds(record).join("+");
      diagnostics.push(
        diagnostic(
          root,
          moduleRecord.file,
          moduleRecord.sourceFile,
          record.node,
          "dead-export",
          `${finding} ${kinds} export "${record.name}".`,
        ),
      );
    }
  }

  for (const moduleRecord of modules.values()) {
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
        if ((isDynamic || isRequire) && !staticText(node.arguments[0])) {
          diagnostics.push(
            diagnostic(
              root,
              moduleRecord.file,
              moduleRecord.sourceFile,
              node,
              "reflection",
              `${isDynamic ? "dynamic import" : "require"} needs a literal module specifier; no exports were assumed live.`,
            ),
          );
        }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "Object" &&
          ["keys", "values", "entries"].includes(node.expression.name.text) &&
          node.arguments[0] &&
          ts.isIdentifier(node.arguments[0]) &&
          namespaceImport(checker.getSymbolAtLocation(node.arguments[0]))
        ) {
          diagnostics.push(
            diagnostic(
              root,
              moduleRecord.file,
              moduleRecord.sourceFile,
              node,
              "reflection",
              `Object.${node.expression.name.text} over a module namespace cannot be resolved; no exports were assumed live.`,
            ),
          );
        }
      }
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const namespace = namespaceImport(checker.getSymbolAtLocation(node.expression));
        if (namespace && !staticText(node.argumentExpression)) {
          diagnostics.push(
            diagnostic(
              root,
              moduleRecord.file,
              moduleRecord.sourceFile,
              node,
              "reflection",
              "computed namespace access cannot be resolved; no exports were assumed live.",
            ),
          );
        }
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        ts.isIdentifier(unwrapExpression(node.initializer)) &&
        namespaceImport(checker.getSymbolAtLocation(unwrapExpression(node.initializer)))
      ) {
        for (const element of node.name.elements) {
          if (
            ts.isBindingElement(element) &&
            element.propertyName &&
            ts.isComputedPropertyName(element.propertyName)
          ) {
            diagnostics.push(
              diagnostic(
                root,
                moduleRecord.file,
                moduleRecord.sourceFile,
                element,
                "reflection",
                "computed namespace destructuring cannot be resolved; no exports were assumed live.",
              ),
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(moduleRecord.sourceFile);
  }

  const cycles = findCycles(modules);
  const cache = analyzeCache({
    root,
    modules,
    checker,
    symbolQueued,
    resolveAlias,
    diagnostics,
    exceptions,
    checkStaleExceptions,
  });
  const environment = analyzeEnvironment({ root, modules, checker, diagnostics, host, allFiles });

  return {
    diagnostics,
    cycles,
    cache,
    environment,
    stats: {
      files: modules.size,
      exports: [...modules.values()].reduce(
        (count, moduleRecord) => count + moduleRecord.exports.length,
        0,
      ),
      evaluatedModules: [...modules.values()].filter((moduleRecord) => moduleRecord.evaluated)
        .length,
      cycles: cycles.length,
    },
  };
}

function findCycles(modules) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indexes = new Map();
  const lowLinks = new Map();
  const cycles = [];

  function connect(file) {
    indexes.set(file, index);
    lowLinks.set(file, index);
    index += 1;
    stack.push(file);
    onStack.add(file);
    const moduleRecord = modules.get(file);
    for (const dependency of moduleRecord.dependencies) {
      if (!modules.has(dependency)) continue;
      if (!indexes.has(dependency)) {
        connect(dependency);
        lowLinks.set(file, Math.min(lowLinks.get(file), lowLinks.get(dependency)));
      } else if (onStack.has(dependency)) {
        lowLinks.set(file, Math.min(lowLinks.get(file), indexes.get(dependency)));
      }
    }
    if (lowLinks.get(file) !== indexes.get(file)) return;
    const cycle = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      cycle.push(member);
    } while (member !== file);
    if (cycle.length > 1) cycles.push(cycle.sort());
  }

  for (const file of modules.keys()) if (!indexes.has(file)) connect(file);
  return cycles;
}

function templateFamily(node) {
  if (!ts.isTemplateExpression(node)) return null;
  const prefix = node.head.text;
  if (!prefix) return null;
  for (let index = 0; index < node.templateSpans.length; index += 1) {
    const text = node.templateSpans[index].literal.text;
    if (text) return null;
  }
  return `${prefix}*`;
}

function tagFamily(expression) {
  const literal = staticText(expression);
  if (literal !== null) return literal;
  return templateFamily(expression);
}

function mappedTagFamily(expression) {
  if (!ts.isCallExpression(expression)) return null;
  if (!ts.isPropertyAccessExpression(expression.expression)) return null;
  if (expression.expression.name.text !== "map") return null;
  const callback = expression.arguments[0];
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)))
    return null;
  if (!ts.isBlock(callback.body)) return tagFamily(callback.body);
  const returns = callback.body.statements.filter(ts.isReturnStatement);
  return returns.length === 1 && returns[0].expression ? tagFamily(returns[0].expression) : null;
}

const nextCacheFunctions = new Set(["cacheTag", "updateTag", "revalidateTag", "cacheLife"]);

function nextCacheBindings(sourceFile) {
  const direct = new Map();
  const namespaces = new Set();
  const otherImports = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const specifier = staticText(statement.moduleSpecifier);
    const bindings = statement.importClause.namedBindings;
    if (specifier === "next/cache") {
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (nextCacheFunctions.has(imported)) direct.set(element.name.text, imported);
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        namespaces.add(bindings.name.text);
      }
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) otherImports.add(element.name.text);
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      otherImports.add(bindings.name.text);
    }
  }
  return { direct, namespaces, otherImports };
}

function resolveNextCacheCall(call, bindings) {
  if (ts.isIdentifier(call.expression)) {
    const text = call.expression.text;
    if (bindings.direct.has(text)) return bindings.direct.get(text);
    if (!bindings.otherImports.has(text) && nextCacheFunctions.has(text)) return text;
    return null;
  }
  if (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    bindings.namespaces.has(call.expression.expression.text) &&
    nextCacheFunctions.has(call.expression.name.text)
  ) {
    return call.expression.name.text;
  }
  return null;
}

function isValidRevalidateProfile(argument) {
  if (!argument) return false;
  const expr = unwrapExpression(argument);
  if (expr.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isIdentifier(expr) && expr.text === "undefined") return false;
  if (ts.isVoidExpression(expr)) return false;
  const literal = staticText(expr);
  if (literal !== null) return literal.trim().length > 0;
  if (ts.isObjectLiteralExpression(expr)) {
    return expr.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        ((ts.isIdentifier(property.name) && property.name.text === "expire") ||
          staticText(property.name) === "expire") &&
        ts.isNumericLiteral(unwrapExpression(property.initializer)),
    );
  }
  return true;
}

function isDeadNonExportedFunction(owner, checker, symbolQueued, resolveAlias) {
  if (!owner) return false;
  let rootDecl = owner;
  if (
    ts.isVariableDeclaration(owner.parent) &&
    ts.isVariableStatement(owner.parent.parent.parent)
  ) {
    rootDecl = owner.parent.parent.parent;
  }
  if (rootDecl.parent && !ts.isSourceFile(rootDecl.parent)) return false;
  const modifiers = ts.canHaveModifiers(rootDecl) ? ts.getModifiers(rootDecl) : undefined;
  if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return false;
  const nameNode = ts.isVariableStatement(rootDecl)
    ? rootDecl.declarationList.declarations[0]?.name
    : owner.name;
  if (!nameNode || !ts.isIdentifier(nameNode)) return false;
  const symbol = resolveAlias(checker.getSymbolAtLocation(nameNode));
  return Boolean(symbol && !symbolQueued.has(symbol));
}

function analyzeCache({
  root,
  modules,
  checker,
  symbolQueued,
  resolveAlias,
  diagnostics,
  exceptions,
  checkStaleExceptions = false,
}) {
  const cacheCalls = [];
  const invalidationCalls = [];
  const cacheFamilies = new Map();
  const invalidationFamilies = new Map();

  for (const moduleRecord of modules.values()) {
    const relative = displayPath(root, moduleRecord.file);
    if (!productionPattern.test(relative)) continue;
    const fileUsesServer = hasDirective(moduleRecord.sourceFile, "use server");
    const fileUsesCache = hasUseCacheDirective(moduleRecord.sourceFile);
    const isRouteHandler = /^apps\/web\/(?:src\/)?app\/.*\/route\.[cm]?[jt]sx?$/.test(relative);
    const bindings = nextCacheBindings(moduleRecord.sourceFile);
    const useCacheFunctions = new Map();
    const visit = (node) => {
      if (isFunctionLikeDeclaration(node) && node.body && hasUseCacheDirective(node.body)) {
        useCacheFunctions.set(node, { hasTag: false });
      }
      if (ts.isCallExpression(node)) {
        const name = resolveNextCacheCall(node, bindings);
        if (name === "cacheTag" || name === "updateTag" || name === "revalidateTag") {
          const owner = enclosingFunction(node);
          const callsite = `${relative}:${owner ? functionName(owner) : "module"}`;
          const record = { name, node, moduleRecord, callsite, families: [], owner };
          const tagArguments =
            name === "revalidateTag" ? node.arguments.slice(0, 1) : [...node.arguments];
          const deadInvalidator =
            name !== "cacheTag" &&
            isDeadNonExportedFunction(owner, checker, symbolQueued, resolveAlias);
          if (deadInvalidator) {
            diagnostics.push(
              diagnostic(
                root,
                moduleRecord.file,
                moduleRecord.sourceFile,
                node,
                "cache-dead",
                `${name} inside unreachable non-exported function "${functionName(owner)}" does not satisfy cache parity.`,
              ),
            );
          }
          if (tagArguments.length === 0) {
            diagnostics.push(
              diagnostic(
                root,
                moduleRecord.file,
                moduleRecord.sourceFile,
                node,
                "cache",
                `${name} requires a tag.`,
              ),
            );
          }
          for (const argument of tagArguments) {
            const family = ts.isSpreadElement(argument)
              ? mappedTagFamily(argument.expression)
              : tagFamily(argument);
            if (!family) {
              diagnostics.push(
                diagnostic(
                  root,
                  moduleRecord.file,
                  moduleRecord.sourceFile,
                  argument,
                  "cache",
                  `${name} argument cannot be reduced to a literal or prefix:* family.`,
                ),
              );
            } else {
              record.families.push(family);
              if (!deadInvalidator) {
                const registry = name === "cacheTag" ? cacheFamilies : invalidationFamilies;
                if (!registry.has(family)) registry.set(family, []);
                registry.get(family).push(record);
              }
            }
          }
          if (name === "cacheTag") {
            cacheCalls.push(record);
            if (owner && useCacheFunctions.has(owner)) useCacheFunctions.get(owner).hasTag = true;
            if (!fileUsesCache && (!owner || !hasUseCacheDirective(owner.body))) {
              diagnostics.push(
                diagnostic(
                  root,
                  moduleRecord.file,
                  moduleRecord.sourceFile,
                  node,
                  "cache-directive",
                  'cacheTag must be inside a function with a "use cache" prologue.',
                ),
              );
            }
          } else {
            invalidationCalls.push(record);
            const ownerUsesServer = owner?.body && hasDirective(owner.body, "use server");
            if (name === "updateTag" && (isRouteHandler || (!fileUsesServer && !ownerUsesServer))) {
              diagnostics.push(
                diagnostic(
                  root,
                  moduleRecord.file,
                  moduleRecord.sourceFile,
                  node,
                  "cache-directive",
                  'updateTag is only allowed in a Server Action with a "use server" prologue.',
                ),
              );
            }
            if (
              name === "revalidateTag" &&
              (node.arguments.length < 2 || !isValidRevalidateProfile(node.arguments[1]))
            ) {
              diagnostics.push(
                diagnostic(
                  root,
                  moduleRecord.file,
                  moduleRecord.sourceFile,
                  node,
                  "cache-profile",
                  "revalidateTag requires an explicit valid second cache profile argument.",
                ),
              );
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(moduleRecord.sourceFile);
    for (const [fnNode, info] of useCacheFunctions) {
      if (!info.hasTag) {
        diagnostics.push(
          diagnostic(
            root,
            moduleRecord.file,
            moduleRecord.sourceFile,
            fnNode,
            "cache-directive",
            '"use cache" function must declare at least one cacheTag(...).',
          ),
        );
      }
    }
  }

  const matchedExceptions = new Set();
  function exceptionFor(record, family) {
    const matched = exceptions.find((exception) => {
      if (exception.tag !== family || exception.callsite !== record.callsite) return false;
      if (!exception.requiresFamily) return true;
      return cacheCalls.some(
        (candidate) =>
          candidate.callsite === record.callsite &&
          candidate.families.includes(exception.requiresFamily),
      );
    });
    if (matched) matchedExceptions.add(matched);
    return matched;
  }

  for (const [family, records] of cacheFamilies) {
    if (invalidationFamilies.has(family)) continue;
    for (const record of records) {
      const exception = exceptionFor(record, family);
      if (exception) continue;
      diagnostics.push(
        diagnostic(
          root,
          record.moduleRecord.file,
          record.moduleRecord.sourceFile,
          record.node,
          "cache-parity",
          `cache family "${family}" has no updateTag/revalidateTag family; revalidatePath does not count.`,
        ),
      );
    }
  }
  for (const [family, records] of invalidationFamilies) {
    if (cacheFamilies.has(family)) continue;
    for (const record of records) {
      diagnostics.push(
        diagnostic(
          root,
          record.moduleRecord.file,
          record.moduleRecord.sourceFile,
          record.node,
          "cache-parity",
          `invalidation family "${family}" has no cacheTag family; no implicit prefix matching is applied.`,
        ),
      );
    }
  }
  if (checkStaleExceptions) {
    for (const exception of exceptions) {
      if (matchedExceptions.has(exception)) continue;
      diagnostics.push({
        category: "cache-exception-stale",
        file: "scripts/lib/ast-graph.mjs",
        line: 1,
        message: `scripts/lib/ast-graph.mjs:1: stale cache exception "${exception.tag}" at "${exception.callsite}" no longer matches an uninvalidated cacheTag.`,
      });
    }
  }

  return {
    cacheCalls: cacheCalls.length,
    invalidationCalls: invalidationCalls.length,
    cacheFamilies: [...cacheFamilies.keys()].sort(),
    invalidationFamilies: [...invalidationFamilies.keys()].sort(),
  };
}

function isProcessReference(node) {
  if (ts.isIdentifier(node) && node.text === "process") return true;
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "globalThis" &&
    node.name.text === "process"
  ) {
    return true;
  }
  return false;
}

function isProcessEnv(node) {
  if (
    ts.isPropertyAccessExpression(node) &&
    isProcessReference(node.expression) &&
    node.name.text === "env"
  ) {
    return true;
  }
  if (
    ts.isElementAccessExpression(node) &&
    isProcessReference(node.expression) &&
    staticText(node.argumentExpression) === "env"
  ) {
    return true;
  }
  return false;
}

function resolveCallableDeclaration(symbol) {
  for (const declaration of symbol?.declarations ?? []) {
    if (isFunctionLikeDeclaration(declaration)) return declaration;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const unwrapped = unwrapExpression(declaration.initializer);
      if (isFunctionLikeDeclaration(unwrapped)) return unwrapped;
    }
  }
  return null;
}

function functionReturnsEnvironment(declaration, isEnvironmentExpression) {
  if (!declaration?.body) return false;
  if (!ts.isBlock(declaration.body)) return isEnvironmentExpression(declaration.body);
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (isFunctionLikeDeclaration(node) && node !== declaration) return;
    if (ts.isReturnStatement(node) && node.expression && isEnvironmentExpression(node.expression)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  return found;
}

function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAwaitExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function environmentKeyName(element) {
  if (!element.propertyName) return ts.isIdentifier(element.name) ? element.name.text : null;
  return (
    staticText(element.propertyName) ??
    (ts.isIdentifier(element.propertyName) ? element.propertyName.text : null)
  );
}

function isPureWrite(node) {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && parent.left === node) {
    return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  }
  return ts.isDeleteExpression(parent);
}

function analyzeEnvironment({ root, modules, checker, diagnostics, host, allFiles }) {
  const environmentSymbols = new Set();
  const environmentParameters = new Set();
  const environmentReturningFunctions = new Set();
  const declarations = [];
  const assignments = [];
  const calls = [];
  const functionDeclarations = [];

  for (const moduleRecord of modules.values()) {
    for (const statement of moduleRecord.sourceFile.statements) {
      if (ts.isImportDeclaration(statement) && statement.importClause) {
        const specifier = staticText(statement.moduleSpecifier);
        if (specifier === "node:process" || specifier === "process") {
          const bindings = statement.importClause.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              if ((element.propertyName ?? element.name).text === "env") {
                const symbol = checker.getSymbolAtLocation(element.name);
                if (symbol) environmentSymbols.add(symbol);
              }
            }
          }
        }
      }
    }
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
        declarations.push(node);
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        assignments.push(node);
      }
      if (ts.isCallExpression(node)) calls.push(node);
      if (isFunctionLikeDeclaration(node)) functionDeclarations.push(node);
      ts.forEachChild(node, visit);
    };
    visit(moduleRecord.sourceFile);
  }

  function isEnvironmentExpression(expression) {
    const node = unwrapExpression(expression);
    if (!node) return false;
    if (isProcessEnv(node)) return true;
    if (ts.isIdentifier(node)) return environmentSymbols.has(checker.getSymbolAtLocation(node));
    if (ts.isCallExpression(node)) {
      let symbol = checker.getSymbolAtLocation(node.expression);
      if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const decl = resolveCallableDeclaration(symbol);
      if (decl && environmentReturningFunctions.has(decl)) return true;
    }
    if (ts.isBinaryExpression(node)) {
      return isEnvironmentExpression(node.left) || isEnvironmentExpression(node.right);
    }
    if (ts.isConditionalExpression(node)) {
      return isEnvironmentExpression(node.whenTrue) || isEnvironmentExpression(node.whenFalse);
    }
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.some(
        (property) =>
          ts.isSpreadAssignment(property) && isEnvironmentExpression(property.expression),
      );
    }
    return false;
  }

  function addEnvironmentSymbol(name) {
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol) environmentSymbols.add(symbol);
  }

  function markDeclaration(declaration) {
    if (declaration.name && ts.isIdentifier(declaration.name)) {
      addEnvironmentSymbol(declaration.name);
    } else if (ts.isParameter(declaration) && ts.isObjectBindingPattern(declaration.name)) {
      environmentParameters.add(declaration);
    }
  }

  let changed = true;
  while (changed) {
    const before =
      environmentSymbols.size + environmentParameters.size + environmentReturningFunctions.size;
    for (const declaration of declarations) {
      if (declaration.initializer && isEnvironmentExpression(declaration.initializer)) {
        markDeclaration(declaration);
      }
      if (
        ts.isVariableDeclaration(declaration) &&
        ts.isObjectBindingPattern(declaration.name) &&
        declaration.initializer &&
        isProcessReference(unwrapExpression(declaration.initializer))
      ) {
        for (const element of declaration.name.elements) {
          if (!ts.isBindingElement(element)) continue;
          if (environmentKeyName(element) === "env" && ts.isIdentifier(element.name)) {
            addEnvironmentSymbol(element.name);
          }
        }
      }
    }
    for (const assignment of assignments) {
      if (isEnvironmentExpression(assignment.right)) {
        addEnvironmentSymbol(assignment.left);
      }
    }
    for (const fnDecl of functionDeclarations) {
      if (
        !environmentReturningFunctions.has(fnDecl) &&
        functionReturnsEnvironment(fnDecl, isEnvironmentExpression)
      ) {
        environmentReturningFunctions.add(fnDecl);
      }
    }
    for (const call of calls) {
      let symbol = checker.getSymbolAtLocation(call.expression);
      if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const declaration = resolveCallableDeclaration(symbol);
      if (!declaration) continue;
      call.arguments.forEach((argument, index) => {
        const parameter = declaration.parameters[index];
        if (!parameter) return;
        const parameterName = ts.isIdentifier(parameter.name) ? parameter.name.text : null;
        const directEnvironment = isEnvironmentExpression(argument);
        const environmentArgument =
          directEnvironment ||
          (parameterName !== null &&
            ts.isObjectLiteralExpression(unwrapExpression(argument)) &&
            /^(?:env|environment)$/i.test(parameterName));
        if (environmentArgument && ts.isIdentifier(parameter.name)) {
          addEnvironmentSymbol(parameter.name);
        } else if (directEnvironment && ts.isObjectBindingPattern(parameter.name)) {
          environmentParameters.add(parameter);
        }
      });
    }
    changed =
      environmentSymbols.size + environmentParameters.size + environmentReturningFunctions.size !==
      before;
  }

  const reads = new Map();
  const dynamicDiagnostics = new Set();

  function addRead(key, moduleRecord, node) {
    if (!reads.has(key)) reads.set(key, []);
    reads.get(key).push({
      file: displayPath(root, moduleRecord.file),
      line:
        moduleRecord.sourceFile.getLineAndCharacterOfPosition(
          node.getStart(moduleRecord.sourceFile),
        ).line + 1,
    });
  }

  function staticValues(node, seen = new Set()) {
    const expression = unwrapExpression(node);
    const literal = staticText(expression);
    if (literal !== null) return [literal];
    if (ts.isTemplateExpression(expression)) {
      const parts = [expression.head.text];
      for (const span of expression.templateSpans) {
        const values = staticValues(span.expression, seen);
        if (values.length !== 1) return [];
        parts.push(values[0], span.literal.text);
      }
      return [parts.join("")];
    }
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = staticValues(expression.left, seen);
      const right = staticValues(expression.right, seen);
      if (left.length && right.length) return left.flatMap((a) => right.map((b) => a + b));
      return [];
    }
    if (ts.isArrayLiteralExpression(expression)) {
      return expression.elements.flatMap((element) =>
        staticValues(ts.isSpreadElement(element) ? element.expression : element, new Set(seen)),
      );
    }
    if (ts.isConditionalExpression(expression)) {
      return [
        ...staticValues(expression.whenTrue, new Set(seen)),
        ...staticValues(expression.whenFalse, new Set(seen)),
      ];
    }
    if (!ts.isIdentifier(expression)) return [];
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol || seen.has(symbol)) return [];
    seen.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration)) {
        if (declaration.initializer) return staticValues(declaration.initializer, seen);
        if (ts.isForOfStatement(declaration.parent.parent)) {
          return staticValues(declaration.parent.parent.expression, seen);
        }
      }
    }
    return [];
  }

  function keysForElement(node, moduleRecord) {
    const argument = node.argumentExpression;
    const literal = staticText(argument);
    if (literal !== null) return [literal];
    if (ts.isTemplateExpression(argument)) {
      const prefix = argument.head.text;
      if (
        (prefix === "INTEGRATION_CREDENTIAL_KEYS_" ||
          prefix === "INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_") &&
        argument.templateSpans.length === 1 &&
        argument.templateSpans[0].literal.text === ""
      ) {
        return ["LOCAL", "STG", "PRD"].map((environment) => `${prefix}${environment}`);
      }
    }
    const values = staticValues(argument);
    if (values.length > 0) return values;
    const key = `${moduleRecord.file}:${node.pos}`;
    if (!dynamicDiagnostics.has(key)) {
      dynamicDiagnostics.add(key);
      diagnostics.push(
        diagnostic(
          root,
          moduleRecord.file,
          moduleRecord.sourceFile,
          node,
          "environment-dynamic",
          "environment key cannot be statically resolved.",
        ),
      );
    }
    return [];
  }

  for (const moduleRecord of modules.values()) {
    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node) && !isProcessEnv(node)) {
        if (isEnvironmentExpression(node.expression) && !isPureWrite(node)) {
          addRead(node.name.text, moduleRecord, node);
        }
      } else if (ts.isElementAccessExpression(node)) {
        if (isEnvironmentExpression(node.expression) && !isPureWrite(node)) {
          for (const key of keysForElement(node, moduleRecord)) addRead(key, moduleRecord, node);
        }
      } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
        if (node.initializer && isEnvironmentExpression(node.initializer)) {
          for (const element of node.name.elements) {
            if (!ts.isBindingElement(element)) continue;
            const key = environmentKeyName(element);
            if (key) addRead(key, moduleRecord, element);
          }
        }
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
        isEnvironmentExpression(node.right)
      ) {
        const literal = staticText(node.left);
        if (literal !== null) addRead(literal, moduleRecord, node);
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        ((node.expression.expression.text === "Object" && node.expression.name.text === "hasOwn") ||
          (node.expression.expression.text === "Reflect" && node.expression.name.text === "get")) &&
        node.arguments.length >= 2 &&
        isEnvironmentExpression(node.arguments[0])
      ) {
        const literal = staticText(node.arguments[1]);
        if (literal !== null) addRead(literal, moduleRecord, node);
      } else if (
        ts.isParameter(node) &&
        ts.isObjectBindingPattern(node.name) &&
        environmentParameters.has(node)
      ) {
        for (const element of node.name.elements) {
          if (!ts.isBindingElement(element)) continue;
          const key = environmentKeyName(element);
          if (key) addRead(key, moduleRecord, element);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(moduleRecord.sourceFile);
  }

  let envExample = "";
  if (allFiles.includes(".env.example")) envExample = host.readFile(".env.example");
  const declared = new Map();
  envExample.split(/\r\n|\r|\n/).forEach((line, index) => {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
    if (match && !declared.has(match[1])) declared.set(match[1], index + 1);
  });

  for (const [key, locations] of reads) {
    if (declared.has(key) || runtimePlatformEnvironmentKeys.has(key)) {
      continue;
    }
    const disallowed = locations.find((location) => {
      const isProduction = productionPattern.test(location.file);
      if (isProduction) return true;
      return !toolingPlatformEnvironmentKeys.has(key) && !documentedTestEnvironmentKeys.has(key);
    });
    if (!disallowed) continue;
    diagnostics.push({
      category: "environment-missing",
      file: disallowed.file,
      line: disallowed.line,
      message: `${disallowed.file}:${disallowed.line}: environment key "${key}" is read but not declared in .env.example.`,
    });
  }
  const nonTestReads = new Set(
    [...reads.entries()]
      .filter(([, locations]) =>
        locations.some((location) => !/^(?:tests|e2e)\//.test(location.file)),
      )
      .map(([key]) => key),
  );
  for (const [key, line] of declared) {
    if (nonTestReads.has(key)) continue;
    diagnostics.push({
      category: "environment-orphan",
      file: ".env.example",
      line,
      message: `.env.example:${line}: declared environment key "${key}" has no static read in production, scripts or operational CLIs.`,
    });
  }

  return {
    reads: [...reads.keys()].sort(),
    declared: [...declared.keys()].sort(),
    platform: [...platformEnvironmentKeys].sort(),
    documentedTests: [...documentedTestEnvironmentKeys].sort(),
  };
}
