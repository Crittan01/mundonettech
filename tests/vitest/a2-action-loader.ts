import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createContext, Script } from "node:vm";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));

function loadModule<T>(moduleUrl: URL, mocks: Record<string, unknown>): T {
  const filename = fileURLToPath(moduleUrl);
  const source = readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText;
  const actionModule = { exports: {} as Record<string, unknown> };
  const localRequire = (id: string): unknown => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    return webRequire(id) as unknown;
  };
  const context = createContext({
    ArrayBuffer,
    BigInt,
    Buffer,
    Date,
    Error,
    FormData,
    Headers,
    JSON,
    Map,
    Number,
    Object,
    Promise,
    RangeError,
    RegExp,
    Set,
    TextDecoder,
    TextEncoder,
    TypeError,
    URL,
    URLSearchParams,
    Uint8Array,
    console,
    exports: actionModule.exports,
    module: actionModule,
    process,
    require: localRequire,
  });
  new Script(output, { filename }).runInContext(context);
  return actionModule.exports as T;
}

export function loadWebModule<T>(path: string, mocks: Record<string, unknown>): T {
  return loadModule(new URL(`../../apps/web/${path}`, import.meta.url), mocks);
}

export function loadActionModule<T>(name: string, mocks: Record<string, unknown>): T {
  return loadWebModule(`lib/actions/${name}.ts`, mocks);
}
