import "server-only";

import { normalizeReferralCode } from "@mundonettech/core";
import { cookies } from "next/headers";

const referralCookie = "mnt_referral";

export async function storeReferralCode(value: string): Promise<string> {
  const code = normalizeReferralCode(value);
  const store = await cookies();
  store.set({
    name: referralCookie,
    value: code,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  return code;
}

export async function consumeReferralPath(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(referralCookie)?.value;
  if (!value) return null;
  store.delete(referralCookie);
  try {
    return `/mi-cuenta/beneficios?codigo=${normalizeReferralCode(value)}`;
  } catch {
    return null;
  }
}

export async function clearReferralCode(): Promise<void> {
  const store = await cookies();
  store.delete(referralCookie);
}
