import "server-only";

import { verifyTimeoutToken } from "@mundonettech/core";
import { CartService, type CartSnapshot } from "@mundonettech/db";
import { cookies } from "next/headers";

import { hashCartToken, createCartToken } from "@/lib/cart-token";
import { getDatabase } from "@/lib/db";
import { getSessionHmacSecret } from "@/lib/env";
import { sessionCookieOptions } from "@/lib/security/session-policy";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  customerAbsoluteSeconds,
  customerActivityCookie,
  customerIdleSeconds,
} from "@/lib/security/session-policy";

const cartCookie = process.env.NODE_ENV === "production" ? "__Host-cart_token" : "cart_token";
const cartLifetimeSeconds = 30 * 24 * 60 * 60;

interface OptionalCustomer {
  readonly id: string;
}

async function optionalCustomer(): Promise<OptionalCustomer | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  const store = await cookies();
  const activity = store.get(customerActivityCookie)?.value;
  try {
    if (!activity) return null;
    verifyTimeoutToken({
      token: activity,
      expectedKind: "customer",
      expectedSubject: data.user.id,
      secret: getSessionHmacSecret(),
      idleSeconds: customerIdleSeconds,
      maximumAbsoluteSeconds: customerAbsoluteSeconds,
    });
  } catch {
    return null;
  }
  const profile = await getDatabase().customer.findFirst({
    where: { authUserId: data.user.id, deletedAt: null, status: "ACTIVE" },
    select: { id: true },
  });
  return profile;
}

function cartService(): CartService {
  return new CartService(getDatabase());
}

async function tokenFromCookie(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(cartCookie)?.value;
  if (!token) return null;
  try {
    hashCartToken(token);
    return token;
  } catch {
    return null;
  }
}

async function setCartCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(cartCookie, token, {
    ...sessionCookieOptions,
    maxAge: cartLifetimeSeconds,
    expires: new Date(Date.now() + cartLifetimeSeconds * 1000),
  });
}

export async function readCart(): Promise<CartSnapshot | null> {
  const token = await tokenFromCookie();
  if (!token) return null;
  const service = cartService();
  const cart = await service.getByAccessToken(hashCartToken(token));
  if (!cart) return null;
  const customer = await optionalCustomer();
  if (customer && cart.customerId === null) {
    return service.assignCustomer({ accessTokenHash: hashCartToken(token) }, customer.id);
  }
  return cart;
}

export async function cartForMutation(): Promise<{ accessTokenHash: Uint8Array<ArrayBuffer> }> {
  const existing = await readCart();
  if (existing) return { accessTokenHash: hashCartToken((await tokenFromCookie())!) };
  const generated = createCartToken();
  const customer = await optionalCustomer();
  await cartService().createStorefrontCart({
    accessTokenHash: generated.hash,
    expiresAt: new Date(Date.now() + cartLifetimeSeconds * 1000),
    ...(customer ? { customerId: customer.id } : {}),
  });
  await setCartCookie(generated.token);
  return { accessTokenHash: generated.hash };
}

export async function existingCartReference(): Promise<{
  accessTokenHash: Uint8Array<ArrayBuffer>;
} | null> {
  const token = await tokenFromCookie();
  return token ? { accessTokenHash: hashCartToken(token) } : null;
}

export async function claimAssistedCart(token: string): Promise<CartSnapshot> {
  const generated = createCartToken();
  const snapshot = await cartService().claimAssistedCart({
    assistedTokenHash: hashCartToken(token),
    accessTokenHash: generated.hash,
    expiresAt: new Date(Date.now() + cartLifetimeSeconds * 1000),
  });
  await setCartCookie(generated.token);
  return snapshot;
}
