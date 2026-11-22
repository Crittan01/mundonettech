import "server-only";

import { bogotaDayStart, currentYearRange, type FinanceRange } from "@mundonettech/db";
import { z } from "zod";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();

export function parseFinanceRange(
  input: {
    readonly from?: string | undefined;
    readonly to?: string | undefined;
    readonly year?: string | undefined;
  },
  defaultYear: number,
): FinanceRange & { readonly fromDate: string; readonly toDate: string; readonly year: number } {
  const year = input.year
    ? z.coerce.number().int().min(2000).max(9998).parse(input.year)
    : defaultYear;
  const fromDate = dateSchema.parse(input.from) ?? `${year}-01-01`;
  const toDate = dateSchema.parse(input.to) ?? `${year}-12-31`;
  if (input.from || input.to) {
    return {
      from: bogotaDayStart(fromDate),
      to: new Date(bogotaDayStart(toDate).getTime() + 86_400_000),
      fromDate,
      toDate,
      year,
    };
  }
  return { ...currentYearRange(year), fromDate, toDate, year };
}
