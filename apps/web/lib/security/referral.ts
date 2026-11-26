import "server-only";

import { normalizeReferralCode } from "@mundonettech/core";
import { cookies } from "next/headers";

import { referralCookie } from "@/lib/security/session-policy";

const referralCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

export async function storeReferralCode(value: string): Promise<string> {
  const code = normalizeReferralCode(value);
  const store = await cookies();
  store.set(referralCookie, code, {
    ...referralCookieOptions,
    maxAge: 30 * 24 * 60 * 60,
  });
  return code;
}

export async function readReferralCode(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(referralCookie)?.value;
  if (!value) return null;
  try {
    return normalizeReferralCode(value);
  } catch {
    return null;
  }
}

export async function consumeReferralPath(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(referralCookie)?.value;
  if (!value) return null;
  store.set(referralCookie, "", { ...referralCookieOptions, maxAge: 0, expires: new Date(0) });
  try {
    return `/mi-cuenta/beneficios?codigo=${normalizeReferralCode(value)}`;
  } catch {
    return null;
  }
}

export async function clearReferralCode(): Promise<void> {
  const store = await cookies();
  store.set(referralCookie, "", { ...referralCookieOptions, maxAge: 0, expires: new Date(0) });
}
