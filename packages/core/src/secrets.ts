import { createHash, timingSafeEqual } from "node:crypto";

const forbiddenSecretChars = /[\s\u0000-\u001f\u007f]/;
const minCronSecretLength = 32;
const maxAuthorizationHeaderLength = 512;

export function matchesSecretTimingSafe(provided: string, expected: string): boolean {
  if (!expected) return false;
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

function isValidCronSecret(rawSecret: string | undefined): rawSecret is string {
  return (
    typeof rawSecret === "string" &&
    rawSecret.length >= minCronSecretLength &&
    !forbiddenSecretChars.test(rawSecret)
  );
}

export function verifyCronBearer(
  authorizationHeader: string | null,
  rawSecret: string | undefined,
): "UNCONFIGURED" | "UNAUTHORIZED" | "OK" {
  if (!isValidCronSecret(rawSecret)) return "UNCONFIGURED";
  if (
    typeof authorizationHeader !== "string" ||
    authorizationHeader.length === 0 ||
    authorizationHeader.length > maxAuthorizationHeaderLength ||
    !authorizationHeader.startsWith("Bearer ")
  ) {
    return "UNAUTHORIZED";
  }
  const provided = authorizationHeader.slice(7);
  if (!provided || !matchesSecretTimingSafe(provided, rawSecret)) {
    return "UNAUTHORIZED";
  }
  return "OK";
}
