import "server-only";

import { verifyTimeoutToken } from "@mundonettech/core";
import { CartService, type CartSnapshot } from "@mundonettech/db";
import { cookies } from "next/headers";

import { hashCartToken, createCartToken } from "@/lib/cart-token";
import { getDatabase } from "@/lib/db";
import { getSessionHmacSecret } from "@/lib/env";
import {
  cartTokenCookie,
  customerAbsoluteSeconds,
  customerActivityCookie,
  customerIdleSeconds,
  sessionCookieOptions,
} from "@/lib/security/session-policy";
import { createSupabaseServerClient } from "@/lib/supabase/server";

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
  const token = store.get(cartTokenCookie)?.value;
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
  store.set(cartTokenCookie, token, {
    ...sessionCookieOptions,
    maxAge: cartLifetimeSeconds,
    expires: new Date(Date.now() + cartLifetimeSeconds * 1000),
  });
}

export async function optionalCustomerId(): Promise<string | null> {
  const customer = await optionalCustomer();
  return customer?.id ?? null;
}

export async function readCart(): Promise<CartSnapshot | null> {
  const token = await tokenFromCookie();
  if (!token) return null;
  const hash = hashCartToken(token);
  const service = cartService();
  const cart = await service.getByAccessToken(hash);
  if (!cart) return null;
  const customer = await optionalCustomer();
  if (cart.customerId !== null) {
    return customer && customer.id === cart.customerId ? cart : null;
  }
  if (customer) {
    return service.assignCustomer({ accessTokenHash: hash }, customer.id);
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
  if (!token) return null;
  const accessTokenHash = hashCartToken(token);
  const record = await getDatabase().cart.findUnique({
    where: { accessTokenHash },
    select: { customerId: true, status: true },
  });
  if (!record || record.status !== "ACTIVE") return null;
  const customer = await optionalCustomer();
  if (record.customerId !== null) {
    return customer && customer.id === record.customerId ? { accessTokenHash } : null;
  }
  if (customer) {
    await cartService().assignCustomer({ accessTokenHash }, customer.id);
  }
  return { accessTokenHash };
}

export async function claimAssistedCart(token: string): Promise<CartSnapshot> {
  const generated = createCartToken();
  const customer = await optionalCustomer();
  const snapshot = await cartService().claimAssistedCart({
    assistedTokenHash: hashCartToken(token),
    accessTokenHash: generated.hash,
    expiresAt: new Date(Date.now() + cartLifetimeSeconds * 1000),
    customerId: customer?.id ?? null,
  });
  await setCartCookie(generated.token);
  return snapshot;
}
