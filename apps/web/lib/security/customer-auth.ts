import "server-only";

import { verifyTimeoutToken } from "@mundonettech/core";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { getDatabase } from "@/lib/db";
import { getSessionHmacSecret } from "@/lib/env";
import {
  customerAbsoluteSeconds,
  customerActivityCookie,
  customerIdleSeconds,
} from "@/lib/security/session-policy";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function requireCustomerPage() {
  await connection();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) redirect("/ingresar?reason=security");
  const store = await cookies();
  const token = store.get(customerActivityCookie)?.value;
  try {
    if (!token) throw new Error("missing");
    verifyTimeoutToken({
      token,
      expectedKind: "customer",
      expectedSubject: data.user.id,
      secret: getSessionHmacSecret(),
      idleSeconds: customerIdleSeconds,
      maximumAbsoluteSeconds: customerAbsoluteSeconds,
    });
  } catch {
    redirect("/ingresar?reason=timeout");
  }
  const profile = await getDatabase().customer.findFirst({
    where: { authUserId: data.user.id, deletedAt: null, status: "ACTIVE" },
  });
  if (!profile) redirect("/ingresar?reason=security");
  return { user: data.user, profile };
}
