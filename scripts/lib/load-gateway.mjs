import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import pg from "pg";

import {
  CartService,
  OrderService,
  PaymentProvider,
  createDatabaseClient,
  reserveStock,
} from "../../packages/db/dist/index.js";
import { PaymentService, StoreCreditService } from "../../packages/integrations/dist/index.js";
import { loadPlan } from "../load/plan.js";
import { seedCatalogFixture } from "./catalog-test-fixture.mjs";
import { seedInventoryFixture } from "./inventory-test-fixture.mjs";

const checkoutDefaults = {
  taxRegime: "NO_RESPONSABLE_IVA",
  currency: "COP",
  timeZone: "America/Bogota",
  orderNumberPrefix: "MNT",
  orderNumberPadding: 4,
  uvtValueCents: 5_237_400n,
  uvtYear: 2026,
  standardShippingCents: 0n,
  deliveryPromiseDays: 30,
  reservationMinutes: 120,
  clickAndCollectEnabled: false,
};
const expectedDomainErrors = new Set([
  "CartStateError",
  "CartStockError",
  "CheckoutConflictError",
  "CheckoutCouponError",
  "CheckoutStockError",
  "CouponError",
  "InsufficientStockError",
  "InventoryConflictError",
  "PaymentConflictError",
]);

function future(hours = 72) {
  return new Date(Date.now() + hours * 3_600_000);
}

function hash() {
  return randomBytes(32).toString("hex");
}

function bytes(value) {
  return Uint8Array.from(Buffer.from(value, "hex"));
}

function contact(email) {
  return {
    email,
    givenName: "Laura",
    familyName: "Rodríguez",
    recipientName: "Laura Rodríguez",
    phoneE164: "+573001234567",
    buyerDocumentType: "13",
    buyerDocumentNumber: "1020304050",
    buyerTaxRegime: "NO_RESPONSABLE_IVA",
    termsVersion: "1.0.0",
    privacyPolicyVersion: "1.0.0",
    acceptanceProofHash: hash(),
    acceptanceIpHash: hash(),
    acceptanceUserAgentHash: hash(),
  };
}

function checkoutSubmission(cartId, email, expectedReviewFingerprint) {
  return {
    cartId,
    contact: contact(email),
    expectedReviewFingerprint,
    receiptAccessTokenHash: hash(),
    idempotency: {
      keyHash: hash(),
      subjectHash: hash(),
      requestHash: hash(),
      expiresAt: future(1).toISOString(),
    },
  };
}

function reviveCheckout(submission) {
  return {
    cart: { cartId: submission.cartId },
    contact: {
      ...submission.contact,
      acceptanceProofHash: bytes(submission.contact.acceptanceProofHash),
      acceptanceIpHash: bytes(submission.contact.acceptanceIpHash),
      acceptanceUserAgentHash: bytes(submission.contact.acceptanceUserAgentHash),
    },
    fulfillment: {
      method: "HOME_DELIVERY",
      departmentCode: "11",
      municipalityCode: "11001",
      addressLine1: "Carrera 7 # 71-21",
      neighborhood: "Chapinero",
      postalCode: "110231",
    },
    idempotency: {
      keyHash: bytes(submission.idempotency.keyHash),
      subjectHash: bytes(submission.idempotency.subjectHash),
      requestHash: bytes(submission.idempotency.requestHash),
      expiresAt: new Date(submission.idempotency.expiresAt),
    },
    receiptAccessTokenHash: bytes(submission.receiptAccessTokenHash),
    expectedReviewFingerprint: submission.expectedReviewFingerprint,
  };
}

function isPgSqlState(value) {
  return typeof value === "string" && /^[0-9A-Z]{5}$/.test(value) && !/^P\d{4}$/.test(value);
}

function errorCode(error) {
  const visited = new Set();
  const stack = [error];
  let firstCode = null;
  let pgCode = null;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);

    for (const candidate of [current.originalCode, current.code, current.meta?.code]) {
      if (typeof candidate !== "string" || candidate.length === 0) continue;
      if (candidate === "40P01") return "40P01";
      if (!firstCode) firstCode = candidate;
      if (!pgCode && isPgSqlState(candidate)) pgCode = candidate;
    }

    if (current.driverAdapterError) stack.push(current.driverAdapterError);
    if (current.cause) stack.push(current.cause);
    if (current.meta) stack.push(current.meta);
  }

  return pgCode ?? firstCode;
}

function authenticated(request, token) {
  const supplied = request.headers.authorization ?? "";
  const left = createHash("sha256").update(supplied).digest();
  const right = createHash("sha256").update(`Bearer ${token}`).digest();
  return timingSafeEqual(left, right);
}

function json(response, status, payload) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

async function body(request) {
  const length = Number(request.headers["content-length"] ?? 0);
  if (!Number.isSafeInteger(length) || length < 2 || length > 65_536) {
    throw new RangeError("Invalid request size.");
  }
  let text = "";
  for await (const chunk of request) {
    text += chunk.toString("utf8");
    if (Buffer.byteLength(text, "utf8") > 65_536) throw new RangeError("Invalid request size.");
  }
  return JSON.parse(text);
}

export async function startLoadGateway({ databaseUrl, port = 54427 }) {
  const sql = new pg.Client({ connectionString: databaseUrl });
  await sql.connect();
  const db = createDatabaseClient({ databaseUrl, maxConnections: 32 });
  const carts = new CartService(db);
  const orders = new OrderService(db, checkoutDefaults);
  const payments = new PaymentService(db);
  const credits = new StoreCreditService(db);
  const stats = { deadlocks: 0, unexpected: 0 };
  const token = randomBytes(32).toString("base64url");

  async function domainFixture() {
    const catalog = await seedCatalogFixture(sql);
    const inventory = await seedInventoryFixture(sql, catalog);
    return {
      variantId: catalog.variantId,
      locationId: inventory.locationId,
      customerId: catalog.customerId,
    };
  }

  async function makeCart(variantId, customerId) {
    const cart = await carts.createStorefrontCart({
      accessTokenHash: randomBytes(32),
      expiresAt: future(24 * 30),
      ...(customerId ? { customerId } : {}),
    });
    await carts.addVariant({ cartId: cart.id }, variantId, 1);
    return cart;
  }

  try {
    const adminId = randomUUID();
    await db.adminUser.create({
      data: {
        id: adminId,
        authUserId: randomUUID(),
        email: `load-finance-${randomUUID()}@example.test`,
        displayName: "Finanzas de carga",
        role: "SUPERADMIN",
        status: "ACTIVE",
      },
    });
    const audit = {
      actorAdminUserId: adminId,
      ipHash: randomBytes(32),
      userAgentHash: randomBytes(32),
      requestId: randomUUID(),
    };

    const stockFirst = await domainFixture();
    const stockSecond = await domainFixture();

    const couponFixture = await domainFixture();
    const couponId = randomUUID();
    const couponCode = `K6-${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`;
    await sql.query(
      `INSERT INTO "Coupon" ("id", "code", "name", "discountType", "status", "percentageBps", "maximumUsages")
       VALUES ($1, $2, 'Cupón de contención k6', 'PERCENTAGE', 'ACTIVE', 1000, $3)`,
      [couponId, couponCode, loadPlan.couponCapacity],
    );
    const couponCartIds = [];
    for (let index = 0; index < loadPlan.couponAttempts; index += 1) {
      const cart = await makeCart(couponFixture.variantId);
      couponCartIds.push(cart.id);
    }

    const checkoutFixture = await domainFixture();
    const checkoutSubmissions = [];
    for (let index = 0; index < loadPlan.checkoutAttempts; index += 1) {
      const cart = await makeCart(checkoutFixture.variantId);
      const preview = await orders.preview({ cartId: cart.id });
      checkoutSubmissions.push(
        checkoutSubmission(
          cart.id,
          `load-checkout-${index}-${randomUUID()}@example.test`,
          preview.homeDelivery.reviewFingerprint,
        ),
      );
    }

    const paymentFixture = await domainFixture();
    const paymentOrders = [];
    const paymentCustomerIds = [];
    for (let index = 0; index < loadPlan.paymentOrders; index += 1) {
      const customer = await db.customer.create({
        data: {
          id: randomUUID(),
          authUserId: randomUUID(),
          email: `load-credit-${index}-${randomUUID()}@example.test`,
          status: "ACTIVE",
        },
      });
      paymentCustomerIds.push(customer.id);
      const cart = await makeCart(paymentFixture.variantId, customer.id);
      const preview = await orders.preview({ cartId: cart.id });
      const submission = checkoutSubmission(
        cart.id,
        customer.email,
        preview.homeDelivery.reviewFingerprint,
      );
      const result = await orders.checkout(reviveCheckout(submission));
      const credit = await credits.adjust({
        customerId: customer.id,
        type: "GRANT",
        amountCents: BigInt(result.totalCents),
        operationKey: `k6-credit-grant-${result.orderId}`,
        reason: "Saldo exacto para prueba de contención.",
        audit,
      });
      paymentOrders.push({
        orderId: result.orderId,
        totalCents: result.totalCents,
        creditAccountId: credit.id,
      });
    }

    const fixtures = {
      stock: { first: stockFirst, second: stockSecond },
      coupons: {
        couponId,
        code: couponCode,
        cartIds: couponCartIds,
        variantId: couponFixture.variantId,
        locationId: couponFixture.locationId,
      },
      checkout: {
        submissions: checkoutSubmissions,
        variantId: checkoutFixture.variantId,
        locationId: checkoutFixture.locationId,
      },
      payments: {
        orders: paymentOrders,
        customerIds: paymentCustomerIds,
        variantId: paymentFixture.variantId,
        locationId: paymentFixture.locationId,
      },
    };

    async function execute(type, input) {
      switch (type) {
        case "stock.reserve": {
          const result = await reserveStock(db, input);
          return { operationKey: result.operationKey, replayed: result.replayed };
        }
        case "coupon.apply": {
          const result = await carts.applyCoupon({ cartId: input.cartId }, input.code);
          return { cartId: result.id, couponId: result.coupon?.id ?? null };
        }
        case "order.checkout":
          return orders.checkout(reviveCheckout(input));
        case "payment.storeCredit": {
          const result = await payments.start({
            orderId: input.orderId,
            provider: PaymentProvider.STORE_CREDIT,
            environment: "LOCAL",
            amountCents: BigInt(input.amountCents),
            idempotencyKey: input.idempotencyKey,
          });
          return { attemptId: result.id, status: result.status, replayed: result.replayed };
        }
        default:
          throw new TypeError("Unknown load operation.");
      }
    }

    async function verify() {
      const checks = [];
      const check = (name, actual, expected) => {
        checks.push({ name, actual, expected, passed: Object.is(actual, expected) });
      };
      for (const [name, fixture] of [
        ["stock.first", stockFirst],
        ["stock.second", stockSecond],
      ]) {
        const result = await sql.query(
          `SELECT "onHand", "committed", "safetyStock" FROM "StockLevel"
           WHERE "variantId" = $1 AND "locationId" = $2`,
          [fixture.variantId, fixture.locationId],
        );
        const level = result.rows[0];
        check(`${name}.onHand`, level?.onHand, 10);
        check(`${name}.committed`, level?.committed, loadPlan.stockCapacity);
        check(`${name}.safetyStock`, level?.safetyStock, 2);
        const ledger = await sql.query(
          `SELECT count(*)::int AS count FROM "InventoryLedger"
           WHERE "variantId" = $1 AND "locationId" = $2 AND "entryType" = 'RESERVATION'`,
          [fixture.variantId, fixture.locationId],
        );
        check(`${name}.reservations`, ledger.rows[0]?.count, loadPlan.stockCapacity);
      }

      const couponCounts = await sql.query(
        `SELECT
          count(*) FILTER (WHERE "status" = 'RESERVED')::int AS reserved,
          count(*) FILTER (WHERE "status" = 'REDEEMED')::int AS redeemed,
          count(*)::int AS total
         FROM "CouponUsage" WHERE "couponId" = $1`,
        [couponId],
      );
      check("coupons.reserved", couponCounts.rows[0]?.reserved, loadPlan.couponCapacity);
      check("coupons.redeemed", couponCounts.rows[0]?.redeemed, 0);
      check("coupons.total", couponCounts.rows[0]?.total, loadPlan.couponCapacity);

      const cartIds = checkoutSubmissions.map((submission) => submission.cartId);
      const checkoutOrders = await sql.query(
        `SELECT count(*)::int AS count,
          count(*) FILTER (WHERE "paymentStatus" = 'UNPAID')::int AS unpaid
         FROM "Order" WHERE "cartId" = ANY($1::uuid[])`,
        [cartIds],
      );
      check("checkout.orders", checkoutOrders.rows[0]?.count, loadPlan.checkoutCapacity);
      check("checkout.unpaid", checkoutOrders.rows[0]?.unpaid, loadPlan.checkoutCapacity);
      const checkoutStock = await sql.query(
        `SELECT "onHand", "committed", "safetyStock" FROM "StockLevel"
         WHERE "variantId" = $1 AND "locationId" = $2`,
        [checkoutFixture.variantId, checkoutFixture.locationId],
      );
      check("checkout.stock.onHand", checkoutStock.rows[0]?.onHand, 10);
      check("checkout.stock.committed", checkoutStock.rows[0]?.committed, 8);
      check("checkout.stock.safetyStock", checkoutStock.rows[0]?.safetyStock, 2);
      const checkoutReceipts = await sql.query(
        `SELECT count(*)::int AS count FROM "OrderReceipt" receipt
         JOIN "Order" orders ON orders."id" = receipt."orderId"
         WHERE orders."cartId" = ANY($1::uuid[])`,
        [cartIds],
      );
      check("checkout.receipts", checkoutReceipts.rows[0]?.count, loadPlan.checkoutCapacity);

      const paymentOrderIds = paymentOrders.map((order) => order.orderId);
      const paidOrders = await sql.query(
        `SELECT count(*)::int AS count,
          count(*) FILTER (WHERE "paymentStatus" = 'PAID')::int AS paid,
          sum("totalCents") AS total
         FROM "Order" WHERE "id" = ANY($1::uuid[])`,
        [paymentOrderIds],
      );
      check("payments.orders", paidOrders.rows[0]?.count, loadPlan.paymentOrders);
      check("payments.paid", paidOrders.rows[0]?.paid, loadPlan.paymentOrders);
      check(
        "payments.orderTotal",
        paidOrders.rows[0]?.total,
        paymentOrders.reduce((sum, order) => sum + BigInt(order.totalCents), 0n).toString(),
      );
      const attempts = await sql.query(
        `SELECT "orderId", count(*)::int AS attempts,
          count(*) FILTER (WHERE "status" = 'SUCCEEDED')::int AS succeeded
         FROM "PaymentAttempt" WHERE "orderId" = ANY($1::uuid[]) GROUP BY "orderId"`,
        [paymentOrderIds],
      );
      check("payments.attemptRows", attempts.rows.length, loadPlan.paymentOrders);
      for (const row of attempts.rows) {
        check(`payments.attempts.${row.orderId}`, row.attempts, 1);
        check(`payments.succeeded.${row.orderId}`, row.succeeded, 1);
      }
      const captures = await sql.query(
        `SELECT count(*)::int AS count, sum(transaction."amountCents") AS total
         FROM "PaymentTransaction" transaction
         JOIN "PaymentAttempt" attempt ON attempt."id" = transaction."attemptId"
         WHERE attempt."orderId" = ANY($1::uuid[])
           AND transaction."kind" = 'CAPTURE' AND transaction."status" = 'SUCCEEDED'`,
        [paymentOrderIds],
      );
      check("payments.captures", captures.rows[0]?.count, loadPlan.paymentOrders);
      check("payments.capturedTotal", captures.rows[0]?.total, paidOrders.rows[0]?.total);
      const fulfillments = await sql.query(
        `SELECT count(*)::int AS count FROM "InventoryLedger"
         WHERE "orderId" = ANY($1::uuid[]) AND "entryType" = 'FULFILLMENT'`,
        [paymentOrderIds],
      );
      check("payments.fulfillments", fulfillments.rows[0]?.count, loadPlan.paymentOrders);
      const paymentStock = await sql.query(
        `SELECT "onHand", "committed", "safetyStock" FROM "StockLevel"
         WHERE "variantId" = $1 AND "locationId" = $2`,
        [paymentFixture.variantId, paymentFixture.locationId],
      );
      check("payments.stock.onHand", paymentStock.rows[0]?.onHand, 2);
      check("payments.stock.committed", paymentStock.rows[0]?.committed, 0);
      check("payments.stock.safetyStock", paymentStock.rows[0]?.safetyStock, 2);
      const creditAccounts = await sql.query(
        `SELECT "id", "availableCents", "heldCents", "version" FROM "StoreCreditAccount"
         WHERE "customerId" = ANY($1::uuid[]) ORDER BY "id"`,
        [paymentCustomerIds],
      );
      check("payments.creditAccounts", creditAccounts.rows.length, loadPlan.paymentOrders);
      for (const account of creditAccounts.rows) {
        check(`payments.credit.available.${account.id}`, account.availableCents, "0");
        check(`payments.credit.held.${account.id}`, account.heldCents, "0");
      }
      const creditEntries = await sql.query(
        `SELECT "accountId", count(*)::int AS count FROM "StoreCreditEntry"
         WHERE "accountId" = ANY($1::uuid[]) GROUP BY "accountId"`,
        [paymentOrders.map((order) => order.creditAccountId)],
      );
      check("payments.creditEntryRows", creditEntries.rows.length, loadPlan.paymentOrders);
      for (const row of creditEntries.rows) {
        check(`payments.creditEntries.${row.accountId}`, row.count, 3);
      }
      const negativeStock = await sql.query(
        `SELECT count(*)::int AS count FROM "StockLevel"
         WHERE ("onHand" - "committed" - "safetyStock") < 0
           AND "variantId" = ANY($1::uuid[])`,
        [
          [
            stockFirst.variantId,
            stockSecond.variantId,
            couponFixture.variantId,
            checkoutFixture.variantId,
            paymentFixture.variantId,
          ],
        ],
      );
      check("stock.negativeAvailable", negativeStock.rows[0]?.count, 0);
      const negativeCredits = await sql.query(
        `SELECT count(*)::int AS count FROM "StoreCreditAccount"
         WHERE ("availableCents" < 0 OR "heldCents" < 0)
           AND "customerId" = ANY($1::uuid[])`,
        [paymentCustomerIds],
      );
      check("credits.negativeBalances", negativeCredits.rows[0]?.count, 0);
      const allLoadOrderIds = [
        ...paymentOrderIds,
        ...(
          await sql.query(`SELECT "id" FROM "Order" WHERE "cartId" = ANY($1::uuid[])`, [cartIds])
        ).rows.map((row) => row.id),
      ];
      const unbalancedOrders = await sql.query(
        `SELECT count(*)::int AS count,
          count(DISTINCT "orderNumber")::int AS distinct_numbers
         FROM "Order"
         WHERE "id" = ANY($1::uuid[])`,
        [allLoadOrderIds],
      );
      check(
        "orders.uniqueSequentialNumbers",
        unbalancedOrders.rows[0]?.distinct_numbers,
        allLoadOrderIds.length,
      );
      const receiptMismatches = await sql.query(
        `SELECT count(*)::int AS count
         FROM "OrderReceipt" receipt
         JOIN "Order" orders ON orders."id" = receipt."orderId"
         WHERE orders."id" = ANY($1::uuid[])
           AND (
             receipt."subtotalCents" - receipt."discountCents" + receipt."taxCents" + receipt."shippingCents" <> receipt."totalCents"
             OR receipt."totalCents" <> orders."totalCents"
           )`,
        [allLoadOrderIds],
      );
      check("receipts.arithmeticMismatches", receiptMismatches.rows[0]?.count, 0);
      const leakedOutboxPii = await sql.query(
        `SELECT count(*)::int AS count
         FROM "DomainOutbox"
         WHERE "aggregateId" = ANY($1::text[])
           AND (
             "payload"::text ILIKE '%@example.test%'
             OR "payload"::text ILIKE '%+57300%'
             OR "payload"::text ILIKE '%Carrera 7%'
             OR "payload"::text ILIKE '%1020304050%'
           )`,
        [allLoadOrderIds],
      );
      check("outbox.piiLeaks", leakedOutboxPii.rows[0]?.count, 0);
      check("gateway.deadlocks", stats.deadlocks, 0);
      check("gateway.unexpected", stats.unexpected, 0);
      return { passed: checks.every((entry) => entry.passed), checks };
    }

    const server = createServer(async (request, response) => {
      if (!authenticated(request, token)) {
        json(response, 401, { outcome: "unauthorized" });
        return;
      }
      try {
        if (request.method === "GET" && request.url === "/fixtures") {
          json(response, 200, fixtures);
          return;
        }
        if (request.method === "GET" && request.url === "/verify") {
          json(response, 200, await verify());
          return;
        }
        if (request.method === "POST" && request.url === "/operation") {
          if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
            json(response, 415, { outcome: "unsupported_media_type" });
            return;
          }
          const payload = await body(request);
          try {
            const result = await execute(payload.type, payload.input);
            json(response, 200, { outcome: "ok", result });
          } catch (error) {
            const code = errorCode(error);
            if (code === "40P01") stats.deadlocks += 1;
            if (expectedDomainErrors.has(error?.name)) {
              json(response, 409, { outcome: "rejected", errorName: error.name, code });
            } else {
              stats.unexpected += 1;
              console.error("Unexpected k6 domain operation failure.", error);
              json(response, 500, { outcome: "error", errorName: error?.name, code });
            }
          }
          return;
        }
        json(response, 404, { outcome: "not_found" });
      } catch (error) {
        stats.unexpected += 1;
        json(response, 400, { outcome: "invalid_request", errorName: error?.name });
      }
    });
    server.requestTimeout = 130_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 1_000;
    server.maxConnections = 64;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    return {
      origin: `http://127.0.0.1:${port}`,
      token,
      verify,
      async close() {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await db.$disconnect();
        await sql.end();
      },
    };
  } catch (error) {
    await db.$disconnect();
    await sql.end();
    throw error;
  }
}
