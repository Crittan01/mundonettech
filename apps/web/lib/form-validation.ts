import { z } from "zod";

export const phoneInputPattern =
  /^(?:\+57[\s()-]*[36][0-9\s()-]{9}|[36][0-9\s()-]{9}|\+[1-9][0-9\s()-]{7,18})$/;

export function optionalTrimmedText(maximumLength: number) {
  return z
    .string()
    .trim()
    .max(maximumLength)
    .transform((value) => value || null);
}
