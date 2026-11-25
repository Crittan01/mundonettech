import { z } from "zod";

export const phoneInputPattern =
  /^(?=(?:[^0-9]*[0-9]){8,15}[^0-9]*$)(?:\+57[\s()-]*[36][0-9\s()-]+|[\s()-]*[36][0-9\s()-]+|\+[1-9][0-9\s()-]+)$/;

export function normalizePhoneE164(value: string): string {
  const compact = value.replace(/[\s()-]/g, "");
  const colombian = /^(?:\+57)?([36][0-9]{9})$/.exec(compact);
  const normalized = colombian?.[1] ? `+57${colombian[1]}` : compact;
  if (!/^\+[1-9][0-9]{7,14}$/.test(normalized)) {
    throw new TypeError("phoneE164 must be a valid Colombian or international E.164 phone.");
  }
  return normalized;
}

export function optionalTrimmedText(maximumLength: number) {
  return z
    .string()
    .trim()
    .max(maximumLength)
    .transform((value) => value || null);
}
