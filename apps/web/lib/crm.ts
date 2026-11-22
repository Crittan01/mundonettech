import "server-only";

import { legalConfig } from "@mundonettech/config/legal";
import {
  CrmMergeService,
  CrmRetentionService,
  CrmService,
  type PrismaClient,
} from "@mundonettech/db";

import { getDatabase } from "@/lib/db";

export const crmPrivacyPolicyVersion = legalConfig.documents.find(
  (document) => document.slug === "tratamiento-datos-personales",
)?.version;

if (!crmPrivacyPolicyVersion) throw new Error("Privacy policy configuration is missing.");

export function crmService(db: PrismaClient = getDatabase()): CrmService {
  return new CrmService(db);
}

export function crmMergeService(db: PrismaClient = getDatabase()): CrmMergeService {
  return new CrmMergeService(db);
}

export function crmRetentionService(db: PrismaClient = getDatabase()): CrmRetentionService {
  return new CrmRetentionService(db);
}
