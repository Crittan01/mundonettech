import "server-only";

import { legalConfig } from "@mundonettech/config/legal";
import { AccountService, PostSaleService, type PrismaClient } from "@mundonettech/db";

import { getDatabase } from "@/lib/db";

const privacyPolicyVersion = legalConfig.documents.find(
  (document) => document.slug === "tratamiento-datos-personales",
)?.version;
if (!privacyPolicyVersion) throw new Error("Privacy policy configuration is missing.");

export function accountService(db: PrismaClient = getDatabase()): AccountService {
  return new AccountService(db, { privacyPolicyVersion: privacyPolicyVersion! });
}

export function postSaleService(db: PrismaClient = getDatabase()): PostSaleService {
  return new PostSaleService(db);
}
