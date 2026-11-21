import { roundDivHalfUp, roundMulDiv } from "./inventory.js";
import { assertCartQuantity, assertMoney, maxSignedBigInt } from "./pricing.js";

export type StoreTaxRegimeValue = "NO_RESPONSABLE_IVA" | "RESPONSABLE_IVA";
export type CatalogTaxTreatment = "STANDARD" | "EXEMPT" | "EXCLUDED" | "UVT_THRESHOLD_EXCLUDED";
export type OrderTaxRule =
  | "NOT_RESPONSABLE"
  | "STANDARD"
  | "EXEMPT"
  | "EXCLUDED"
  | "UVT_EXCLUDED_WITHIN_LIMIT"
  | "UVT_STANDARD_ABOVE_LIMIT";

export interface OrderTaxContext {
  readonly regime: StoreTaxRegimeValue;
  readonly uvtValueCents: bigint;
  readonly uvtYear: number;
}

export interface OrderTaxLineInput {
  readonly lineId: string;
  readonly quantity: number;
  readonly netCents: bigint;
  readonly taxGroupCode: string;
  readonly taxGroupName: string;
  readonly treatment: CatalogTaxTreatment;
  readonly catalogRateBps: number;
  readonly uvtLimit: number | null;
  readonly aboveUvtRateBps: number | null;
}

export interface CalculatedOrderTaxLine {
  readonly lineId: string;
  readonly taxGroupCode: string;
  readonly taxGroupName: string;
  readonly treatment: CatalogTaxTreatment;
  readonly rule: OrderTaxRule;
  readonly catalogRateBps: number;
  readonly appliedRateBps: number;
  readonly uvtLimit: number | null;
  readonly uvtValueCents: bigint;
  readonly uvtYear: number;
  readonly unitValueCents: bigint;
  readonly taxableBaseCents: bigint;
  readonly taxCents: bigint;
}

export interface OrderTaxResult {
  readonly lines: CalculatedOrderTaxLine[];
  readonly taxCents: bigint;
}

export interface ReceiptBalanceLine {
  readonly quantity: number;
  readonly unitPriceCents: bigint;
  readonly discountCents: bigint;
  readonly lineTotalCents: bigint;
  readonly taxCents: bigint;
}

export interface ReceiptBalanceInput {
  readonly items: readonly ReceiptBalanceLine[];
  readonly subtotalCents: bigint;
  readonly discountCents: bigint;
  readonly taxCents: bigint;
  readonly shippingCents: bigint;
  readonly totalCents: bigint;
}

function assertRate(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new RangeError(`${field} must be an integer between 0 and 10000 basis points.`);
  }
  return value;
}

function assertText(value: string, field: string, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${field} must be trimmed, printable and within its length limit.`);
  }
  return value;
}

function checkedTotal(current: bigint, addition: bigint): bigint {
  const result = current + addition;
  if (result > maxSignedBigInt) throw new RangeError("Order tax total exceeds INT8.");
  return result;
}

export function calculateOrderTaxes(
  input: readonly OrderTaxLineInput[],
  context: OrderTaxContext,
): OrderTaxResult {
  if (!Array.isArray(input) || input.length === 0) {
    throw new RangeError("Tax calculation requires at least one order line.");
  }
  if (!["NO_RESPONSABLE_IVA", "RESPONSABLE_IVA"].includes(context.regime)) {
    throw new TypeError("Unknown store tax regime.");
  }
  assertMoney(context.uvtValueCents, "uvtValueCents", true);
  if (!Number.isInteger(context.uvtYear) || context.uvtYear < 2000 || context.uvtYear > 9999) {
    throw new RangeError("uvtYear must be a four-digit year.");
  }

  const lineIds = new Set<string>();
  let taxCents = 0n;
  const lines = input.map((line) => {
    assertText(line.lineId, "lineId", 128);
    if (lineIds.has(line.lineId)) throw new TypeError("Order tax line ids must be unique.");
    lineIds.add(line.lineId);
    assertCartQuantity(line.quantity);
    assertMoney(line.netCents, "netCents");
    assertText(line.taxGroupCode, "taxGroupCode", 40);
    assertText(line.taxGroupName, "taxGroupName", 120);
    assertRate(line.catalogRateBps, "catalogRateBps");
    const unitValueCents = roundDivHalfUp(line.netCents, BigInt(line.quantity));

    let rule: OrderTaxRule;
    let appliedRateBps = 0;
    if (context.regime === "NO_RESPONSABLE_IVA") {
      rule = "NOT_RESPONSABLE";
    } else {
      switch (line.treatment) {
        case "STANDARD":
          if (
            line.catalogRateBps === 0 ||
            line.uvtLimit !== null ||
            line.aboveUvtRateBps !== null
          ) {
            throw new TypeError("Standard tax groups require a positive rate and no UVT rule.");
          }
          rule = "STANDARD";
          appliedRateBps = line.catalogRateBps;
          break;
        case "EXEMPT":
        case "EXCLUDED":
          if (
            line.catalogRateBps !== 0 ||
            line.uvtLimit !== null ||
            line.aboveUvtRateBps !== null
          ) {
            throw new TypeError("Zero-rated tax groups cannot carry rates or UVT thresholds.");
          }
          rule = line.treatment;
          break;
        case "UVT_THRESHOLD_EXCLUDED": {
          if (
            line.catalogRateBps !== 0 ||
            !Number.isInteger(line.uvtLimit) ||
            line.uvtLimit === null ||
            line.uvtLimit <= 0 ||
            line.uvtLimit > 1_000_000
          ) {
            throw new TypeError("UVT tax groups require a positive threshold and zero base rate.");
          }
          const aboveRate = assertRate(line.aboveUvtRateBps ?? -1, "aboveUvtRateBps");
          if (aboveRate === 0)
            throw new TypeError("The rate above a UVT threshold must be positive.");
          const thresholdCents = BigInt(line.uvtLimit) * context.uvtValueCents;
          assertMoney(thresholdCents, "uvtThresholdCents", true);
          if (unitValueCents <= thresholdCents) {
            rule = "UVT_EXCLUDED_WITHIN_LIMIT";
          } else {
            rule = "UVT_STANDARD_ABOVE_LIMIT";
            appliedRateBps = aboveRate;
          }
          break;
        }
        default:
          throw new TypeError("Unknown catalog tax treatment.");
      }
    }

    const lineTax = roundMulDiv(line.netCents, BigInt(appliedRateBps), 10_000n);
    assertMoney(lineTax, "taxCents");
    taxCents = checkedTotal(taxCents, lineTax);
    return {
      lineId: line.lineId,
      taxGroupCode: line.taxGroupCode,
      taxGroupName: line.taxGroupName,
      treatment: line.treatment,
      rule,
      catalogRateBps: line.catalogRateBps,
      appliedRateBps,
      uvtLimit: line.uvtLimit,
      uvtValueCents: context.uvtValueCents,
      uvtYear: context.uvtYear,
      unitValueCents,
      taxableBaseCents: line.netCents,
      taxCents: lineTax,
    };
  });
  return { lines, taxCents };
}

export function assertReceiptBalanced(input: ReceiptBalanceInput): void {
  if (input.items.length === 0) throw new RangeError("A receipt requires at least one item.");
  for (const money of [
    input.subtotalCents,
    input.discountCents,
    input.taxCents,
    input.shippingCents,
    input.totalCents,
  ]) {
    assertMoney(money, "receipt money");
  }
  let subtotalCents = 0n;
  let discountCents = 0n;
  let netCents = 0n;
  let taxCents = 0n;
  for (const item of input.items) {
    assertCartQuantity(item.quantity);
    for (const money of [
      item.unitPriceCents,
      item.discountCents,
      item.lineTotalCents,
      item.taxCents,
    ]) {
      assertMoney(money, "receipt item money");
    }
    const gross = item.unitPriceCents * BigInt(item.quantity);
    if (item.discountCents > gross || item.lineTotalCents !== gross - item.discountCents) {
      throw new RangeError("Receipt item commercial totals do not balance.");
    }
    subtotalCents = checkedTotal(subtotalCents, gross);
    discountCents = checkedTotal(discountCents, item.discountCents);
    netCents = checkedTotal(netCents, item.lineTotalCents);
    taxCents = checkedTotal(taxCents, item.taxCents);
  }
  if (
    subtotalCents !== input.subtotalCents ||
    discountCents !== input.discountCents ||
    taxCents !== input.taxCents ||
    netCents !== input.subtotalCents - input.discountCents ||
    input.totalCents !== netCents + input.taxCents + input.shippingCents
  ) {
    throw new RangeError("Receipt totals do not balance exactly.");
  }
}
