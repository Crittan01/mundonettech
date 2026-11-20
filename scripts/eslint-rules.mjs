const untrustedIpHeaders = new Set([
  "cf-connecting-ip",
  "forwarded",
  "true-client-ip",
  "x-forwarded-for",
  "x-real-ip",
]);

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
        if (
          node.callee.type === "MemberExpression" &&
          !node.callee.computed &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.name === "get"
        ) {
          const [argument] = node.arguments;

          if (
            argument?.type === "Literal" &&
            typeof argument.value === "string" &&
            untrustedIpHeaders.has(argument.value.toLowerCase())
          ) {
            context.report({ node, messageId: "untrustedIp" });
          }
        }
      },
      MemberExpression(node) {
        if (
          !node.computed &&
          node.object.type === "Identifier" &&
          ["req", "request"].includes(node.object.name) &&
          node.property.type === "Identifier" &&
          node.property.name === "ip"
        ) {
          context.report({ node, messageId: "untrustedIp" });
        }
      },
    };
  },
};

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
    const filename = context.filename.replaceAll("\\", "/");
    const isSafeAdapter = filename.endsWith("/packages/media/src/sharp-safe.ts");

    function check(node, source) {
      if (
        !isSafeAdapter &&
        typeof source === "string" &&
        (source === "sharp" || source.startsWith("sharp/"))
      ) {
        context.report({ node, messageId: "unsafeSharp" });
      }
    }

    return {
      ImportDeclaration(node) {
        check(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        check(node, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type === "Literal") check(node, node.source.value);
      },
      CallExpression(node) {
        const [argument] = node.arguments;
        const isDynamicImport = node.expression?.type === "Import";
        const isRequire = node.callee.type === "Identifier" && node.callee.name === "require";

        if ((isDynamicImport || isRequire) && argument?.type === "Literal") {
          check(node, argument.value);
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
