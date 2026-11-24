import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { normalizeEmail } from "../../packages/core/dist/index.js";
import { loadWebModule } from "./a2-action-loader";

const pepper = new Uint8Array(32).fill(9);
const { documentIdentityHash } = loadWebModule<{
  documentIdentityHash(document: string): Uint8Array;
}>("lib/payment-identities.ts", {
  "server-only": {},
  "@mundonettech/core": { normalizeEmail },
  "@/lib/env": { getSecurityEventPepper: () => pepper },
});

function expected(document: string): Uint8Array {
  return createHmac("sha256", pepper).update(`DOCUMENT:${document}`, "utf8").digest();
}

describe("A2 — documento COD normalizado", () => {
  it("acepta exactamente 3 y 30 caracteres y comparte la normalización del checkout", () => {
    expect(documentIdentityHash(" abc ")).toEqual(expected("ABC"));
    expect(documentIdentityHash("a".repeat(30))).toEqual(expected("A".repeat(30)));
    expect(documentIdentityHash("ß12")).toEqual(expected("SS12"));
  });

  it("rechaza longitudes, Unicode no ASCII y separadores no admitidos", () => {
    for (const value of [
      "ab",
      "a".repeat(31),
      "ábc",
      "ａｂｃ",
      "ABC/1",
      "ABC 1",
      "ABC_1",
      "ABC\u00001",
      "🙂ABC",
      "",
      "   ",
    ]) {
      expect(() => documentIdentityHash(value), JSON.stringify(value)).toThrow(TypeError);
    }
  });
});
