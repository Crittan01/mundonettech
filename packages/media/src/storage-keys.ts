import { createHash } from "node:crypto";

export function normalizeStorageKey(value: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim() !== value ||
    value.length > 500 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError("Invalid R2 storage key.");
  }
  return value;
}

export function normalizeStoragePrefix(prefix: string): string {
  if (typeof prefix !== "string") throw new TypeError("Invalid R2 storage key.");
  const trimmed =
    prefix.length > 1 && prefix.endsWith("/") && !prefix.endsWith("//")
      ? prefix.slice(0, -1)
      : prefix;
  return normalizeStorageKey(trimmed);
}

function contentHash(input: Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function contentAddressedKey(prefix: string, input: Uint8Array, filename: string): string {
  const safePrefix = normalizeStoragePrefix(prefix);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(filename)) {
    throw new TypeError("Invalid content-addressed filename.");
  }
  return normalizeStorageKey(`${safePrefix}/${contentHash(input)}/${filename}`);
}
