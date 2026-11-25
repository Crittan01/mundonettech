import assert from "node:assert/strict";
import test from "node:test";

import {
  auditSecuritySurface,
  createVirtualSecurityHost,
} from "../scripts/lib/security-surface.mjs";

const actionFile = "apps/web/lib/actions/example.ts";

function audit(files, manifest) {
  return auditSecuritySurface(createVirtualSecurityHost(files), manifest);
}

function categories(result) {
  return result.diagnostics.map((issue) => issue.category);
}

test("accepts an exhaustively declared surface and follows nested local security wrappers", () => {
  const result = audit(
    {
      [actionFile]: `
        "use server";
        async function authenticate() { requireRecentMfa(); }
        async function authorize() { authenticate(); writeAdminActionLog(); }
        export async function updateRecord() { authorize(); }
      `,
      "apps/web/app/api/example/route.ts": `
        export const dynamic = "force-dynamic";
        export const GET = async () => {
          verifyBearerToken();
          return Response.json({ status: "ok" });
        };
      `,
      "apps/web/proxy.ts": `
        export async function proxy() { applySecurityHeaders(); }
        export const config = { matcher: "/:path*" };
      `,
      "apps/web/app/example/page.tsx": `
        async function submitInline() {
          "use server";
          requireCustomerSession();
        }
        export default function Page() { return submitInline; }
      `,
    },
    {
      [actionFile]: {
        updateRecord: { calls: ["requireRecentMfa", "writeAdminActionLog"] },
      },
      "apps/web/app/api/example/route.ts": {
        GET: { calls: ["verifyBearerToken"] },
      },
      "apps/web/proxy.ts": {
        proxy: { calls: ["applySecurityHeaders"] },
      },
      "apps/web/app/example/page.tsx": {
        "inline:submitInline": { calls: ["requireCustomerSession"] },
      },
    },
  );

  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.stats.files, 4);
  assert.equal(result.stats.serverActions, 2);
  assert.equal(result.stats.routeHandlers, 1);
  assert.equal(result.stats.proxyHandlers, 1);
});

test("fails closed for unreviewed, stale and unresolved exports", () => {
  const result = audit(
    {
      [actionFile]: `
        "use server";
        export async function reviewed() {}
        export async function newAction() {}
        export { missing } from "./elsewhere.js";
      `,
    },
    {
      [actionFile]: {
        reviewed: { calls: [] },
        missing: { calls: [] },
        removedAction: { calls: [] },
      },
      "apps/web/lib/actions/removed.ts": {
        oldAction: { calls: [] },
      },
    },
  );

  assert.equal(
    categories(result).filter((value) => value === "security-surface-inventory").length,
    3,
  );
  assert.equal(
    categories(result).filter((value) => value === "security-surface-resolution").length,
    1,
  );
  assert.match(result.diagnostics.map((issue) => issue.message).join("\n"), /newAction/);
  assert.match(result.diagnostics.map((issue) => issue.message).join("\n"), /removedAction/);
});

test("does not let one export satisfy another export's security contract", () => {
  const result = audit(
    {
      [actionFile]: `
        "use server";
        async function secure() { requireAdminSession(); }
        export async function securedAction() { secure(); }
        export async function unsafeAction() { return null; }
      `,
    },
    {
      [actionFile]: {
        securedAction: { calls: ["requireAdminSession"] },
        unsafeAction: { calls: ["requireAdminSession"] },
      },
    },
  );

  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].category, "security-surface-control");
  assert.match(result.diagnostics[0].message, /unsafeAction/);
});

test("rejects synchronous server actions and supports async arrow exports", () => {
  const result = audit(
    {
      [actionFile]: `
        "use server";
        export function unsafeSyncAction() {}
        export const safeAction = async () => { requireCustomerSession(); };
      `,
    },
    {
      [actionFile]: {
        unsafeSyncAction: { calls: [] },
        safeAction: { calls: ["requireCustomerSession"] },
      },
    },
  );

  assert.deepEqual(categories(result), ["security-surface-action"]);
});

test("does not treat directive-looking strings outside the prologue as server actions", () => {
  const result = audit(
    {
      "apps/web/lib/not-an-action.ts": `
        const example = "use server";
        export function ordinaryHelper() { return example; }
      `,
      "apps/web/lib/actions/also-not-an-action.ts": `
        const before = true;
        "use server";
        export async function notAPrologue() { return before; }
      `,
    },
    {},
  );

  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.stats.files, 0);
});

test("rejects empty entry modules instead of treating them as reviewed no-ops", () => {
  const result = audit(
    {
      "apps/web/lib/actions/empty.ts": '"use server"; const internal = true;',
      "apps/web/app/api/empty/route.ts": 'export const dynamic = "force-dynamic";',
    },
    {
      "apps/web/lib/actions/empty.ts": {},
      "apps/web/app/api/empty/route.ts": {},
    },
  );

  assert.equal(result.diagnostics.length, 2);
  assert.deepEqual(categories(result), [
    "security-surface-inventory",
    "security-surface-inventory",
  ]);
});

test("rejects duplicate inline action names and audits class method directives", () => {
  const result = audit(
    {
      "apps/web/app/duplicate/page.tsx": `
        async function submit() { "use server"; requireCustomerSession(); }
        async function outer() {
          async function submit() { "use server"; requireCustomerSession(); }
          return submit;
        }
        class InlineActions {
          async persist() { "use server"; requireRecentMfa(); }
        }
        void outer;
        void InlineActions;
      `,
    },
    {
      "apps/web/app/duplicate/page.tsx": {
        "inline:submit": { calls: ["requireCustomerSession"] },
        "inline:persist": { calls: ["requireRecentMfa"] },
      },
    },
  );

  assert.deepEqual(categories(result), ["security-surface-resolution"]);
  assert.match(result.diagnostics[0].message, /Duplicate inline Server Action/);
});

test("requires recent MFA on every reviewed admin mutation unless explicitly exempt", () => {
  const files = {
    "apps/web/lib/actions/admin-example.ts": `
      "use server";
      export async function unsafeMutation() {}
      export async function safeMutation() {
        getAdminSession({ permission: "catalog:write", requireRecentMfa: true });
      }
      export async function readOnlyLookup() { requireAdminSession(); }
    `,
    "apps/web/lib/actions/admin-auth.ts": `
      "use server";
      export async function loginAdminAction() { verifyTurnstile(); }
    `,
  };
  const result = audit(files, {
    "apps/web/lib/actions/admin-example.ts": {
      unsafeMutation: [],
      safeMutation: [],
      readOnlyLookup: { recentMfa: false, calls: ["requireAdminSession"] },
    },
    "apps/web/lib/actions/admin-auth.ts": {
      loginAdminAction: ["verifyTurnstile"],
    },
  });

  assert.deepEqual(categories(result), ["security-surface-control", "security-surface-control"]);
  assert.match(result.diagnostics[0].message, /unsafeAction|unsafeMutation/);
  assert.match(result.diagnostics[0].message, /requireRecentMfa/);
  assert.match(result.diagnostics[1].message, /unsafeAction|unsafeMutation/);
  assert.match(result.diagnostics[1].message, /getAdminSession/);
});

test("resolves local identifier route aliases, fails closed on wrapped exports, rejects spoofed member calls, and checks admin app actions", () => {
  const result = audit(
    {
      "apps/web/app/api/alias/route.ts": `
        function methodNotAllowed() { return createMethodNotAllowedResponse(); }
        function wrap(fn) { return fn; }
        export const POST = methodNotAllowed;
        export const PUT = wrap(methodNotAllowed);
      `,
      "apps/web/app/admin/example/actions.ts": `
        "use server";
        const spoof = {
          getAdminSession() {},
          requireRecentMfa() {},
        };
        export async function spoofedAdminAction() {
          spoof.getAdminSession();
          spoof.requireRecentMfa();
        }
      `,
    },
    {
      "apps/web/app/api/alias/route.ts": {
        POST: { calls: ["createMethodNotAllowedResponse"] },
        PUT: { calls: ["createMethodNotAllowedResponse"] },
      },
      "apps/web/app/admin/example/actions.ts": {
        spoofedAdminAction: [],
      },
    },
  );

  assert.deepEqual(categories(result), [
    "security-surface-control",
    "security-surface-control",
    "security-surface-resolution",
  ]);
  assert.match(result.diagnostics[0].message, /spoofedAdminAction/);
  assert.match(result.diagnostics[1].message, /spoofedAdminAction/);
  assert.match(result.diagnostics[2].message, /PUT/);
});

test("requires the complete reviewed A4 admin upload surface and its own Origin/RBAC/MFA controls", () => {
  const catalogRoute = "apps/web/app/api/admin/catalog-media/upload/route.ts";
  const files = {
    [catalogRoute]: `
      export async function POST(request) {
        rejectInvalidAdminUploadOrigin(request);
        getAdminSession({ permission: "catalog:write", requireRecentMfa: true });
        readAdminMultipart(request);
        return Response.json({ ok: true });
      }
      async function methodNotAllowed() { return adminMediaMethodNotAllowed(); }
      export {
        methodNotAllowed as GET,
        methodNotAllowed as HEAD,
        methodNotAllowed as PUT,
        methodNotAllowed as PATCH,
        methodNotAllowed as DELETE,
        methodNotAllowed as OPTIONS,
      };
    `,
  };
  const postContract = {
    calls: ["rejectInvalidAdminUploadOrigin", "getAdminSession", "readAdminMultipart"],
  };
  const manifest = {
    [catalogRoute]: {
      POST: postContract,
      GET: { calls: ["adminMediaMethodNotAllowed"] },
      HEAD: { calls: ["adminMediaMethodNotAllowed"] },
      PUT: { calls: ["adminMediaMethodNotAllowed"] },
      PATCH: { calls: ["adminMediaMethodNotAllowed"] },
      DELETE: { calls: ["adminMediaMethodNotAllowed"] },
      OPTIONS: { calls: ["adminMediaMethodNotAllowed"] },
    },
  };
  const accepted = audit(files, manifest);
  assert.deepEqual(accepted.diagnostics, []);
  assert.equal(accepted.stats.routeHandlers, 7);

  const unreviewed = audit(files, { [catalogRoute]: { POST: postContract } });
  assert.equal(
    categories(unreviewed).filter((category) => category === "security-surface-inventory").length,
    6,
  );

  const missingOrigin = audit(
    {
      [catalogRoute]: files[catalogRoute].replace(
        "rejectInvalidAdminUploadOrigin(request);",
        "void request;",
      ),
    },
    manifest,
  );
  assert.deepEqual(categories(missingOrigin), ["security-surface-control"]);
  assert.match(missingOrigin.diagnostics[0].message, /rejectInvalidAdminUploadOrigin/);
});
