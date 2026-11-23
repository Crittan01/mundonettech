import { randomBytes, randomUUID } from "node:crypto";

export const b2bTables = [
  "PriceList",
  "PriceListItem",
  "Opportunity",
  "OpportunityProposal",
  "OpportunityProposalItem",
  "OpportunityCopilotRun",
];

export async function seedB2bFixture(client, { adminId, catalog, crm }) {
  const priceListId = randomUUID();
  const priceListItemId = randomUUID();
  const opportunityId = randomUUID();
  const proposalId = randomUUID();
  const proposalItemId = randomUUID();
  const copilotRunId = randomUUID();
  const credentialId = randomUUID();
  await client.query(
    `INSERT INTO "PriceList" ("id", "code", "name", "description") VALUES ($1, $2, 'Lista B2B para matriz RLS', 'Fixture persistente sin exposición pública.')`,
    [priceListId, `B2B-${randomUUID().slice(0, 8).toUpperCase()}`],
  );
  await client.query(
    `INSERT INTO "PriceListItem" ("id", "priceListId", "variantId", "unitPriceCents") VALUES ($1, $2, $3, 90000)`,
    [priceListItemId, priceListId, catalog.variantId],
  );
  await client.query(
    `INSERT INTO "Opportunity" (
       "id", "organizationId", "contactId", "source", "requirements", "privacyPolicyVersion", "acceptanceProofHash", "acceptedAt"
     ) VALUES ($1, $2, $3, 'rls-matrix', 'Compra empresarial persistente para validar seguridad.', 'v1', $4, CURRENT_TIMESTAMP)`,
    [opportunityId, crm.organizationId, crm.sourceContactId, randomBytes(32)],
  );
  await client.query(
    `INSERT INTO "OpportunityProposal" (
       "id", "opportunityId", "version", "contentHash", "priceListId", "priceListCodeSnapshot", "priceListVersionSnapshot",
       "subtotalCents", "discountCents", "taxCents", "shippingCents", "totalCents", "taxRegime", "uvtValueCents", "uvtYear",
       "deliveryPromiseDays", "reservationMinutes", "expiresAt", "createdByAdminUserId"
     ) VALUES ($1, $2, 1, $3, $4, 'RLS-B2B', 0, 100000, 10000, 0, 5000, 95000, 'NO_RESPONSABLE_IVA', 5237400, 2026, 30, 120, CURRENT_TIMESTAMP + INTERVAL '7 days', $5)`,
    [proposalId, opportunityId, randomBytes(32), priceListId, adminId],
  );
  await client.query(
    `INSERT INTO "OpportunityProposalItem" (
       "id", "proposalId", "variantId", "quantity", "titleSnapshot", "productSlugSnapshot", "skuSnapshot",
       "catalogUnitPriceCents", "unitPriceCents", "discountCents", "lineTotalCents", "taxGroupCode", "taxGroupName",
       "treatment", "taxRule", "catalogRateBps", "appliedRateBps", "unitValueCents", "taxableBaseCents", "taxCents"
     ) VALUES ($1, $2, $3, 1, 'Audífonos TÁCTILES Pro', $4, $5, 100000, 90000, 10000, 90000, 'GENERAL', 'IVA general', 'STANDARD', 'NOT_RESPONSABLE', 1900, 0, 90000, 90000, 0)`,
    [proposalItemId, proposalId, catalog.variantId, `product-${catalog.productId}`, catalog.sku],
  );
  await client.query(
    `INSERT INTO "IntegrationCredential" (
       "id", "provider", "environment", "accountName", "keyVersion", "nonce", "ciphertext", "authTag", "createdByAdminUserId"
     ) VALUES ($1, 'gemini', 'LOCAL', 'rls-copilot', 1, $2, $3, $4, $5)`,
    [credentialId, randomBytes(12), randomBytes(32), randomBytes(16), adminId],
  );
  await client.query(
    `INSERT INTO "OpportunityCopilotRun" (
       "id", "opportunityId", "credentialId", "model", "inputHash", "promptHash", "requestedByAdminUserId"
     ) VALUES ($1, $2, $3, 'gemini-test', $4, $5, $6)`,
    [copilotRunId, opportunityId, credentialId, randomBytes(32), randomBytes(32), adminId],
  );
  return {
    priceListId,
    priceListItemId,
    opportunityId,
    proposalId,
    proposalItemId,
    copilotRunId,
    credentialId,
  };
}
