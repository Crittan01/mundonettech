import { createHash } from "node:crypto";

export function normalizeStorageKey(value: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim() !== value ||
    value.length > 500 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError("Invalid R2 storage key.");
  }
  return value;
}

export function contentHash(input: Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function contentAddressedKey(prefix: string, input: Uint8Array, filename: string): string {
  const safePrefix = normalizeStorageKey(prefix).replace(/\/$/, "");
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(filename))
    throw new TypeError("Invalid content-addressed filename.");
  return normalizeStorageKey(`${safePrefix}/${contentHash(input)}/${filename}`);
}
