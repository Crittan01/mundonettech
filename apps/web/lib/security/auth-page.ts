import "server-only";

import { headers } from "next/headers";

import { getTurnstileKeys } from "@/lib/env";

export async function getAuthPageSecurity(): Promise<{ siteKey: string; nonce: string }> {
  const store = await headers();
  const nonce = store.get("x-nonce");
  if (!nonce) throw new Error("Missing request security nonce.");
  return { siteKey: getTurnstileKeys().siteKey, nonce };
}
