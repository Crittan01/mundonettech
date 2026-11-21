import "server-only";

import { legalConfig } from "@mundonettech/config/legal";
import { buildLegalConfiguration, type LegalDocument } from "@mundonettech/legal-co";
import { cacheLife, cacheTag } from "next/cache";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function readLegalDocuments(): Promise<LegalDocument[]> {
  "use cache";
  cacheLife("max");
  cacheTag("legal", "legal:documents");
  return [...buildLegalConfiguration(legalConfig).documents];
}

export function getLegalOperator() {
  return buildLegalConfiguration(legalConfig).operator;
}

export function getLegalDocuments(): Promise<LegalDocument[]> {
  return readLegalDocuments();
}

export async function getLegalDocument(slug: string): Promise<LegalDocument | null> {
  if (!slugPattern.test(slug) || slug.length > 100) return null;
  const documents = await readLegalDocuments();
  return documents.find((document) => document.slug === slug) ?? null;
}
