import "server-only";

import type { PostSaleActor } from "@mundonettech/db";
import { cookies } from "next/headers";
import { connection } from "next/server";

import { guestOrderAccessService } from "@/lib/integrations";
import { guestOrderCookie, sessionCookieOptions } from "@/lib/security/session-policy";

export async function establishGuestOrderSession(
  sessionToken: string,
  expiresAt: Date,
): Promise<void> {
  const store = await cookies();
  store.set(guestOrderCookie, sessionToken, {
    ...sessionCookieOptions,
    maxAge: Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
  });
}

export async function clearGuestOrderSession(): Promise<void> {
  const store = await cookies();
  store.set(guestOrderCookie, "", { ...sessionCookieOptions, maxAge: 0, expires: new Date(0) });
}

export async function getGuestOrderAccess(
  token: string,
): Promise<{ actor: PostSaleActor; orderId: string } | null> {
  await connection();
  const store = await cookies();
  const sessionToken = store.get(guestOrderCookie)?.value;
  if (!sessionToken) return null;
  try {
    const session = await guestOrderAccessService().getSession({ token, sessionToken });
    return {
      actor: { kind: "GUEST", guestSessionId: session.sessionId },
      orderId: session.orderId,
    };
  } catch {
    return null;
  }
}
