import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createContext, Script } from "node:vm";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export interface RouteHandlers {
  readonly GET: () => Response | Promise<Response>;
  readonly POST: (request: Request) => Response | Promise<Response>;
}

const webRequire = createRequire(new URL("../../../apps/web/package.json", import.meta.url));

export function loadTypeScriptModule<T>(filename: string, mocks: Record<string, unknown>): T {
  const source = readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText;
  const commonJsModule = { exports: {} as Record<string, unknown> };
  const localRequire = (id: string): unknown => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    return webRequire(id) as unknown;
  };
  const context = createContext({
    Buffer,
    Date,
    Headers,
    Map,
    Promise,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    console,
    exports: commonJsModule.exports,
    module: commonJsModule,
    process,
    require: localRequire,
  });
  new Script(output, { filename }).runInContext(context);
  return commonJsModule.exports as T;
}

export function loadRoute(route: string, mocks: Record<string, unknown>): RouteHandlers {
  const filename = fileURLToPath(
    new URL(`../../../apps/web/app/api/${route}/route.ts`, import.meta.url),
  );
  return loadTypeScriptModule<RouteHandlers>(filename, mocks);
}

export function requestWithJson(
  url: string,
  body: string | Uint8Array,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : new Uint8Array(body).buffer,
  });
}

export async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.clone().json()) as Record<string, unknown>;
}

export function expectSecurityHeaders(response: Response): void {
  if (response.headers.get("cache-control") !== "no-store") {
    throw new Error("Expected Cache-Control: no-store.");
  }
  if (response.headers.get("x-content-type-options") !== "nosniff") {
    throw new Error("Expected X-Content-Type-Options: nosniff.");
  }
  if (!response.headers.get("x-robots-tag")?.includes("noindex")) {
    throw new Error("Expected a noindex response.");
  }
}
