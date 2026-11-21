import "server-only";

import {
  hasAdminPermission,
  isAdminRole,
  verifyTimeoutToken,
  type AdminPermission,
  type AdminRoleValue,
} from "@mundonettech/core";
import type { AdminUser } from "@mundonettech/db";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { getDatabase } from "@/lib/db";
import { getSessionHmacSecret } from "@/lib/env";
import {
  adminActivityCookie,
  adminIdleSeconds,
  adminAbsoluteSeconds,
  recentMfaSeconds,
} from "@/lib/security/session-policy";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export class AdminAuthorizationError extends Error {
  constructor(
    readonly code: "NO_SESSION" | "NO_PROFILE" | "AAL1" | "TIMEOUT" | "FORBIDDEN" | "MFA_STALE",
  ) {
    super(code);
    this.name = "AdminAuthorizationError";
  }
}

export interface AdminSession {
  supabase: SupabaseClient;
  user: User;
  profile: Omit<AdminUser, "role"> & { role: AdminRoleValue };
  lastMfaAt: Date | null;
}

function latestMfaTimestamp(
  methods: { method: string; timestamp: number }[] | string[],
): number | null {
  const timestamps = methods
    .filter((entry): entry is { method: string; timestamp: number } => typeof entry !== "string")
    .filter(
      (entry) => ["otp", "totp"].includes(entry.method) && Number.isSafeInteger(entry.timestamp),
    )
    .map((entry) => entry.timestamp);
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

export async function getAdminSession(
  options: {
    permission?: AdminPermission;
    requireAal2?: boolean;
    requireRecentMfa?: boolean;
  } = {},
): Promise<AdminSession> {
  await connection();
  const supabase = await createSupabaseServerClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new AdminAuthorizationError("NO_SESSION");
  const profile = await getDatabase().adminUser.findFirst({
    where: { authUserId: userData.user.id, status: "ACTIVE", deletedAt: null },
  });
  if (!profile || !isAdminRole(profile.role)) throw new AdminAuthorizationError("NO_PROFILE");
  if (options.permission && !hasAdminPermission(profile.role, options.permission)) {
    throw new AdminAuthorizationError("FORBIDDEN");
  }

  const { data: aal, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalError || !aal) throw new AdminAuthorizationError("NO_SESSION");
  const timestamp = latestMfaTimestamp(aal.currentAuthenticationMethods);
  const lastMfaAt = timestamp ? new Date(timestamp * 1000) : null;
  if (options.requireAal2 !== false && aal.currentLevel !== "aal2") {
    throw new AdminAuthorizationError("AAL1");
  }
  if (options.requireAal2 !== false) {
    const store = await cookies();
    const token = store.get(adminActivityCookie)?.value;
    try {
      if (!token) throw new Error("missing");
      verifyTimeoutToken({
        token,
        expectedKind: "admin",
        expectedSubject: userData.user.id,
        secret: getSessionHmacSecret(),
        idleSeconds: adminIdleSeconds,
        maximumAbsoluteSeconds: adminAbsoluteSeconds,
      });
    } catch {
      throw new AdminAuthorizationError("TIMEOUT");
    }
  }
  if (
    options.requireRecentMfa &&
    (!lastMfaAt ||
      Date.now() - lastMfaAt.getTime() > recentMfaSeconds * 1000 ||
      lastMfaAt.getTime() > Date.now() + 30_000)
  ) {
    throw new AdminAuthorizationError("MFA_STALE");
  }
  return { supabase, user: userData.user, profile: profile as AdminSession["profile"], lastMfaAt };
}

export async function requireAdminPage(
  permission: AdminPermission = "dashboard:read",
): Promise<AdminSession> {
  try {
    return await getAdminSession({ permission });
  } catch (error) {
    if (error instanceof AdminAuthorizationError) {
      if (error.code === "AAL1") redirect("/admin/login/mfa");
      redirect(`/admin/login?reason=${error.code === "TIMEOUT" ? "timeout" : "security"}`);
    }
    throw error;
  }
}
