import { resolveMercadoLibreOAuthCookiePolicy } from "@mundonettech/integrations";

export const adminIdleSeconds = 30 * 60;
export const adminAbsoluteSeconds = 12 * 60 * 60;
export const customerIdleSeconds = 30 * 24 * 60 * 60;
export const customerAbsoluteSeconds = customerIdleSeconds;
export const factorResetSeconds = 10 * 60;
export const recentMfaSeconds = 10 * 60;

export const adminActivityCookie =
  process.env.NODE_ENV === "production" ? "__Host-admin_activity" : "admin_activity";
export const customerActivityCookie =
  process.env.NODE_ENV === "production" ? "__Host-customer_activity" : "customer_activity";
export const factorResetCookie =
  process.env.NODE_ENV === "production" ? "__Host-admin_factor_reset" : "admin_factor_reset";
export const cartTokenCookie =
  process.env.NODE_ENV === "production" ? "__Host-cart_token" : "cart_token";
export const guestOrderCookie =
  process.env.NODE_ENV === "production" ? "__Host-guest_order" : "guest_order";
export const referralCookie =
  process.env.NODE_ENV === "production" ? "__Host-mnt_referral" : "mnt_referral";

const channelOAuthCookiePolicy = resolveMercadoLibreOAuthCookiePolicy(process.env);
export const channelOAuthCookieSecure = channelOAuthCookiePolicy.secure;
export const channelOAuthCookie = channelOAuthCookiePolicy.name;
export const channelOAuthCookiePath = channelOAuthCookiePolicy.path;

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};
