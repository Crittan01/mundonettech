import path from "node:path";

const untrustedIpHeaders = new Set([
  "cf-connecting-ip",
  "fastly-client-ip",
  "forwarded",
  "true-client-ip",
  "x-client-ip",
  "x-cluster-client-ip",
  "x-forwarded-for",
  "x-real-ip",
]);

const requestIdentifierNames = new Set(["req", "request"]);

function getStaticString(node) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value?.cooked ?? node.quasis[0]?.value?.raw ?? null;
  }
  return null;
}

function getPropertyName(memberNode) {
  if (!memberNode.computed && memberNode.property.type === "Identifier") {
    return memberNode.property.name;
  }
  if (memberNode.computed) {
    return getStaticString(memberNode.property);
  }
  return null;
}

const clientIp = {
  meta: {
    type: "problem",
    docs: {
      description: "Require a verified platform adapter instead of trusting client IP headers.",
    },
    schema: [],
    messages: {
      untrustedIp: "Do not read client IPs directly; use the verified platform adapter.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === "MemberExpression" && getPropertyName(node.callee) === "get") {
          const headerName = getStaticString(node.arguments[0]);
          if (headerName && untrustedIpHeaders.has(headerName.toLowerCase())) {
            context.report({ node, messageId: "untrustedIp" });
          }
        }
      },
      MemberExpression(node) {
        const propertyName = getPropertyName(node);
        if (!propertyName) return;

        if (node.computed && untrustedIpHeaders.has(propertyName.toLowerCase())) {
          context.report({ node, messageId: "untrustedIp" });
          return;
        }

        if (
          node.object.type === "Identifier" &&
          requestIdentifierNames.has(node.object.name) &&
          propertyName === "ip"
        ) {
          context.report({ node, messageId: "untrustedIp" });
        }
      },
      VariableDeclarator(node) {
        if (node.id.type !== "ObjectPattern" || !node.init) return;

        const isRequestInit =
          node.init.type === "Identifier" && requestIdentifierNames.has(node.init.name);

        for (const prop of node.id.properties) {
          if (prop.type !== "Property") continue;
          const keyName =
            !prop.computed && prop.key.type === "Identifier"
              ? prop.key.name
              : getStaticString(prop.key);
          if (!keyName) continue;

          if (
            untrustedIpHeaders.has(keyName.toLowerCase()) ||
            (isRequestInit && keyName === "ip")
          ) {
            context.report({ node: prop, messageId: "untrustedIp" });
          }
        }
      },
    };
  },
};

function isSharpSource(source) {
  if (typeof source !== "string") return false;
  const normalized = source.replaceAll("\\", "/");
  return (
    normalized === "sharp" ||
    normalized.startsWith("sharp/") ||
    /(?:^|\/)node_modules\/sharp(?:\/|$)/.test(normalized)
  );
}

const sharpSafe = {
  meta: {
    type: "problem",
    docs: {
      description: "Restrict direct sharp access to the hardened media adapter.",
    },
    schema: [],
    messages: {
      unsafeSharp: "Import sharp only inside packages/media/src/sharp-safe.ts.",
    },
  },
  create(context) {
    const cwd = context.cwd ?? process.cwd();
    const relativePath = path.relative(cwd, context.filename).replaceAll("\\", "/");
    const isSafeAdapter = relativePath === "packages/media/src/sharp-safe.ts";

    function check(node, source) {
      if (!isSafeAdapter && isSharpSource(source)) {
        context.report({ node, messageId: "unsafeSharp" });
      }
    }

    return {
      ImportDeclaration(node) {
        check(node, getStaticString(node.source));
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, getStaticString(node.source));
      },
      ExportAllDeclaration(node) {
        check(node, getStaticString(node.source));
      },
      ImportExpression(node) {
        check(node, getStaticString(node.source));
      },
      CallExpression(node) {
        const isRequire = node.callee.type === "Identifier" && node.callee.name === "require";
        if (isRequire) {
          check(node, getStaticString(node.arguments[0]));
        }
      },
    };
  },
};

const foundationRules = {
  rules: {
    "client-ip": clientIp,
    "sharp-safe": sharpSafe,
  },
};

export default foundationRules;
