import AxeBuilder from "@axe-core/playwright";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { CmsService } from "../packages/cms/dist/index.js";
import { createTimeoutToken } from "../packages/core/dist/index.js";
import {
  AccountService,
  B2bService,
  CartService,
  CrmService,
  OrderService,
  PostSaleService,
  PricingService,
  createDatabaseClient,
  type CheckoutDefaults,
} from "../packages/db/dist/index.js";
import {
  createSupabaseFixtureSession,
  encodeSupabaseFixtureCookie,
} from "../scripts/lib/supabase-auth-fixture.mjs";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const runSuffix = randomUUID().slice(0, 8).toLowerCase();

const desktopViewport = { width: 1280, height: 720 } as const;
const mobileViewport = { width: 375, height: 667 } as const;

const checkoutDefaults: CheckoutDefaults = {
  taxRegime: "NO_RESPONSABLE_IVA",
  currency: "COP",
  timeZone: "America/Bogota",
  orderNumberPrefix: "MNT",
  orderNumberPadding: 4,
  uvtValueCents: 5_237_400n,
  uvtYear: 2026,
  standardShippingCents: 1_500_000n,
  deliveryPromiseDays: 3,
  reservationMinutes: 30,
  clickAndCollectEnabled: true,
};

let db: ReturnType<typeof createDatabaseClient>;
let superAdmin: { id: string; authUserId: string; email: string };
let storeManager: { id: string; authUserId: string; email: string };
let mfaPendingAdmin: { id: string; authUserId: string; email: string };
let customer: { id: string; authUserId: string; email: string };

let fixtureIds: {
  cmsPageId: string;
  cmsPageSlug: string;
  cmsMediaId: string;
  productId: string;
  productSlug: string;
  secondProductSlug: string;
  createdSecondProductId: string | null;
  variantId: string;
  variantSku: string;
  savedAddressId: string;
  couponId: string;
  assistedCartId: string;
  assistedToken: string;
  customerOrderId: string;
  receiptToken: string;
  contactId: string;
  opportunityId: string;
  proposalToken: string;
  paginationAuditAction: string;
};

async function authenticateAdmin(
  page: Page,
  profile: { authUserId: string; email: string },
  options: { aal?: "aal1" | "aal2"; hasVerifiedFactor?: boolean; mfaAgeSeconds?: number } = {},
) {
  const secret = process.env.SESSION_TIMEOUT_SECRET;
  if (!secret) throw new Error("SESSION_TIMEOUT_SECRET is required for E2E.");
  await page.context().clearCookies();
  const aal = options.aal ?? "aal2";
  const session = createSupabaseFixtureSession({
    subject: profile.authUserId,
    email: profile.email,
    factorId: randomUUID(),
    aal,
    hasVerifiedFactor: options.hasVerifiedFactor ?? true,
    mfaAgeSeconds: options.mfaAgeSeconds ?? 20,
  });
  const activity = createTimeoutToken({
    kind: "admin",
    subject: profile.authUserId,
    secret: Buffer.from(secret, "base64"),
    idleSeconds: 1800,
    absoluteSeconds: 43_200,
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.setCookie", {
    name: "__Host-admin_activity",
    value: activity,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    sourceScheme: "Secure",
  });
  await cdp.detach();
  await page.context().addCookies([
    {
      name: "sb-127-auth-token",
      value: encodeSupabaseFixtureCookie(session),
      url: "http://127.0.0.1:4110/",
      httpOnly: true,
      sameSite: "Strict",
    },
    {
      name: "admin_activity",
      value: activity,
      url: "http://127.0.0.1:4110/",
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
}

async function authenticateCustomer(page: Page, profile: { authUserId: string; email: string }) {
  const secret = process.env.SESSION_TIMEOUT_SECRET;
  if (!secret) throw new Error("SESSION_TIMEOUT_SECRET is required for E2E.");
  await page.context().clearCookies();
  const session = createSupabaseFixtureSession({
    subject: profile.authUserId,
    email: profile.email,
    factorId: randomUUID(),
    aal: "aal1",
    hasVerifiedFactor: false,
    mfaAgeSeconds: 20,
  });
  const activity = createTimeoutToken({
    kind: "customer",
    subject: profile.authUserId,
    secret: Buffer.from(secret, "base64"),
    idleSeconds: 2_592_000,
    absoluteSeconds: 2_592_000,
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.setCookie", {
    name: "__Host-customer_activity",
    value: activity,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    sourceScheme: "Secure",
  });
  await cdp.detach();
  await page.context().addCookies([
    {
      name: "sb-127-auth-token",
      value: encodeSupabaseFixtureCookie(session),
      url: "http://127.0.0.1:4110/",
      httpOnly: true,
      sameSite: "Strict",
    },
    {
      name: "customer_activity",
      value: activity,
      url: "http://127.0.0.1:4110/",
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
}

async function expectWcagAndNoOverflow(page: Page, label: string) {
  await expect(page.locator("h1").first(), `${label} h1`).toBeVisible();
  const report = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(report.violations, `${label} axe violations`).toEqual([]);

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    `${label} horizontal overflow (${overflow.scrollWidth} > ${overflow.clientWidth})`,
  ).toBeLessThanOrEqual(overflow.clientWidth);
}

test.beforeAll(async () => {
  db = createDatabaseClient({ databaseUrl, maxConnections: 6 });

  const createdSuper = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `a9-super-${runSuffix}@example.test`,
      displayName: "Superadmin A9",
      role: "SUPERADMIN",
      status: "ACTIVE",
    },
  });
  superAdmin = {
    id: createdSuper.id,
    authUserId: createdSuper.authUserId,
    email: createdSuper.email,
  };

  const createdManager = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `a9-manager-${runSuffix}@example.test`,
      displayName: "Gerencia Tienda A9",
      role: "STORE_MANAGER",
      status: "ACTIVE",
    },
  });
  storeManager = {
    id: createdManager.id,
    authUserId: createdManager.authUserId,
    email: createdManager.email,
  };

  const createdMfaAdmin = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `a9-mfa-${runSuffix}@example.test`,
      displayName: "Operador MFA A9",
      role: "CMS_EDITOR",
      status: "ACTIVE",
    },
  });
  mfaPendingAdmin = {
    id: createdMfaAdmin.id,
    authUserId: createdMfaAdmin.authUserId,
    email: createdMfaAdmin.email,
  };

  const createdCustomer = await db.customer.create({
    data: {
      authUserId: randomUUID(),
      email: `a9-cliente-${runSuffix}@example.test`,
      status: "ACTIVE",
      givenName: "Camila",
      familyName: "A9",
      phoneE164: "+573001112233",
    },
  });
  customer = {
    id: createdCustomer.id,
    authUserId: createdCustomer.authUserId!,
    email: createdCustomer.email,
  };

  await db.securityEvent.create({
    data: {
      adminUserId: superAdmin.id,
      eventType: "ADMIN_STEP_UP_VERIFIED",
      ipHash: randomBytes(32),
      metadata: { source: "a9-e2e" },
    },
  });

  const paginationAuditAction = `A9_PAGINATION_${runSuffix.toUpperCase()}`;
  await db.adminActionLog.createMany({
    data: Array.from({ length: 31 }, (_, index) => ({
      actorAdminUserId: superAdmin.id,
      action: paginationAuditAction,
      targetType: "a9_audit_probe",
      targetId: `a9-probe-${runSuffix}-${index + 1}`,
      requestId: randomUUID(),
      metadata: {
        probe: "a9-e2e-pagination",
        index: index + 1,
        summary:
          "Registro estructurado de auditoría para verificar región desplazable accesible por teclado.",
      },
      selfDealing: false,
    })),
  });

  const accountService = new AccountService(db, { privacyPolicyVersion: "2026.1" });
  const createdAddress = await accountService.createAddress(customer.id, {
    label: "Oficina Bogotá",
    recipientName: "Camila A9",
    phoneE164: "+573001112233",
    departmentCode: "11",
    municipalityCode: "11001",
    addressLine1: "Carrera 11 # 82-01",
    addressLine2: "Oficina 402",
    neighborhood: "Chicó",
    postalCode: "110221",
    deliveryNotes: "Recepción primer piso",
    isDefault: true,
  });
  await accountService.updateProfile(
    customer.id,
    {
      givenName: "Camila",
      familyName: "A9",
      phoneE164: "+573001112233",
      marketingEmail: false,
      advertising: false,
    },
    createdCustomer.updatedAt,
    { ipHash: randomBytes(32), userAgentHash: randomBytes(32) },
  );

  const variant = await db.productVariant.findFirstOrThrow({
    where: {
      status: "ACTIVE",
      deletedAt: null,
      product: { status: "ACTIVE", deletedAt: null, trackSerial: false },
    },
    include: { product: true },
  });

  const existingSecondProduct = await db.product.findFirst({
    where: {
      id: { not: variant.product.id },
      status: "ACTIVE",
      deletedAt: null,
      variants: { some: { status: "ACTIVE", deletedAt: null } },
    },
    select: { id: true, slug: true },
  });

  let secondProductSlug: string;
  let createdSecondProductId: string | null = null;
  if (existingSecondProduct) {
    secondProductSlug = existingSecondProduct.slug;
  } else {
    const createdSecond = await db.product.create({
      data: {
        slug: `a9-comparador-${runSuffix}`,
        name: `Equipo Comparador A9 ${runSuffix}`,
        brandId: variant.product.brandId,
        categoryId: variant.product.categoryId,
        taxGroupId: variant.product.taxGroupId,
        status: "ACTIVE",
        authenticity: "ORIGINAL",
        warrantyMonths: 12,
        trackSerial: false,
        variants: {
          create: {
            sku: `A9-CMP-${runSuffix.toUpperCase()}`,
            isDefault: true,
            status: "ACTIVE",
            priceCents: 39_000_000n,
            costCents: 26_000_000n,
            weightGrams: 250,
            lengthMillimeters: 120,
            widthMillimeters: 90,
            heightMillimeters: 45,
          },
        },
      },
      select: { id: true, slug: true },
    });
    secondProductSlug = createdSecond.slug;
    createdSecondProductId = createdSecond.id;
  }

  const cmsService = new CmsService(db, {
    "store.name": "MundoNetTech",
    "store.domain": "mundonettech.co",
  });
  const cmsSlug = `guia-editorial-a9-${runSuffix}`;
  const cmsAudit = { actorAdminUserId: superAdmin.id, requestId: randomUUID() };
  const createdCmsPage = await cmsService.createPage(
    {
      slug: cmsSlug,
      title: `Guía editorial A9 ${runSuffix}`,
      seoTitle: "Guía editorial de conectividad",
      seoDescription: "Recomendaciones prácticas para elegir equipos de red y productividad.",
    },
    [
      {
        type: "HERO",
        content: {
          heading: "Conectividad confiable para tu espacio",
          subheading:
            "Criterios prácticos para comparar routers, switches y estaciones de trabajo.",
          primaryCta: {
            label: "Explorar catálogo",
            href: "/productos",
          },
        },
        isVisible: true,
      },
      {
        type: "RICH_TEXT",
        content: {
          heading: "Criterios clave de selección",
          body: "Revisa puertos Ethernet reales, estándar Wi-Fi y garantía local antes de comprar.",
        },
        isVisible: true,
      },
    ],
    cmsAudit,
  );
  const cmsDetail = await cmsService.getPage(createdCmsPage.id);
  for (const block of cmsDetail?.blocks ?? []) {
    const versionId = block.versions[0]?.id;
    if (!versionId) throw new Error("Expected initial CMS block version.");
    await cmsService.publishVersion(versionId, cmsAudit);
  }

  const cmsMedia = await db.cmsMedia.create({
    data: {
      storageKey: `cms/a9-${runSuffix}/portada.webp`,
      contentHash: randomBytes(32),
      originalFilename: `portada-editorial-muy-larga-${runSuffix}-conectividad-colombia.webp`,
      mimeType: "image/webp",
      byteSize: 48_320,
      width: 1200,
      height: 800,
      altText: "Equipo de conectividad sobre escritorio",
      derivatives: [
        {
          key: `cms/a9-${runSuffix}/640.webp`,
          byteSize: 21000,
          contentType: "image/webp",
          width: 640,
          height: 427,
          format: "webp",
        },
      ],
      createdByAdminUserId: superAdmin.id,
    },
  });

  const pricingAudit = {
    actorAdminUserId: superAdmin.id,
    ipHash: Uint8Array.from(randomBytes(32)),
    userAgentHash: Uint8Array.from(randomBytes(32)),
    requestId: randomUUID(),
  };
  const pricingService = new PricingService(db);
  const coupon = await pricingService.upsertCoupon(
    null,
    {
      code: `A9CUPON${runSuffix.toUpperCase()}`,
      name: "Cupón de verificación A9",
      discountType: "PERCENTAGE",
      percentageBps: 500,
      status: "DRAFT",
    },
    pricingAudit,
  );

  const cartService = new CartService(db);
  const assistedCart = await cartService.createAssistedCart({
    accessTokenHash: Uint8Array.from(randomBytes(32)),
    expiresAt: new Date(Date.now() + 7_200_000),
    assistedByAdminUserId: superAdmin.id,
    audit: pricingAudit,
  });
  await cartService.addVariant({ cartId: assistedCart.id }, variant.id, 1, pricingAudit);
  const assistedToken = randomBytes(32).toString("base64url");
  await cartService.issueAssistedToken({
    cartId: assistedCart.id,
    assistedTokenHash: Uint8Array.from(createHash("sha256").update(assistedToken).digest()),
    expiresAt: new Date(Date.now() + 7_200_000),
    audit: pricingAudit,
  });

  const checkoutCartToken = randomBytes(32).toString("base64url");
  const checkoutAccessHash = Uint8Array.from(
    createHash("sha256").update(checkoutCartToken).digest(),
  );
  await cartService.createStorefrontCart({
    accessTokenHash: checkoutAccessHash,
    expiresAt: new Date(Date.now() + 7_200_000),
    customerId: customer.id,
  });
  await cartService.addVariant({ accessTokenHash: checkoutAccessHash }, variant.id, 1);

  const orderService = new OrderService(db, checkoutDefaults);
  const preview = await orderService.preview({
    accessTokenHash: checkoutAccessHash,
  });
  if (!preview) throw new Error("Expected active checkout preview.");
  const receiptToken = randomBytes(32).toString("base64url");
  const createdOrder = await orderService.checkout({
    cart: { accessTokenHash: checkoutAccessHash },
    expectedReviewFingerprint: preview.homeDelivery.reviewFingerprint,
    receiptAccessTokenHash: Uint8Array.from(createHash("sha256").update(receiptToken).digest()),
    idempotency: {
      keyHash: Uint8Array.from(randomBytes(32)),
      subjectHash: Uint8Array.from(randomBytes(32)),
      requestHash: Uint8Array.from(randomBytes(32)),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
    contact: {
      email: customer.email,
      givenName: "Camila",
      familyName: "A9",
      recipientName: "Camila A9",
      phoneE164: "+573001112233",
      buyerDocumentType: "13",
      buyerDocumentNumber: "1032456789",
      termsVersion: "2026.1",
      privacyPolicyVersion: "2026.1",
      advertisingAccepted: false,
      acceptanceProofHash: Uint8Array.from(randomBytes(32)),
      acceptanceIpHash: Uint8Array.from(randomBytes(32)),
      acceptanceUserAgentHash: Uint8Array.from(randomBytes(32)),
    },
    fulfillment: {
      method: "HOME_DELIVERY",
      departmentCode: "11",
      municipalityCode: "11001",
      addressLine1: "Carrera 11 # 82-01",
      addressLine2: "Oficina 402",
      neighborhood: "Chicó",
      postalCode: "110221",
      deliveryNotes: "Recepción primer piso",
    },
  });

  const postSaleService = new PostSaleService(db);
  await postSaleService.createSupportTicket(
    { kind: "CUSTOMER", customerId: customer.id },
    {
      kind: "QUERY",
      orderId: createdOrder.orderId,
      subject: "Consulta de entrega A9",
      message: "Quisiera confirmar el horario estimado de entrega en recepción empresarial.",
      idempotencyKey: `a9-ticket-${runSuffix}`,
    },
  );

  const crmAudit = {
    actorAdminUserId: superAdmin.id,
    ipHash: Uint8Array.from(randomBytes(32)),
    userAgentHash: Uint8Array.from(randomBytes(32)),
    requestId: randomUUID(),
  };
  const crmService = new CrmService(db);
  const crmContact = await crmService.createContact(
    {
      source: "admin-crm",
      givenName: "Contacto",
      familyName: "Empresarial A9",
      email: `a9-crm-${runSuffix}@example.test`,
      phoneE164: "+573109998877",
    },
    crmAudit,
  );

  const b2bService = new B2bService(db, checkoutDefaults);
  const captured = await b2bService.captureOpportunity({
    legalName: `Inversiones A9 ${runSuffix.toUpperCase()} SAS`,
    taxId: `90199${Math.floor(1000 + Math.random() * 8999)}-1`,
    givenName: "Dirección",
    familyName: "Compras A9",
    email: `a9-b2b-${runSuffix}@example.test`,
    phoneE164: "+573154445566",
    requirements: "Requerimos cotización formal de equipos de red y accesorios.",
    privacyPolicyVersion: "2026.1",
    acceptanceProofHash: Uint8Array.from(randomBytes(32)),
    acceptanceIpHash: Uint8Array.from(randomBytes(32)),
    acceptanceUserAgentHash: Uint8Array.from(randomBytes(32)),
    idempotency: {
      keyHash: Uint8Array.from(randomBytes(32)),
      subjectHash: Uint8Array.from(randomBytes(32)),
      requestHash: Uint8Array.from(randomBytes(32)),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  const opportunityBeforeProposal = await b2bService.getOpportunity(captured.opportunityId);
  const draftProposal = await b2bService.createProposal({
    opportunityId: captured.opportunityId,
    expectedVersion: opportunityBeforeProposal.version,
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
    commercialNotes: "Propuesta corporativa de verificación A9.",
    items: [{ sku: variant.sku, quantity: 2 }],
    audit: crmAudit,
  });
  const opportunityAfterDraft = await b2bService.getOpportunity(captured.opportunityId);
  const issuedProposal = await b2bService.issueProposal(
    draftProposal.id,
    opportunityAfterDraft.version,
    crmAudit,
  );

  fixtureIds = {
    cmsPageId: createdCmsPage.id,
    cmsPageSlug: cmsSlug,
    cmsMediaId: cmsMedia.id,
    productId: variant.product.id,
    productSlug: variant.product.slug,
    secondProductSlug,
    createdSecondProductId,
    variantId: variant.id,
    variantSku: variant.sku,
    savedAddressId: createdAddress.id,
    couponId: coupon.id,
    assistedCartId: assistedCart.id,
    assistedToken,
    customerOrderId: createdOrder.orderId,
    receiptToken,
    contactId: crmContact.id,
    opportunityId: captured.opportunityId,
    proposalToken: issuedProposal.token,
    paginationAuditAction,
  };
});

test.afterAll(async () => {
  if (!db) return;
  try {
    if (fixtureIds) {
      await db.cmsPage.updateMany({
        where: { id: fixtureIds.cmsPageId },
        data: { status: "ARCHIVED", deletedAt: new Date() },
      });
      await db.coupon.deleteMany({
        where: { id: fixtureIds.couponId },
      });
      await db.cartItem.deleteMany({
        where: { cartId: fixtureIds.assistedCartId },
      });
      await db.cart.deleteMany({
        where: { id: fixtureIds.assistedCartId },
      });
      if (customer) {
        const activeCustomerCarts = await db.cart.findMany({
          where: { customerId: customer.id, status: "ACTIVE" },
          select: { id: true },
        });
        if (activeCustomerCarts.length > 0) {
          const cartIds = activeCustomerCarts.map((entry) => entry.id);
          await db.cartItem.deleteMany({ where: { cartId: { in: cartIds } } });
          await db.cart.deleteMany({ where: { id: { in: cartIds } } });
        }
        await db.address.deleteMany({
          where: { customerId: customer.id },
        });
      }
      if (fixtureIds.createdSecondProductId) {
        await db.productVariant.deleteMany({
          where: { productId: fixtureIds.createdSecondProductId },
        });
        await db.product.deleteMany({
          where: { id: fixtureIds.createdSecondProductId },
        });
      }
    }
  } finally {
    await db.$disconnect();
  }
});

test("all 29 customer routes pass WCAG 2.1 AA axe, navigation completeness and zero overflow on desktop and mobile", async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);

  const adminContext = await browser.newContext({ viewport: desktopViewport });
  const adminPage = await adminContext.newPage();
  await authenticateAdmin(adminPage, superAdmin);
  await adminPage.goto(`/admin/contenido/${fixtureIds.cmsPageId}`, {
    waitUntil: "domcontentloaded",
  });
  await adminPage.getByRole("button", { name: "Publicar página" }).click();
  await expect(
    adminPage.getByText(new RegExp(`/pagina/${fixtureIds.cmsPageSlug} · Publicada ·`)),
  ).toBeVisible();
  await adminContext.close();

  const compareTwoRoute = `/comparar?productos=${encodeURIComponent(
    `${fixtureIds.productSlug},${fixtureIds.secondProductSlug}`,
  )}`;
  const publicCustomerRoutes = [
    "/",
    "/productos",
    "/categoria/audio",
    "/marca/sony",
    `/producto/${fixtureIds.productSlug}`,
    "/comparar",
    compareTwoRoute,
    `/pagina/${fixtureIds.cmsPageSlug}`,
    "/ayuda",
    "/ayuda/retracto-cambios-y-devoluciones",
    "/legal",
    "/legal/cookies",
    "/empresas",
    "/carrito",
    "/checkout",
    `/pagar/${fixtureIds.assistedToken}`,
    `/propuesta/${fixtureIds.proposalToken}`,
    `/recibo/${fixtureIds.receiptToken}`,
    `/pedido/${fixtureIds.receiptToken}`,
    "/ingresar",
    "/registro?next=%2Fmi-cuenta%2Fpedidos",
    "/recuperar",
    "/recuperar?code=1",
    "/verificar-correo",
  ] as const;

  const nonCheckoutGeolocationRoutes = new Set(["/", "/productos", "/carrito"]);

  await page.setViewportSize(desktopViewport);
  for (const route of publicCustomerRoutes) {
    const response = await page.goto(route, { waitUntil: "domcontentloaded" });
    expect(response?.status(), `Desktop status for ${route}`).toBe(200);

    if (nonCheckoutGeolocationRoutes.has(route)) {
      const permissionsPolicy = response?.headers()["permissions-policy"] ?? "";
      expect(permissionsPolicy, `Permissions-Policy on ${route}`).toContain("geolocation=()");
      expect(permissionsPolicy, `Permissions-Policy on ${route}`).not.toContain(
        "geolocation=(self)",
      );
    }

    if (route === "/") {
      await expect(
        page.getByRole("navigation", { name: "Navegación principal" }).getByRole("link", {
          name: "Empresas",
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "Navegación principal" }).getByRole("link", {
          name: "Mi cuenta",
        }),
      ).toBeVisible();
      await expect(
        page.locator(`a[href="/pagina/${fixtureIds.cmsPageSlug}"]`).first(),
      ).toBeVisible();

      await page.keyboard.press("Tab");
      const skipLink = page.getByRole("link", { name: "Saltar al contenido principal" });
      await expect(skipLink).toBeFocused();
      await expect(skipLink).toBeVisible();
    }
    if (route === compareTwoRoute) {
      const comparisonTable = page.locator('section[tabindex="0"] table');
      await expect(comparisonTable).toBeVisible();
      await expect(comparisonTable.locator("caption")).toHaveText("Comparación de 2 productos");
    }
    if (route === "/marca/sony") {
      await expect(page.getByRole("navigation", { name: "Migas de pan" })).toBeVisible();
    }
    if (route === "/legal/cookies") {
      await expect(
        page.getByText(/Ni rechazar una cookie no esencial ni negar la autorización/),
      ).toBeVisible();
    }
    if (route === `/pedido/${fixtureIds.receiptToken}`) {
      await expect(page.getByRole("navigation", { name: "Navegación principal" })).toBeVisible();
    }

    await expectWcagAndNoOverflow(page, `Desktop customer ${route}`);
  }

  const notFoundRoutes = [
    "/email/baja/enlace-invalido",
    "/referido/INVALID00000",
    "/ruta-cliente-inexistente-a9",
    "/ayuda/no-existe-a9",
    "/checkout/inexistente",
  ] as const;

  for (const invalidRoute of notFoundRoutes) {
    const response = await page.goto(invalidRoute, { waitUntil: "domcontentloaded" });
    expect(response?.status(), `Desktop 404 status for ${invalidRoute}`).toBe(404);
    if (invalidRoute === "/checkout/inexistente") {
      expect(response?.headers()["permissions-policy"]).toContain("geolocation=()");
    }
    await expectWcagAndNoOverflow(page, `Desktop 404 ${invalidRoute}`);
  }

  await page.goto("/pagina/no-existe-a9", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "No encontramos esta página", level: 1 }),
  ).toBeVisible();
  await expectWcagAndNoOverflow(page, "Desktop streamed 404 /pagina/no-existe-a9");

  await page.setViewportSize(mobileViewport);
  for (const route of publicCustomerRoutes) {
    const response = await page.goto(route, { waitUntil: "domcontentloaded" });
    expect(response?.status(), `Mobile status for ${route}`).toBe(200);
    if (route === compareTwoRoute) {
      await expect(page.locator('section[tabindex="0"] table')).toBeVisible();
    }
    await expectWcagAndNoOverflow(page, `Mobile customer ${route}`);
  }

  for (const mobileNotFoundRoute of ["/ayuda/no-existe-a9", "/checkout/inexistente"] as const) {
    const response = await page.goto(mobileNotFoundRoute, { waitUntil: "domcontentloaded" });
    expect(response?.status(), `Mobile 404 status for ${mobileNotFoundRoute}`).toBe(404);
    await expectWcagAndNoOverflow(page, `Mobile 404 ${mobileNotFoundRoute}`);
  }
  await page.goto("/pagina/no-existe-a9", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "No encontramos esta página", level: 1 }),
  ).toBeVisible();
  await expectWcagAndNoOverflow(page, "Mobile streamed 404 /pagina/no-existe-a9");

  await authenticateCustomer(page, customer);
  const accountRoutes = [
    "/mi-cuenta",
    "/mi-cuenta/direcciones",
    "/mi-cuenta/pedidos",
    `/mi-cuenta/pedidos/${fixtureIds.customerOrderId}`,
    "/mi-cuenta/beneficios",
    "/mi-cuenta/soporte",
    "/mi-cuenta/privacidad",
  ] as const;

  for (const viewport of [desktopViewport, mobileViewport]) {
    await page.setViewportSize(viewport);
    const mode = viewport.width === 375 ? "Mobile" : "Desktop";
    for (const route of accountRoutes) {
      const response = await page.goto(route, { waitUntil: "domcontentloaded" });
      expect(response?.status(), `${mode} status for ${route}`).toBe(200);
      await expect(page.getByRole("navigation", { name: "Navegación principal" })).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "Mi cuenta" }).locator('[aria-current="page"]'),
      ).toHaveCount(1);
      if (route === "/mi-cuenta/privacidad") {
        await expect(page.locator("body")).not.toContainText("customer-account");
        await expect(page.locator("body")).not.toContainText("append-only");
      }
      await expectWcagAndNoOverflow(page, `${mode} account ${route}`);
    }
  }

  await page.setViewportSize(desktopViewport);
  await page.goto(`/producto/${fixtureIds.productSlug}`);
  await page.getByRole("button", { name: "Añadir al carrito" }).click();
  await expect(page.getByRole("link", { name: "Ver carrito" })).toBeVisible();

  const cartResponse = await page.goto("/carrito", { waitUntil: "domcontentloaded" });
  expect(cartResponse?.headers()["permissions-policy"]).toContain("geolocation=()");
  await expectWcagAndNoOverflow(page, "Desktop populated /carrito");

  const [checkoutDocumentResponse] = await Promise.all([
    page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === "/checkout" && res.request().resourceType() === "document",
    ),
    page.getByRole("link", { name: "Finalizar compra" }).click(),
  ]);
  expect(checkoutDocumentResponse.status()).toBe(200);
  expect(checkoutDocumentResponse.headers()["permissions-policy"]).toContain("geolocation=(self)");

  const savedAddressSelector = page.locator("#saved-address-selector");
  await expect(savedAddressSelector).toBeVisible();
  await savedAddressSelector.selectOption("");
  await expect(page.locator("#checkout-address")).toHaveValue("");
  await expect(page.locator("#checkout-neighborhood")).toHaveValue("");

  await savedAddressSelector.selectOption(fixtureIds.savedAddressId);
  await expect(page.locator("#checkout-recipient")).toHaveValue("Camila A9");
  await expect(page.locator("#checkout-department")).toHaveValue("11");
  await expect(page.locator("#checkout-municipality")).toHaveValue("11001");
  await expect(page.locator("#checkout-address")).toHaveValue("Carrera 11 # 82-01");
  await expect(page.locator("#checkout-neighborhood")).toHaveValue("Chicó");
  await expectWcagAndNoOverflow(page, "Desktop /checkout Step 1");

  await page.locator("#checkout-document-number").fill("1032456789");
  await page.getByRole("button", { name: /Continuar al paso 2/i }).click();
  await expectWcagAndNoOverflow(page, "Desktop /checkout Step 2");

  await page.getByRole("button", { name: /Continuar al paso 3/i }).click();
  await expectWcagAndNoOverflow(page, "Desktop /checkout Step 3");

  await page.setViewportSize(mobileViewport);
  await expectWcagAndNoOverflow(page, "Mobile /checkout Step 3");
});

test("all 43 admin routes pass WCAG 2.1 AA axe, RBAC/PII/filter contracts and zero overflow on desktop and mobile", async ({
  page,
}) => {
  test.setTimeout(240_000);

  await page.setViewportSize(desktopViewport);
  for (const unauthRoute of ["/admin/login", "/admin/invitacion"]) {
    const response = await page.goto(unauthRoute, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await expectWcagAndNoOverflow(page, `Desktop ${unauthRoute}`);
  }

  await authenticateAdmin(page, mfaPendingAdmin, { aal: "aal1", hasVerifiedFactor: false });
  const enrollResponse = await page.goto("/admin/login/mfa", { waitUntil: "domcontentloaded" });
  expect(enrollResponse?.status()).toBe(200);
  await expect(page.getByRole("button", { name: "Cerrar sesión" })).toBeVisible();
  await expectWcagAndNoOverflow(page, "Desktop /admin/login/mfa enrollment");

  await page.setViewportSize(mobileViewport);
  await expectWcagAndNoOverflow(page, "Mobile /admin/login/mfa enrollment");
  await page.context().clearCookies();
  for (const unauthRoute of ["/admin/login", "/admin/invitacion"]) {
    await page.goto(unauthRoute, { waitUntil: "domcontentloaded" });
    await expectWcagAndNoOverflow(page, `Mobile ${unauthRoute}`);
  }

  await page.setViewportSize(desktopViewport);
  await authenticateAdmin(page, mfaPendingAdmin, { aal: "aal1", hasVerifiedFactor: true });
  await page.goto("/admin/login/mfa", { waitUntil: "domcontentloaded" });
  await expectWcagAndNoOverflow(page, "Desktop /admin/login/mfa challenge");

  await page.setViewportSize(mobileViewport);
  await expectWcagAndNoOverflow(page, "Mobile /admin/login/mfa challenge");

  await page.setViewportSize(desktopViewport);
  await authenticateAdmin(page, storeManager);
  await page.goto(`/admin/b2b/${fixtureIds.opportunityId}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator('a[href="/admin/integraciones"]')).toHaveCount(0);
  await expectWcagAndNoOverflow(page, "Desktop STORE_MANAGER /admin/b2b/[id]");

  await authenticateAdmin(page, superAdmin);
  const protectedAdminRoutes = [
    "/admin",
    "/admin/hoy",
    "/admin/dashboard",
    "/admin/pedidos",
    `/admin/pedidos/${fixtureIds.customerOrderId}`,
    "/admin/posventa",
    "/admin/resenas",
    "/admin/crm",
    `/admin/crm/${fixtureIds.contactId}`,
    "/admin/fidelizacion",
    "/admin/segmentos",
    "/admin/lifecycle",
    "/admin/analitica-rfm",
    "/admin/b2b",
    `/admin/b2b/${fixtureIds.opportunityId}`,
    "/admin/finanzas",
    "/admin/catalogo",
    "/admin/catalogo/nuevo",
    `/admin/catalogo/${fixtureIds.productId}`,
    "/admin/precios",
    "/admin/precios/nuevo?tipo=cupones",
    `/admin/precios/cupones/${fixtureIds.couponId}`,
    "/admin/venta-asistida",
    `/admin/venta-asistida/${fixtureIds.assistedCartId}`,
    "/admin/integraciones",
    "/admin/canales",
    "/admin/pagos",
    "/admin/logistica",
    "/admin/comunicaciones",
    "/admin/facturacion",
    "/admin/contenido",
    "/admin/contenido/nuevo",
    `/admin/contenido/${fixtureIds.cmsPageId}`,
    "/admin/contenido/medios",
    "/admin/contenido/redirecciones",
    "/admin/configuracion",
    "/admin/usuarios",
    "/admin/seguridad",
    "/admin/auditoria",
    "/admin/salud",
  ] as const;

  expect(protectedAdminRoutes).toHaveLength(40);

  await page.setViewportSize(desktopViewport);
  for (const route of protectedAdminRoutes) {
    const response = await page.goto(route, { waitUntil: "domcontentloaded" });
    expect(response?.status(), `Desktop status for ${route}`).toBe(200);
    await expect(
      page
        .getByRole("navigation", { name: "Navegación administrativa" })
        .locator('[aria-current="page"]'),
      `Active nav item on ${route}`,
    ).toHaveCount(1);

    if (route === "/admin/contenido/medios") {
      await expect(page.locator("body")).not.toContainText(superAdmin.email);
    }
    if (route === "/admin/seguridad") {
      await expect(page.getByText("Identidad confirmada (step-up MFA)").first()).toBeVisible();
      await expect(page.locator("body")).not.toContainText("ADMIN_STEP_UP_VERIFIED");
    }

    await expectWcagAndNoOverflow(page, `Desktop admin ${route}`);
  }

  await page.goto(
    `/admin/auditoria?action=${encodeURIComponent(fixtureIds.paginationAuditAction)}`,
    { waitUntil: "domcontentloaded" },
  );
  await expect(page.getByText("Página 1 de 2 · 31 registros")).toBeVisible();
  await page.locator("details summary").first().click();
  await expect(page.locator('details[open] pre[tabindex="0"]').first()).toBeVisible();
  await expectWcagAndNoOverflow(page, "Desktop /admin/auditoria expanded details");

  await page
    .getByRole("navigation", { name: "Paginación de auditoría" })
    .getByRole("link", { name: "Siguiente" })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/admin/auditoria\\?.*action=${fixtureIds.paginationAuditAction}.*page=2`),
  );
  await expect(page.getByText("Página 2 de 2 · 31 registros")).toBeVisible();
  await expectWcagAndNoOverflow(page, "Desktop /admin/auditoria page 2");

  await page
    .getByRole("navigation", { name: "Paginación de auditoría" })
    .getByRole("link", { name: "Anterior" })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/admin/auditoria\\?.*action=${fixtureIds.paginationAuditAction}.*page=1`),
  );
  await expect(page.getByText("Página 1 de 2 · 31 registros")).toBeVisible();

  await page.goto("/admin/auditoria?from=2026-02-31&action=cms_page_published", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expectWcagAndNoOverflow(page, "Desktop /admin/auditoria invalid calendar alert");

  const missingCrmRoute = `/admin/crm/${randomUUID()}`;
  await page.goto(missingCrmRoute, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "No encontramos esta página" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Volver al resumen administrativo" })).toBeVisible();
  await expectWcagAndNoOverflow(page, "Desktop /admin/(protected) 404");

  await page.setViewportSize(mobileViewport);
  await page.goto(missingCrmRoute, { waitUntil: "domcontentloaded" });
  await expectWcagAndNoOverflow(page, "Mobile /admin/(protected) 404");

  for (const route of protectedAdminRoutes) {
    const response = await page.goto(route, { waitUntil: "domcontentloaded" });
    expect(response?.status(), `Mobile status for ${route}`).toBe(200);
    if (route === "/admin") {
      const menuButton = page.getByRole("button", { name: "Menú de secciones" });
      await expect(menuButton).toHaveAttribute("aria-expanded", "false");
      await menuButton.click();
      const closeMenuButton = page.getByRole("button", { name: "Cerrar menú" });
      await expect(closeMenuButton).toHaveAttribute("aria-expanded", "true");
      await expectWcagAndNoOverflow(page, "Mobile /admin expanded menu");

      await page.keyboard.press("Escape");
      await expect(menuButton).toHaveAttribute("aria-expanded", "false");
      await expect(menuButton).toBeFocused();

      await menuButton.click();
      await expect(closeMenuButton).toHaveAttribute("aria-expanded", "true");
      await page.locator("#admin-mobile-menu").getByRole("link", { name: "Hoy" }).click();
      await expect(page).toHaveURL(/\/admin\/hoy$/);
      await expect(page.getByRole("button", { name: "Menú de secciones" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    } else {
      await expectWcagAndNoOverflow(page, `Mobile admin ${route}`);
    }
  }
});
