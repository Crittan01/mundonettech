import { describe, expect, it } from "vitest";

import {
  formatCopCentsForInput,
  parseDecimalCopToCents,
  parseWholeCopToCents,
} from "../../packages/core/dist/index.js";

const maximumCents = "9223372036854775807";

describe("Admin COP input conversion", () => {
  it("formats null, empty, zero, fractions and large cents without truncation", () => {
    expect(formatCopCentsForInput(null)).toBe("");
    expect(formatCopCentsForInput("")).toBe("");
    expect(formatCopCentsForInput("0")).toBe("0");
    expect(formatCopCentsForInput("1")).toBe("0.01");
    expect(formatCopCentsForInput("10")).toBe("0.1");
    expect(formatCopCentsForInput("100")).toBe("1");
    expect(formatCopCentsForInput("12300")).toBe("123");
    expect(formatCopCentsForInput("12345")).toBe("123.45");
    expect(formatCopCentsForInput(maximumCents)).toBe("92233720368547758.07");
    expect(formatCopCentsForInput(12345n)).toBe("123.45");
  });

  it("parses decimal COP with exact BigInt arithmetic and either decimal separator", () => {
    const cases = [
      ["0", "0"],
      ["0.00", "0"],
      ["1", "100"],
      ["0.01", "1"],
      ["0,01", "1"],
      ["123.4", "12340"],
      ["123,45", "12345"],
      ["123.45", "12345"],
      [" 123.45 ", "12345"],
      ["000123.45", "12345"],
      ["92233720368547758.07", maximumCents],
    ] as const;
    for (const [cop, cents] of cases) expect(parseDecimalCopToCents(cop)).toBe(cents);
  });

  it("round-trips every decimal boundary without turning 12345 into 12300", () => {
    for (const cents of ["0", "1", "10", "99", "100", "12300", "12345", maximumCents]) {
      expect(parseDecimalCopToCents(formatCopCentsForInput(cents))).toBe(cents);
    }
    expect(parseDecimalCopToCents(formatCopCentsForInput("12345"))).not.toBe("12300");
  });

  it("rejects malformed, negative, overflowing and over-precision decimal amounts", () => {
    const invalid = [
      "",
      " ",
      "-1",
      "+1",
      ".45",
      "1.",
      "1.234",
      "1,234",
      "1.2.3",
      "1e3",
      "NaN",
      "92233720368547758.08",
      "9999999999999999999",
      "00000000000000000000000",
    ];
    for (const value of invalid) expect(() => parseDecimalCopToCents(value)).toThrow();
    expect(() => formatCopCentsForInput("-1")).toThrow(RangeError);
    expect(() => formatCopCentsForInput("   ")).toThrow(TypeError);
    expect(() => formatCopCentsForInput("9223372036854775808")).toThrow(RangeError);
  });

  it("keeps manual prices on whole COP and rejects decimal notation explicitly", () => {
    expect(parseWholeCopToCents("0")).toBe("0");
    expect(parseWholeCopToCents("123")).toBe("12300");
    expect(parseWholeCopToCents("92233720368547758")).toBe("9223372036854775800");
    for (const value of ["123.45", "123,45", "123.00", "-1", "1e3", ""]) {
      expect(() => parseWholeCopToCents(value)).toThrow(TypeError);
    }
    expect(() => parseWholeCopToCents("92233720368547759")).toThrow(RangeError);
  });
});
