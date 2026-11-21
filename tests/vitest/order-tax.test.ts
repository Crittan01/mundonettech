import { describe, expect, it } from "vitest";

import {
  assertReceiptBalanced,
  calculateOrderTaxes,
  type OrderTaxLineInput,
} from "../../packages/core/dist/index.js";

const context = { regime: "RESPONSABLE_IVA", uvtValueCents: 5_237_400n, uvtYear: 2026 } as const;

function line(overrides: Partial<OrderTaxLineInput> = {}): OrderTaxLineInput {
  return {
    lineId: "line-1",
    quantity: 1,
    netCents: 100_001n,
    taxGroupCode: "IVA_19",
    taxGroupName: "IVA general 19 %",
    treatment: "STANDARD",
    catalogRateBps: 1900,
    uvtLimit: null,
    aboveUvtRateBps: null,
    ...overrides,
  };
}

describe("dual Colombian order tax engine", () => {
  it("rounds each standard line half-up and sums exact BigInt cents", () => {
    const result = calculateOrderTaxes(
      [line(), line({ lineId: "line-2", netCents: 50n })],
      context,
    );
    expect(result.lines.map((entry) => entry.taxCents)).toEqual([19_000n, 10n]);
    expect(result.taxCents).toBe(19_010n);
    expect(result.lines[0]?.rule).toBe("STANDARD");
  });

  it("zeroes every line for a non-responsible store without erasing catalog rules", () => {
    const result = calculateOrderTaxes(
      [line(), line({ lineId: "line-2", treatment: "EXEMPT", catalogRateBps: 0 })],
      { ...context, regime: "NO_RESPONSABLE_IVA" },
    );
    expect(result.taxCents).toBe(0n);
    expect(result.lines.every((entry) => entry.rule === "NOT_RESPONSABLE")).toBe(true);
    expect(result.lines[0]?.catalogRateBps).toBe(1900);
    expect(result.lines[0]?.taxableBaseCents).toBe(100_001n);
  });

  it("distinguishes exempt and excluded goods", () => {
    for (const treatment of ["EXEMPT", "EXCLUDED"] as const) {
      const result = calculateOrderTaxes([line({ treatment, catalogRateBps: 0 })], context);
      expect(result.lines[0]?.rule).toBe(treatment);
      expect(result.taxCents).toBe(0n);
    }
  });

  it("applies the 50 UVT threshold per discounted unit, including the exact boundary", () => {
    const threshold = 50n * context.uvtValueCents;
    const input = line({
      treatment: "UVT_THRESHOLD_EXCLUDED",
      catalogRateBps: 0,
      uvtLimit: 50,
      aboveUvtRateBps: 1900,
      quantity: 2,
      netCents: threshold * 2n,
    });
    const within = calculateOrderTaxes([input], context);
    expect(within.lines[0]?.rule).toBe("UVT_EXCLUDED_WITHIN_LIMIT");
    expect(within.taxCents).toBe(0n);

    const above = calculateOrderTaxes([{ ...input, netCents: threshold * 2n + 2n }], context);
    expect(above.lines[0]?.rule).toBe("UVT_STANDARD_ABOVE_LIMIT");
    expect(above.lines[0]?.appliedRateBps).toBe(1900);
    expect(above.taxCents).toBe(99_510_600n);
  });

  it("applies the 22 UVT technology threshold and rejects malformed tax definitions", () => {
    const threshold = 22n * context.uvtValueCents;
    const input = line({
      treatment: "UVT_THRESHOLD_EXCLUDED",
      catalogRateBps: 0,
      uvtLimit: 22,
      aboveUvtRateBps: 500,
      netCents: threshold + 1n,
    });
    expect(calculateOrderTaxes([input], context).taxCents).toBe(5_761_140n);
    expect(() => calculateOrderTaxes([{ ...input, aboveUvtRateBps: null }], context)).toThrow();
    expect(() => calculateOrderTaxes([{ ...input, uvtLimit: 0 }], context)).toThrow();
    expect(() => calculateOrderTaxes([line({ catalogRateBps: 0 })], context)).toThrow();
  });

  it("rejects duplicate lines, invalid quantities, UVT values and money overflow", () => {
    expect(() => calculateOrderTaxes([line(), line()], context)).toThrow(/unique/);
    expect(() => calculateOrderTaxes([line({ quantity: 0 })], context)).toThrow(/quantity/);
    expect(() => calculateOrderTaxes([line()], { ...context, uvtValueCents: 0n })).toThrow();
    expect(() =>
      calculateOrderTaxes(
        [
          line({ netCents: 9_223_372_036_854_775_807n, catalogRateBps: 10_000 }),
          line({ lineId: "line-2", netCents: 9_223_372_036_854_775_807n, catalogRateBps: 10_000 }),
        ],
        context,
      ),
    ).toThrow(/INT8/);
    expect(() => calculateOrderTaxes([], context)).toThrow(/at least one/);
  });
});

describe("receipt arithmetic guard", () => {
  const balanced = {
    items: [
      {
        quantity: 2,
        unitPriceCents: 100_000n,
        discountCents: 20_000n,
        lineTotalCents: 180_000n,
        taxCents: 34_200n,
      },
    ],
    subtotalCents: 200_000n,
    discountCents: 20_000n,
    taxCents: 34_200n,
    shippingCents: 10_000n,
    totalCents: 224_200n,
  };

  it("accepts exact commercial, tax and shipping totals", () => {
    expect(() => assertReceiptBalanced(balanced)).not.toThrow();
  });

  it("blocks line, aggregate and final-total discrepancies", () => {
    expect(() =>
      assertReceiptBalanced({ ...balanced, items: [{ ...balanced.items[0]!, taxCents: 1n }] }),
    ).toThrow(/totals/);
    expect(() => assertReceiptBalanced({ ...balanced, discountCents: 0n })).toThrow(/totals/);
    expect(() => assertReceiptBalanced({ ...balanced, totalCents: 1n })).toThrow(/totals/);
    expect(() => assertReceiptBalanced({ ...balanced, items: [] })).toThrow(/at least one/);
  });
});
