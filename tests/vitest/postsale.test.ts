import { describe, expect, it } from "vitest";

import {
  addColombianCalendarMonths,
  calculateBusinessDayDeadlineAt,
  endOfColombianDate,
} from "../../packages/legal-co/dist/index.js";
import {
  adminNavigation,
  buildProductJsonLd,
  hasAdminPermission,
} from "../../packages/core/dist/index.js";
import { PostSaleService } from "../../packages/db/dist/index.js";
import {
  defaultEmailTemplate,
  renderEmailTemplate,
  ResendEmailProvider,
} from "../../packages/integrations/dist/index.js";

const product = {
  name: "Producto verificado",
  description: "Producto con reseñas reales.",
  url: "https://example.co/producto/verificado",
  brandName: "Marca",
  categoryName: "Audio",
  imageUrls: [],
  breadcrumbs: [{ name: "Producto", url: "https://example.co/producto/verificado" }],
  offers: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      url: "https://example.co/producto/verificado",
      sku: "SKU-1",
      priceCents: "100000",
      available: true,
    },
  ],
};

describe("F4A.2 — Colombian post-sale deadlines", () => {
  it("keeps business-day SLAs inclusive in America/Bogota across holidays", () => {
    expect(calculateBusinessDayDeadlineAt("2026-12-24T15:00:00Z", 1).toISOString()).toBe(
      "2026-12-29T04:59:59.999Z",
    );
    expect(endOfColombianDate("2026-01-01").toISOString()).toBe("2026-01-02T04:59:59.999Z");
  });

  it("adds warranty calendar months with leap-year and month-end clamping", () => {
    expect(addColombianCalendarMonths("2026-01-31T15:00:00Z", 1).toISOString()).toBe(
      "2026-03-01T04:59:59.999Z",
    );
    expect(addColombianCalendarMonths("2024-02-29T15:00:00Z", 12).toISOString()).toBe(
      "2025-03-01T04:59:59.999Z",
    );
    expect(() => addColombianCalendarMonths("2026-01-01", -1)).toThrow(RangeError);
  });
});

describe("F4A.2 — RBAC and real review projections", () => {
  it("separates post-sale read/write and review moderation permissions", () => {
    expect(hasAdminPermission("CUSTOMER_SUPPORT", "postsale:write")).toBe(true);
    expect(hasAdminPermission("CUSTOMER_SUPPORT", "reviews:write")).toBe(true);
    expect(hasAdminPermission("FULFILLMENT", "postsale:write")).toBe(false);
    expect(hasAdminPermission("FULFILLMENT", "postsale:read")).toBe(true);
    expect(hasAdminPermission("CMS_EDITOR", "reviews:write")).toBe(true);
    expect(hasAdminPermission("CMS_EDITOR", "postsale:read")).toBe(false);
    expect(adminNavigation("CUSTOMER_SUPPORT").map((item) => item.href)).toEqual(
      expect.arrayContaining(["/admin/posventa", "/admin/resenas"]),
    );
  });

  it("emits aggregateRating only for bounded real moderated summaries", () => {
    const data = buildProductJsonLd({
      ...product,
      reviewSummary: { count: 3, averageRating: 4.67 },
    });
    expect(data[0]).toMatchObject({
      aggregateRating: {
        ratingValue: "4.67",
        reviewCount: 3,
        bestRating: 5,
        worstRating: 1,
      },
    });
    expect(JSON.stringify(buildProductJsonLd(product))).not.toContain("aggregateRating");
    for (const invalid of [0, 0.9, 5.1, Number.NaN]) {
      expect(() =>
        buildProductJsonLd({ ...product, reviewSummary: { count: 1, averageRating: invalid } }),
      ).toThrow(TypeError);
    }
  });

  it("renders complete post-sale email templates with escaped values", () => {
    for (const key of ["postsale.updated", "support.ticket"]) {
      const template = defaultEmailTemplate(key);
      expect(template.variables).toContain("unsubscribeUrl");
      const values = Object.fromEntries(
        template.variables.map((name) => [
          name,
          name.endsWith("Url") ? "https://example.co/caso" : `Valor ${name}`,
        ]),
      );
      const rendered = renderEmailTemplate(template, values);
      expect(rendered.subject.length).toBeGreaterThan(5);
      expect(rendered.htmlBody).toContain("https://example.co/caso");
    }
  });
});

describe("F4A.2 — security OTP email transport", () => {
  it("omits List-Unsubscribe for security emails and preserves idempotency", async () => {
    const previous = process.env.EMAIL_SEND_DISABLED;
    let body = "";
    let idempotency = "";
    try {
      process.env.EMAIL_SEND_DISABLED = "0";
      const provider = new ResendEmailProvider(
        {
          apiKey: "re_test_credential_with_enough_length",
          fromEmail: "seguridad@example.co",
          fromName: "Tienda",
          replyTo: null,
          svixSecret: "whsec_test_secret_with_enough_length",
          unsubscribeSecret: Buffer.from("a-secure-secret-with-32-bytes!!").toString("base64"),
          apiUrl: "https://api.resend.com/emails",
        },
        {
          fetchImpl: async (_input, init) => {
            body = String(init?.body ?? "");
            idempotency = String((init?.headers as Record<string, string>)["idempotency-key"]);
            return new Response(JSON.stringify({ id: "msg_guest_otp" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        },
      );
      await provider.send({
        idempotencyKey: "guest-order-access:challenge-1",
        to: "buyer@example.co",
        subject: "Código de acceso",
        html: "<p>123456</p>",
        text: "123456",
      });
      expect(idempotency).toBe("guest-order-access:challenge-1");
      expect(body).not.toContain("List-Unsubscribe");
      expect(body).toContain("123456");
    } finally {
      if (previous === undefined) delete process.env.EMAIL_SEND_DISABLED;
      else process.env.EMAIL_SEND_DISABLED = previous;
    }
  });
});

describe("A6 — delivered-only public review queries", () => {
  it("applies the delivered ShipmentItem predicate to cursors, pages and aggregates", async () => {
    const calls: Record<string, unknown>[] = [];
    const createdAt = new Date("2026-11-20T15:00:00.000Z");
    const review = {
      id: "00000000-0000-4000-8000-000000000001",
      rating: 5,
      title: "Compra entregada",
      body: "Contenido moderado de una compra efectivamente entregada.",
      authorDisplayName: "Cliente",
      createdAt,
    };
    const record = async <T>(query: Record<string, unknown>, result: T): Promise<T> => {
      calls.push(query);
      return result;
    };
    const service = new PostSaleService({
      product: {
        findFirst: (query: Record<string, unknown>) => record(query, { id: "product-1" }),
      },
      review: {
        findFirst: (query: Record<string, unknown>) => record(query, review),
        findMany: (query: Record<string, unknown>) => record(query, [review]),
        aggregate: (query: Record<string, unknown>) =>
          record(query, { _count: { _all: 1 }, _avg: { rating: 5 } }),
      },
    } as never);

    const result = await service.publicReviews("producto-verificado", {
      cursor: review.id,
      limit: 1,
    });

    expect(result).toMatchObject({ count: 1, averageRating: 5, nextCursor: null });
    expect(calls).toHaveLength(4);
    for (const call of calls.slice(1)) {
      expect(call.where).toMatchObject({
        status: "PUBLISHED",
        orderItem: {
          shipmentItems: {
            some: { shipment: { status: "DELIVERED", deliveredAt: { not: null } } },
          },
        },
      });
    }
  });
});

describe("A6 — serialized return validation", () => {
  it("rejects the same SerializedUnit in different delivery items before opening a transaction", async () => {
    const service = new PostSaleService({} as never);
    const serializedUnitId = "00000000-0000-4000-8000-000000000010";
    await expect(
      service.requestReturn(
        { kind: "CUSTOMER", customerId: "00000000-0000-4000-8000-000000000001" },
        {
          orderId: "00000000-0000-4000-8000-000000000002",
          kind: "REFUND",
          reason: "Solicitud con una unidad serial duplicada entre entregas.",
          idempotencyKey: "duplicate-serial-across-items",
          items: [
            {
              shipmentItemId: "00000000-0000-4000-8000-000000000003",
              quantity: 1,
              serializedUnitIds: [serializedUnitId],
            },
            {
              shipmentItemId: "00000000-0000-4000-8000-000000000004",
              quantity: 1,
              serializedUnitIds: [serializedUnitId],
            },
          ],
        },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
