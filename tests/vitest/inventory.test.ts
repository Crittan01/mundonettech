import { describe, expect, it } from "vitest";

import {
  CsvValidationError,
  assertValidImei,
  availableStock,
  calculateWeightedAverageCost,
  isValidImei,
  neutralizeCsvFormula,
  normalizeOperationKey,
  normalizeSerial,
  parseCsv,
  parseInventoryStockCsv,
  roundDivHalfUp,
  roundMulDiv,
  serializeCsv,
} from "../../packages/core/dist/index.js";

function imeiWithPrefix(prefix: string): string {
  expect(prefix).toMatch(/^[0-9]{14}$/);
  let sum = 0;
  for (let index = 0; index < 14; index += 1) {
    let digit = prefix.charCodeAt(index) - 48;
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return `${prefix}${(10 - (sum % 10)) % 10}`;
}

describe("F1.3 — effective stock and exact WAC", () => {
  it("subtracts commitments and safety stock without returning negative availability", () => {
    expect(availableStock({ onHand: 10, committed: 2, safetyStock: 3 })).toBe(5);
    expect(availableStock({ onHand: 2, committed: 2, safetyStock: 8 })).toBe(0);
    expect(() => availableStock({ onHand: 1, committed: 2, safetyStock: 0 })).toThrow();
    expect(() => availableStock({ onHand: -1, committed: 0, safetyStock: 0 })).toThrow();
    expect(() => availableStock({ onHand: 1.5, committed: 0, safetyStock: 0 })).toThrow();
  });

  it("uses BigInt half-up arithmetic without bounded intermediate multiplication", () => {
    expect(calculateWeightedAverageCost(10, 60_000n, 4, 65_000n)).toBe(61_429n);
    expect(calculateWeightedAverageCost(0, 0n, 4, 65_000n)).toBe(65_000n);
    expect(roundDivHalfUp(1n, 2n)).toBe(1n);
    expect(roundDivHalfUp(-1n, 2n)).toBe(-1n);
    expect(roundMulDiv(100n, 1n, 3n)).toBe(33n);
    const max = 9_223_372_036_854_775_807n;
    expect(roundMulDiv(max, max, max)).toBe(max);
    expect(calculateWeightedAverageCost(1, max, 1, max)).toBe(max);
    expect(() => calculateWeightedAverageCost(1, -1n, 1, 0n)).toThrow();
    expect(() => roundDivHalfUp(1n, 0n)).toThrow();
  });

  it("validates operation keys, serials and IMEI check digits", () => {
    const imei = imeiWithPrefix("35391510544011");
    expect(isValidImei(imei)).toBe(true);
    expect(assertValidImei(imei)).toBe(imei);
    expect(isValidImei(`${imei.slice(0, 14)}${(Number(imei.at(-1)) + 1) % 10}`)).toBe(false);
    expect(isValidImei("000000000000000")).toBe(false);
    expect(normalizeSerial("  SN-001  ")).toBe("SN-001");
    expect(() => normalizeSerial("SN\u0000-01")).toThrow();
    expect(normalizeOperationKey("reserve-123")).toBe("reserve-123");
    expect(() => normalizeOperationKey(" reserve-123 ")).toThrow();
  });
});

describe("F1.3 — RFC 4180 CSV and formula safety", () => {
  it("parses BOM, CRLF, quoted commas, escaped quotes and embedded newlines", () => {
    const rows = parseCsv('\uFEFFname,note\r\n"A","x,""quoted""\r\nnext"\r\n');
    expect(rows).toEqual([
      { cells: ["name", "note"], line: 1 },
      { cells: ["A", 'x,"quoted"\r\nnext'], line: 2 },
    ]);
  });

  it("rejects malformed quotes, NUL, duplicate/unknown headers and oversized inputs", () => {
    expect(() => parseCsv('a,b\n"unterminated,c')).toThrow(CsvValidationError);
    expect(() => parseCsv('a,b\n"closed"x,value')).toThrow(/closing quote/);
    expect(() => parseCsv("a,b\nvalue,\u0000")).toThrow(/NUL/);
    expect(() => parseCsv("a\n1\n2", { maxRows: 1 })).toThrow(/data rows/);
    expect(() => parseCsv("a,b", { maxBytes: 2 })).toThrow(/bytes/);
    expect(() =>
      parseInventoryStockCsv(
        "locationCode,locationCode,sku,onHand,safetyStock,unitCostCents\nA,A,B,1,0,1",
      ),
    ).toThrow(/Duplicate headers/);
    expect(() =>
      parseInventoryStockCsv(
        "locationCode,sku,onHand,safetyStock,unitCostCents,unexpected\nA,BB,1,0,1,x",
      ),
    ).toThrow(/Unknown column/);
  });

  it("neutralizes every spreadsheet formula prefix and quotes exported cells", () => {
    for (const value of ["=1+1", "+SUM(A1:A2)", "-2+3", "@cmd", "\t=1", "\r=1", "  =1"]) {
      expect(neutralizeCsvFormula(value).startsWith("'")).toBe(true);
    }
    const csv = serializeCsv([["plain", "=formula", "comma,value", 'quote"value', 10n, null]]);
    const [row] = parseCsv(csv);
    expect(row?.cells).toEqual(["plain", "'=formula", "comma,value", 'quote"value', "10", ""]);
    expect(csv.includes("\n")).toBe(false);
  });

  it("parses inventory rows in any column order with typed BigInt and serial identities", () => {
    const imei = imeiWithPrefix("35391510544011");
    const serials = JSON.stringify([{ serial: " SN-1 ", imei }]);
    const csv = serializeCsv([
      ["sku", "serials", "unitCostCents", "safetyStock", "onHand", "locationCode"],
      ["ab-01", serials, "12345", "2", "1", " main-1 "],
    ]);
    const [row] = parseInventoryStockCsv(csv);
    expect(row).toMatchObject({
      locationCode: "MAIN-1",
      sku: "AB-01",
      onHand: 1,
      safetyStock: 2,
      unitCostCents: 12_345n,
      serials: [{ serial: "SN-1", imei }],
    });
  });

  it("rejects duplicate stock keys, duplicate serials, invalid numbers and formula identities", () => {
    const header = "locationCode,sku,onHand,safetyStock,unitCostCents";
    expect(() => parseInventoryStockCsv(`${header}\nMAIN,AB-01,1,0,10\nMAIN,AB-01,2,0,20`)).toThrow(
      /Duplicate locationCode/,
    );
    expect(() => parseInventoryStockCsv(`${header}\n=MAIN,AB-01,1,0,10`)).toThrow(
      CsvValidationError,
    );
    for (const value of ["-1", "1.5", "1e3", ""]) {
      expect(() => parseInventoryStockCsv(`${header}\nMAIN,AB-01,${value},0,10`)).toThrow(
        CsvValidationError,
      );
    }
    expect(() =>
      parseInventoryStockCsv(
        `${header},serials\nMAIN,AB-01,2,0,10,"[{""serial"":""S1""},{""serial"":""S1""}]"`,
      ),
    ).toThrow(/Duplicate serial/);
    expect(() => parseInventoryStockCsv(`${header},serials\nMAIN,AB-01,1,0,10,"not-json"`)).toThrow(
      /JSON array/,
    );
  });
});
