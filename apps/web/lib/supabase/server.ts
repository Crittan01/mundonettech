import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getSupabasePublicConfig } from "@/lib/env";

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const config = getSupabasePublicConfig();
  const isProduction = process.env.NODE_ENV === "production";

  return createServerClient(config.url, config.key, {
    cookieOptions: {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      path: "/",
    },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, {
              ...options,
              httpOnly: true,
              secure: isProduction,
              sameSite: options?.sameSite ?? "lax",
              path: options?.path ?? "/",
            });
          }
        } catch {
          // Proxy refreshes sessions when a Server Component cannot write cookies.
        }
      },
    },
  });
}
