import "server-only";

import { createTimeoutToken } from "@mundonettech/core";
import { cookies } from "next/headers";

import { getSessionHmacSecret } from "@/lib/env";
import {
  adminAbsoluteSeconds,
  adminActivityCookie,
  adminIdleSeconds,
  customerAbsoluteSeconds,
  customerActivityCookie,
  customerIdleSeconds,
  factorResetCookie,
  factorResetSeconds,
  sessionCookieOptions,
} from "@/lib/security/session-policy";

function expireCookie(store: Awaited<ReturnType<typeof cookies>>, name: string): void {
  store.set(name, "", { ...sessionCookieOptions, maxAge: 0 });
}

export async function establishAdminActivity(subject: string): Promise<void> {
  const store = await cookies();
  store.set(
    adminActivityCookie,
    createTimeoutToken({
      kind: "admin",
      subject,
      secret: getSessionHmacSecret(),
      idleSeconds: adminIdleSeconds,
      absoluteSeconds: adminAbsoluteSeconds,
    }),
    { ...sessionCookieOptions, maxAge: adminAbsoluteSeconds },
  );
  expireCookie(store, factorResetCookie);
}

export async function establishCustomerActivity(subject: string): Promise<void> {
  const store = await cookies();
  store.set(
    customerActivityCookie,
    createTimeoutToken({
      kind: "customer",
      subject,
      secret: getSessionHmacSecret(),
      idleSeconds: customerIdleSeconds,
      absoluteSeconds: customerAbsoluteSeconds,
    }),
    { ...sessionCookieOptions, maxAge: customerAbsoluteSeconds },
  );
}

export async function markAdminFactorReset(subject: string): Promise<void> {
  const store = await cookies();
  store.set(
    factorResetCookie,
    createTimeoutToken({
      kind: "admin_factor_reset",
      subject,
      secret: getSessionHmacSecret(),
      idleSeconds: factorResetSeconds,
      absoluteSeconds: factorResetSeconds,
    }),
    { ...sessionCookieOptions, maxAge: factorResetSeconds },
  );
}

export async function clearAdminFactorResetCookie(): Promise<void> {
  const store = await cookies();
  expireCookie(store, factorResetCookie);
}

export async function clearActivityCookies(): Promise<void> {
  const store = await cookies();
  expireCookie(store, adminActivityCookie);
  expireCookie(store, customerActivityCookie);
  expireCookie(store, factorResetCookie);
}
