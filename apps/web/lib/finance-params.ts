import "server-only";

import { bogotaDayStart, currentYearRange, type FinanceRange } from "@mundonettech/db";
import { z } from "zod";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();

const yearStringSchema = z
  .string()
  .regex(/^\d{4}$/)
  .transform(Number)
  .pipe(z.number().int().min(2000).max(9998));

export function parseFinanceRange(
  input: {
    readonly from?: string | undefined;
    readonly to?: string | undefined;
    readonly year?: string | undefined;
  },
  defaultYear: number,
): FinanceRange & { readonly fromDate: string; readonly toDate: string; readonly year: number } {
  const parsedFrom = dateSchema.parse(input.from);
  const parsedTo = dateSchema.parse(input.to);
  const fromYear = parsedFrom ? yearStringSchema.parse(parsedFrom.slice(0, 4)) : undefined;
  const toYear = parsedTo ? yearStringSchema.parse(parsedTo.slice(0, 4)) : undefined;
  const derivedYear = fromYear ?? toYear ?? defaultYear;
  const year = input.year ? yearStringSchema.parse(input.year) : derivedYear;
  const fromDate = parsedFrom ?? `${year}-01-01`;
  const toDate = parsedTo ?? `${year}-12-31`;
  if (fromDate > toDate) {
    throw new RangeError("La fecha inicial no puede ser posterior a la fecha final.");
  }
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
