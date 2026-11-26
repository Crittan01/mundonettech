import "server-only";

import { createTimeoutToken, refreshTimeoutToken } from "@mundonettech/core";
import { cookies } from "next/headers";

import { getSessionHmacSecret } from "@/lib/env";
import {
  adminAbsoluteSeconds,
  adminActivityCookie,
  adminIdleSeconds,
  cartTokenCookie,
  customerAbsoluteSeconds,
  customerActivityCookie,
  customerIdleSeconds,
  factorResetCookie,
  factorResetSeconds,
  sessionCookieOptions,
} from "@/lib/security/session-policy";

function expireCookie(store: Awaited<ReturnType<typeof cookies>>, name: string): void {
  store.set(name, "", { ...sessionCookieOptions, maxAge: 0, expires: new Date(0) });
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

export async function refreshAdminActivity(subject: string): Promise<void> {
  const store = await cookies();
  const current = store.get(adminActivityCookie)?.value;
  if (!current) {
    throw new Error("Admin activity session token is missing.");
  }
  const refreshed = refreshTimeoutToken({
    token: current,
    expectedKind: "admin",
    expectedSubject: subject,
    secret: getSessionHmacSecret(),
    idleSeconds: adminIdleSeconds,
    maximumAbsoluteSeconds: adminAbsoluteSeconds,
    refreshAfterSeconds: 0,
  });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const remainingAbsoluteSeconds = Math.max(1, refreshed.payload.exp - nowSeconds);
  store.set(adminActivityCookie, refreshed.token, {
    ...sessionCookieOptions,
    maxAge: remainingAbsoluteSeconds,
  });
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

export async function clearCustomerCartCookie(): Promise<void> {
  const store = await cookies();
  expireCookie(store, cartTokenCookie);
}
