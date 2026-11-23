import { randomUUID } from "node:crypto";

export const growthTables = [
  "ReferralCode",
  "Referral",
  "LoyaltyTxn",
  "CustomerSegment",
  "CustomerSegmentMembership",
  "LifecycleJourney",
  "LifecycleStep",
  "LifecycleEnrollment",
  "LifecycleMessage",
];

export async function seedGrowthFixture(client, { checkout, catalog, adminId }) {
  const referrerId = randomUUID();
  const referralId = randomUUID();
  await client.query(
    `INSERT INTO "Customer" ("id", "authUserId", "email", "status") VALUES ($1, $2, $3, 'ACTIVE')`,
    [referrerId, randomUUID(), `growth-matrix-${randomUUID()}@example.test`],
  );
  await client.query(
    `INSERT INTO "ReferralCode" ("customerId", "code") VALUES ($1, '23456789ABCD')`,
    [referrerId],
  );
  const code = await client.query(`SELECT "id" FROM "ReferralCode" WHERE "customerId" = $1`, [
    referrerId,
  ]);
  await client.query(
    `INSERT INTO "Referral" ("id", "codeId", "referrerCustomerId", "referredCustomerId")
     VALUES ($1, $2, $3, $4)`,
    [referralId, code.rows[0].id, referrerId, catalog.customerId],
  );
  await client.query(
    `UPDATE "Referral" SET "status" = 'QUALIFIED', "orderId" = $2, "qualifiedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
    [referralId, checkout.orderId],
  );
  await client.query(`UPDATE "Customer" SET "loyaltyPoints" = 1 WHERE "id" = $1`, [
    catalog.customerId,
  ]);
  await client.query(
    `INSERT INTO "LoyaltyTxn" ("customerId", "orderId", "type", "points", "balanceAfter", "operationKey")
     VALUES ($1, $2, 'EARN', 1, 1, $3)`,
    [catalog.customerId, checkout.orderId, `matrix-loyalty-earn-${randomUUID()}`],
  );
  await client.query(`UPDATE "Customer" SET "loyaltyPoints" = 51 WHERE "id" = $1`, [
    catalog.customerId,
  ]);
  await client.query(
    `INSERT INTO "LoyaltyTxn" ("customerId", "orderId", "referralId", "type", "points", "balanceAfter", "operationKey")
     VALUES ($1, $2, $3, 'REFERRAL_EARN', 50, 51, $4)`,
    [catalog.customerId, checkout.orderId, referralId, `matrix-referral-referred-${randomUUID()}`],
  );
  await client.query(`UPDATE "Customer" SET "loyaltyPoints" = 50 WHERE "id" = $1`, [referrerId]);
  await client.query(
    `INSERT INTO "LoyaltyTxn" ("customerId", "orderId", "referralId", "type", "points", "balanceAfter", "operationKey")
     VALUES ($1, $2, $3, 'REFERRAL_EARN', 50, 50, $4)`,
    [referrerId, checkout.orderId, referralId, `matrix-referral-referrer-${randomUUID()}`],
  );
  const pendingReferredId = randomUUID();
  await client.query(
    `INSERT INTO "Customer" ("id", "authUserId", "email", "status") VALUES ($1, $2, $3, 'ACTIVE')`,
    [pendingReferredId, randomUUID(), `growth-pending-${randomUUID()}@example.test`],
  );
  await client.query(
    `INSERT INTO "Referral" ("codeId", "referrerCustomerId", "referredCustomerId") VALUES ($1, $2, $3)`,
    [code.rows[0].id, referrerId, pendingReferredId],
  );

  const lifecycleCustomerId = randomUUID();
  const lifecycleConsentId = randomUUID();
  const segmentId = randomUUID();
  const journeyId = randomUUID();
  const stepId = randomUUID();
  const membershipId = randomUUID();
  const enrollmentId = randomUUID();
  await client.query(
    `INSERT INTO "Customer" ("id", "authUserId", "email", "status") VALUES ($1, $2, $3, 'ACTIVE')`,
    [lifecycleCustomerId, randomUUID(), `lifecycle-matrix-${randomUUID()}@example.test`],
  );
  await client.query(
    `INSERT INTO "Consent" ("id", "customerId", "purpose", "status", "source", "policyVersion", "proofHash")
     VALUES ($1, $2, 'MARKETING_EMAIL', 'GRANTED', 'rls-matrix', 'v1', decode(repeat('cd', 32), 'hex'))`,
    [lifecycleConsentId, lifecycleCustomerId],
  );
  const segmentDefinition = {
    minFrequency: null,
    maxFrequency: null,
    minNetLtvCents: null,
    maxNetLtvCents: null,
    lastPurchaseWithinDays: null,
    lastPurchaseOlderThanDays: null,
    rfmClass: "PROSPECT",
  };
  await client.query(
    `INSERT INTO "CustomerSegment" (
      "id", "name", "definition", "definitionHash", "createdByAdminUserId", "updatedByAdminUserId"
    ) VALUES ($1, 'Segmento matriz', $2, decode(repeat('ab', 32), 'hex'), $3, $3)`,
    [segmentId, JSON.stringify(segmentDefinition), adminId],
  );
  await client.query(
    `UPDATE "CustomerSegment" SET "status" = 'ACTIVE', "version" = 1, "activatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
    [segmentId],
  );
  await client.query(
    `INSERT INTO "LifecycleJourney" (
      "id", "segmentId", "name", "createdByAdminUserId", "updatedByAdminUserId"
    ) VALUES ($1, $2, 'Journey matriz', $3, $3)`,
    [journeyId, segmentId, adminId],
  );
  await client.query(
    `INSERT INTO "LifecycleStep" (
      "id", "journeyId", "position", "offsetMinutes", "subject", "htmlBody", "textBody", "variables"
    ) VALUES ($1, $2, 0, 0, 'Hola {{customerFirstName}}', '<p>{{storeName}} {{accountUrl}} {{unsubscribeUrl}}</p>',
      '{{storeName}} {{accountUrl}} {{unsubscribeUrl}}',
      '["accountUrl","customerFirstName","storeName","unsubscribeUrl"]'::jsonb)`,
    [stepId, journeyId],
  );
  await client.query(
    `UPDATE "LifecycleJourney" SET "status" = 'ACTIVE', "version" = 1, "segmentVersion" = 1, "activatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
    [journeyId],
  );
  const draftSegmentId = randomUUID();
  const draftJourneyId = randomUUID();
  await client.query(
    `INSERT INTO "CustomerSegment" (
      "id", "name", "definition", "definitionHash", "createdByAdminUserId", "updatedByAdminUserId"
    ) VALUES ($1, 'Segmento borrador matriz', $2, decode(repeat('ab', 32), 'hex'), $3, $3)`,
    [draftSegmentId, JSON.stringify(segmentDefinition), adminId],
  );
  await client.query(
    `INSERT INTO "LifecycleJourney" (
      "id", "segmentId", "name", "createdByAdminUserId", "updatedByAdminUserId"
    ) VALUES ($1, $2, 'Journey borrador matriz', $3, $3)`,
    [draftJourneyId, draftSegmentId, adminId],
  );
  await client.query(
    `INSERT INTO "LifecycleStep" (
      "journeyId", "position", "offsetMinutes", "subject", "htmlBody", "textBody", "variables"
    ) VALUES ($1, 0, 0, 'Hola {{customerFirstName}}', '<p>{{storeName}} {{accountUrl}} {{unsubscribeUrl}}</p>',
      '{{storeName}} {{accountUrl}} {{unsubscribeUrl}}',
      '["accountUrl","customerFirstName","storeName","unsubscribeUrl"]'::jsonb)`,
    [draftJourneyId],
  );
  await client.query(
    `INSERT INTO "CustomerSegmentMembership" (
      "id", "segmentId", "customerId", "consentId", "sequence", "segmentVersion", "status",
      "reason", "metrics", "definitionHash"
    ) VALUES ($1, $2, $3, $4, 1, 1, 'ENTERED', 'QUALIFIED', $5, decode(repeat('ab', 32), 'hex'))`,
    [
      membershipId,
      segmentId,
      lifecycleCustomerId,
      lifecycleConsentId,
      JSON.stringify({
        recencyDays: null,
        frequency: "0",
        ltvCents: "0",
        refundExcessCents: "0",
        rfmClass: "PROSPECT",
        scores: { recency: 0, frequency: 0, monetary: 0 },
      }),
    ],
  );
  await client.query(
    `INSERT INTO "LifecycleEnrollment" ("id", "journeyId", "customerId", "entryMembershipId", "consentId")
     VALUES ($1, $2, $3, $4, $5)`,
    [enrollmentId, journeyId, lifecycleCustomerId, membershipId, lifecycleConsentId],
  );
  await client.query(
    `INSERT INTO "LifecycleMessage" ("enrollmentId", "stepId", "customerId", "scheduledAt")
     VALUES ($1, $2, $3, (SELECT "enteredAt" FROM "LifecycleEnrollment" WHERE "id" = $1))`,
    [enrollmentId, stepId, lifecycleCustomerId],
  );
  return { referralId, referrerId };
}
