import { randomBytes, randomUUID } from "node:crypto";

export async function createPublishedReviewFixtures(db, options) {
  const variant = await db.productVariant.findFirstOrThrow({
    where: {
      product: { slug: options.productSlug, status: "ACTIVE", deletedAt: null },
      status: "ACTIVE",
      deletedAt: null,
    },
    include: { product: true },
    orderBy: [{ isDefault: "desc" }, { id: "asc" }],
  });
  const order = await db.order.create({
    data: {
      orderNumber: `E2E-REVIEW-${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`,
      customerId: options.customerId,
      orderStatus: "CONFIRMED",
      paymentStatus: "PAID",
      fulfillmentStatus: "FULFILLED",
      taxRegime: "NO_RESPONSABLE_IVA",
      subtotalCents: BigInt(options.reviews.length) * variant.priceCents,
      totalCents: BigInt(options.reviews.length) * variant.priceCents,
      confirmedAt: new Date(),
    },
  });
  const location = await db.stockLocation.create({
    data: {
      code: `E2E-REVIEW-${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`,
      name: "Origen de reseñas entregadas E2E",
      type: "LOCAL_MAIN",
    },
  });
  const deliveredAt = new Date();
  const shipment = await db.shipment.create({
    data: {
      orderId: order.id,
      originLocationId: location.id,
      kind: "DELIVERY",
      status: "DELIVERED",
      promisedAt: deliveredAt,
      deliveredAt,
    },
  });
  const reviewIds = [];
  for (const review of options.reviews) {
    const item = await db.orderItem.create({
      data: {
        orderId: order.id,
        variantId: variant.id,
        quantity: 1,
        titleSnapshot: variant.product.name,
        productSlugSnapshot: variant.product.slug,
        skuSnapshot: variant.sku,
        unitPriceCents: variant.priceCents,
        unitCostWacCents: variant.costCents,
        discountCents: 0n,
        lineTotalCents: variant.priceCents,
        taxCents: 0n,
      },
    });
    await db.shipmentItem.create({
      data: {
        shipmentId: shipment.id,
        orderItemId: item.id,
        quantity: 1,
        declaredValueCents: variant.priceCents,
      },
    });
    const created = await db.review.create({
      data: {
        orderItemId: item.id,
        productId: variant.productId,
        requesterCustomerId: options.customerId,
        moderatedByAdminUserId: options.moderatedByAdminUserId,
        idempotencyKey: `e2e-public-review-${randomUUID()}`,
        requestHash: randomBytes(32),
        rating: review.rating ?? 5,
        title: review.title,
        body:
          review.body ?? "Compra verificada para comprobar la privacidad de las reseñas públicas.",
        authorDisplayName: review.authorDisplayName,
        status: "PUBLISHED",
        moderatedAt: review.createdAt,
        createdAt: review.createdAt,
      },
    });
    reviewIds.push(created.id);
  }
  return { orderId: order.id, productSlug: options.productSlug, reviewIds };
}
