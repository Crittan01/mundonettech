import { randomUUID } from "node:crypto";

export const growthTables = ["ReferralCode", "Referral", "LoyaltyTxn"];

export async function seedGrowthFixture(client, { checkout, catalog }) {
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
  return { referralId, referrerId };
}
