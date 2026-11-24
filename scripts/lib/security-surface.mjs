import path from "node:path";

import ts from "typescript";

const httpMethods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const sourcePattern = /\.(?:ts|tsx)$/;
const routePattern = /^apps\/web\/(?:src\/)?app\/.*\/route\.ts$/;

function slash(value) {
  return value.replaceAll("\\", "/");
}

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function isFunctionValue(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node)
  );
}

function functionName(node, fallback) {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node)) &&
    node.name
  ) {
    if (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)) return node.name.text;
  }
  return fallback;
}

function hasUseServerPrologue(node) {
  const statements = ts.isSourceFile(node)
    ? node.statements
    : node.body && ts.isBlock(node.body)
      ? node.body.statements
      : [];
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === "use server") return true;
  }
  return false;
}

function lineAt(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function diagnostic(file, line, category, message) {
  return { file, line, category, message: `${file}:${line}: ${message}` };
}

function hasEnabledOption(call, optionName) {
  const options = call.arguments[0];
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    const name =
      ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ? property.name.text
        : null;
    return name === optionName && property.initializer.kind === ts.SyntaxKind.TrueKeyword;
  });
}

function collectCallNames(node, localFunctions, visiting = new Set(), calls = new Set()) {
  function visit(current) {
    if (ts.isCallExpression(current)) {
      if (ts.isIdentifier(current.expression)) {
        const name = current.expression.text;
        calls.add(name);
        if (name === "getAdminSession" && hasEnabledOption(current, "requireRecentMfa")) {
          calls.add("getAdminSession(requireRecentMfa:true)");
        }
        const local = localFunctions.get(name);
        if (local && !visiting.has(name)) {
          visiting.add(name);
          visit(local);
          visiting.delete(name);
        }
      } else if (ts.isPropertyAccessExpression(current.expression)) {
        const propertyName = current.expression.name.text;
        if (propertyName !== "getAdminSession" && propertyName !== "requireRecentMfa") {
          calls.add(propertyName);
        }
      }
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return calls;
}

function parseSource(root, relative, text) {
  const absolute = path.resolve(root, relative);
  return ts.createSourceFile(
    absolute,
    text,
    { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext },
    true,
    relative.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function moduleFunctions(sourceFile) {
  const functions = new Map();
  const exports = new Map();

  function register(name, node, exported, exportName = name) {
    if (!name || !node.body) return;
    functions.set(name, node);
    if (exported) exports.set(exportName, { name, node });
  }

  for (const statement of sourceFile.statements) {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text;
      const defaultExport = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
      register(name, statement, exported, defaultExport ? "default" : name);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        if (isFunctionValue(declaration.initializer)) {
          register(declaration.name.text, declaration.initializer, exported);
        }
      }
    }
  }

  for (const statement of sourceFile.statements) {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    if (ts.isVariableStatement(statement) && exported) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          const exportName = declaration.name.text;
          if (exports.has(exportName)) continue;
          const initializer = declaration.initializer;
          if (initializer && ts.isIdentifier(initializer)) {
            const target = functions.get(initializer.text);
            if (target) {
              exports.set(exportName, { name: initializer.text, node: target });
              continue;
            }
          }
          exports.set(exportName, null);
        } else if (
          ts.isObjectBindingPattern(declaration.name) ||
          ts.isArrayBindingPattern(declaration.name)
        ) {
          for (const element of declaration.name.elements) {
            if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
              exports.set(element.name.text, null);
            }
          }
        }
      }
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          exports.set(element.name.text, null);
        }
      } else {
        exports.set("*", null);
      }
      continue;
    }
    if (ts.isExportDeclaration(statement) && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const localName = element.propertyName?.text ?? element.name.text;
        const node = functions.get(localName);
        exports.set(element.name.text, node ? { name: localName, node } : null);
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      const expression = statement.expression;
      if (ts.isIdentifier(expression)) {
        const node = functions.get(expression.text);
        exports.set("default", node ? { name: expression.text, node } : null);
      } else if (isFunctionValue(expression)) {
        const name = functionName(expression, "default");
        functions.set(name, expression);
        exports.set("default", { name, node: expression });
      } else {
        exports.set("default", null);
      }
    }
  }
  return { functions, exports };
}

function inlineServerActions(sourceFile) {
  const actions = [];
  function visit(node) {
    if (isFunctionValue(node) && hasUseServerPrologue(node)) {
      const name = functionName(node, "anonymous");
      actions.push({ exportName: `inline:${name}`, name, node });
    }
    ts.forEachChild(node, visit);
  }
  if (!hasUseServerPrologue(sourceFile)) visit(sourceFile);
  return actions;
}

export function auditSecuritySurface(host, manifest) {
  const root = host.root ?? process.cwd();
  const diagnostics = [];
  const actual = new Map();
  const files = host.listFiles().map(slash).sort();

  for (const relative of files) {
    if (!sourcePattern.test(relative) || !relative.startsWith("apps/web/")) continue;
    if (relative.includes("/node_modules/") || relative.includes("/.next/")) continue;
    const isRoute = routePattern.test(relative);
    const isProxy = relative === "apps/web/proxy.ts" || relative === "apps/web/src/proxy.ts";
    const text = host.readFile(relative);
    const sourceFile = parseSource(root, relative, text);
    const fileUsesServer = hasUseServerPrologue(sourceFile);
    if (
      !isRoute &&
      !isProxy &&
      !fileUsesServer &&
      !text.includes('"use server"') &&
      !text.includes("'use server'")
    ) {
      continue;
    }
    const { functions, exports } = moduleFunctions(sourceFile);
    const entries = new Map();

    if (isRoute) {
      for (const method of httpMethods) {
        if (exports.has(method)) entries.set(method, exports.get(method));
      }
    } else if (isProxy) {
      if (exports.has("proxy")) entries.set("proxy", exports.get("proxy"));
      if (exports.has("default")) entries.set("default", exports.get("default"));
    } else if (fileUsesServer) {
      for (const [name, entry] of exports) entries.set(name, entry);
    }
    for (const action of inlineServerActions(sourceFile)) {
      if (entries.has(action.exportName)) {
        diagnostics.push(
          diagnostic(
            relative,
            lineAt(sourceFile, action.node),
            "security-surface-resolution",
            `Duplicate inline Server Action name "${action.exportName}"; use uniquely named functions so every entry has its own security contract.`,
          ),
        );
      }
      entries.set(action.exportName, { name: action.name, node: action.node });
    }
    if (entries.size > 0 || isRoute || isProxy || fileUsesServer) {
      actual.set(relative, { sourceFile, functions, entries });
    }
  }

  let actionCount = 0;
  let routeHandlerCount = 0;
  let proxyHandlerCount = 0;
  for (const [relative, record] of actual) {
    const expected = manifest[relative] ?? {};
    if (record.entries.size === 0) {
      diagnostics.push(
        diagnostic(
          relative,
          1,
          "security-surface-inventory",
          "Audited module has no resolvable Server Action, Route Handler or proxy export.",
        ),
      );
    }
    for (const [exportName, entry] of record.entries) {
      const line = entry?.node ? lineAt(record.sourceFile, entry.node) : 1;
      const routeHandler = routePattern.test(relative);
      const proxyHandler = relative.endsWith("/proxy.ts");
      if (routeHandler) routeHandlerCount += 1;
      else if (proxyHandler) proxyHandlerCount += 1;
      else actionCount += 1;
      const requirement = expected[exportName];
      if (!requirement) {
        diagnostics.push(
          diagnostic(
            relative,
            line,
            "security-surface-inventory",
            `Unreviewed ${routeHandler ? "route handler" : "server entry"} "${exportName}"; add its explicit security contract to the A2 manifest.`,
          ),
        );
        continue;
      }
      if (!entry?.node) {
        diagnostics.push(
          diagnostic(
            relative,
            line,
            "security-surface-resolution",
            `Cannot resolve the implementation of "${exportName}"; keep the security boundary auditable without barrel indirection.`,
          ),
        );
        continue;
      }
      if (
        !routeHandler &&
        !relative.endsWith("/proxy.ts") &&
        !entry.node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      ) {
        diagnostics.push(
          diagnostic(
            relative,
            line,
            "security-surface-action",
            `Server Action "${exportName}" must be asynchronous.`,
          ),
        );
      }
      const calls = collectCallNames(entry.node, record.functions);
      const requiredCalls = new Set(
        Array.isArray(requirement) ? requirement : (requirement.calls ?? []),
      );
      const adminAuthenticationFlow =
        relative === "apps/web/lib/actions/admin-auth.ts" ||
        relative === "apps/web/lib/actions/admin-invitation.ts";
      const recentMfaOptOut = !Array.isArray(requirement) && requirement.recentMfa === false;
      const requiresRecentMfa =
        ((relative.startsWith("apps/web/lib/actions/admin-") && relative.endsWith(".ts")) ||
          (relative.startsWith("apps/web/app/admin/") && !routeHandler)) &&
        !adminAuthenticationFlow &&
        !recentMfaOptOut;
      if (requiresRecentMfa) requiredCalls.add("getAdminSession");
      if (
        requiresRecentMfa &&
        !calls.has("requireRecentMfa") &&
        !calls.has("getAdminSession(requireRecentMfa:true)")
      ) {
        diagnostics.push(
          diagnostic(
            relative,
            line,
            "security-surface-control",
            `"${exportName}" must require recent MFA through requireRecentMfa() or getAdminSession({ requireRecentMfa: true }).`,
          ),
        );
      }
      for (const requiredCall of requiredCalls) {
        if (!calls.has(requiredCall)) {
          diagnostics.push(
            diagnostic(
              relative,
              line,
              "security-surface-control",
              `"${exportName}" does not call required security control "${requiredCall}" directly or through a reviewed local wrapper.`,
            ),
          );
        }
      }
    }
    for (const exportName of Object.keys(expected)) {
      if (!record.entries.has(exportName)) {
        diagnostics.push(
          diagnostic(
            relative,
            1,
            "security-surface-inventory",
            `Stale security contract "${exportName}"; update the manifest when the audited surface changes.`,
          ),
        );
      }
    }
  }

  for (const relative of Object.keys(manifest)) {
    if (!actual.has(relative)) {
      diagnostics.push(
        diagnostic(
          relative,
          1,
          "security-surface-inventory",
          "Manifest entry does not match an audited Server Action, Route Handler or proxy module.",
        ),
      );
    }
  }

  return {
    diagnostics,
    stats: {
      files: actual.size,
      serverActions: actionCount,
      routeHandlers: routeHandlerCount,
      proxyHandlers: proxyHandlerCount,
    },
  };
}

export function createVirtualSecurityHost(files) {
  return {
    root: "/virtual",
    listFiles() {
      return Object.keys(files);
    },
    readFile(file) {
      const value = files[file];
      if (typeof value !== "string") throw new Error(`Unknown virtual file: ${file}`);
      return value;
    },
  };
}
