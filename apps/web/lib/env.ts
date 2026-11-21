import { parseHmacSecret } from "@mundonettech/core";

export function getSupabasePublicConfig(): { url: string; key: string } {
  const url =
    process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54421";
  const key =
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must be a valid URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !key || key.length < 20) {
    throw new Error("Supabase public URL and publishable key are required.");
  }
  return { url: parsed.toString().replace(/\/$/, ""), key };
}

export function getDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value && process.env.NODE_ENV === "production")
    throw new Error("DATABASE_URL is required in production.");
  return value ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
}

export function getSessionHmacSecret(): Uint8Array {
  const value = process.env.SESSION_TIMEOUT_SECRET;
  if (!value) throw new Error("SESSION_TIMEOUT_SECRET is required.");
  return parseHmacSecret(value);
}

export function getSecurityEventPepper(): Uint8Array {
  const value = process.env.SECURITY_EVENT_PEPPER;
  if (!value) throw new Error("SECURITY_EVENT_PEPPER is required.");
  return parseHmacSecret(value);
}

export function getRecoveryCodePepper(): Uint8Array {
  const value = process.env.RECOVERY_CODE_PEPPER;
  if (!value) throw new Error("RECOVERY_CODE_PEPPER is required.");
  return parseHmacSecret(value);
}

export function getTurnstileKeys(): { siteKey: string; secretKey: string } {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  if (!siteKey || !secretKey) throw new Error("Cloudflare Turnstile keys are required.");
  return { siteKey, secretKey };
}

export function getPublicMediaOrigin(): string | null {
  const raw = (process.env.MEDIA_BASE_URL ?? process.env.NEXT_PUBLIC_MEDIA_BASE_URL)?.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("NEXT_PUBLIC_MEDIA_BASE_URL must be a valid URL.");
  }
  const isLoopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(
    parsed.hostname.toLowerCase(),
  );
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new Error("NEXT_PUBLIC_MEDIA_BASE_URL requires HTTPS outside loopback.");
  }
  return parsed.origin;
}
